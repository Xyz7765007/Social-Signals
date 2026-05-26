/**
 * Reddit source.
 *
 * Uses OAuth 2.0 client_credentials (app-only) flow. Free tier: 100 req/min.
 * Reddit returns up to 100 posts per query; for breadth we fan out across
 * (keyword × subreddit) combinations and dedupe by post ID.
 *
 * Endpoints used:
 *   POST  https://www.reddit.com/api/v1/access_token   (auth)
 *   GET   https://oauth.reddit.com/r/{sub}/search.json  (subreddit-scoped)
 *   GET   https://oauth.reddit.com/search.json          (global, when no subs)
 *
 * Reddit time filter values: hour | day | week | month | year | all.
 */

import type { RawPost, Source, TimeWindow } from "../types";

const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const API_BASE = "https://oauth.reddit.com";

interface TokenCache {
  token: string;
  expiresAt: number;
}

const g = globalThis as any;
function getCache(): TokenCache | null {
  return g.__redditToken ?? null;
}
function setCache(c: TokenCache) {
  g.__redditToken = c;
}

async function getToken(): Promise<string> {
  const cached = getCache();
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const id = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error(
      "Reddit credentials missing. Set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET in .env.local."
    );
  }

  const basic = Buffer.from(`${id}:${secret}`).toString("base64");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": process.env.REDDIT_USER_AGENT ?? "Pulse/1.0",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Reddit token request failed: ${res.status} ${text.slice(0, 200)}`);
  }

  const json: any = await res.json();
  const token = json.access_token as string;
  const expiresIn = (json.expires_in as number) ?? 3600;
  setCache({ token, expiresAt: Date.now() + expiresIn * 1000 });
  return token;
}

interface RedditChild {
  data: {
    id: string;
    name: string;
    permalink: string;
    url: string;
    title: string;
    selftext?: string;
    author: string;
    subreddit: string;
    subreddit_name_prefixed: string;
    created_utc: number;
    score: number;
    num_comments: number;
    upvote_ratio?: number;
    is_self?: boolean;
    over_18?: boolean;
    link_flair_text?: string | null;
  };
}

async function searchOne(opts: {
  token: string;
  q: string;
  subreddit?: string;
  time: TimeWindow;
  limit: number;
}): Promise<RawPost[]> {
  const { token, q, subreddit, time, limit } = opts;
  const params = new URLSearchParams({
    q,
    sort: "new",
    t: time === "hour" ? "hour" : time === "day" ? "day" : time === "week" ? "week" : "month",
    limit: String(Math.min(limit, 100)),
    raw_json: "1",
  });
  if (subreddit) params.set("restrict_sr", "true");

  const url = subreddit
    ? `${API_BASE}/r/${subreddit}/search?${params}`
    : `${API_BASE}/search?${params}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": process.env.REDDIT_USER_AGENT ?? "Pulse/1.0",
    },
  });

  if (!res.ok) {
    // Swallow per-query errors so a single bad sub doesn't kill the whole scan.
    if (process.env.NODE_ENV !== "production") {
      console.warn(`Reddit search failed [${subreddit ?? "all"} / ${q}]: ${res.status}`);
    }
    return [];
  }

  const data: any = await res.json();
  const children: RedditChild[] = data?.data?.children ?? [];

  return children
    .filter((c) => !c.data.over_18)
    .map((c): RawPost => {
      const d = c.data;
      const content = (d.selftext ?? "").trim();
      return {
        sourceId: "reddit",
        externalId: d.name, // e.g. t3_abc123 — unique
        url: `https://www.reddit.com${d.permalink}`,
        permalink: d.permalink,
        author: d.author,
        authorUrl: d.author && d.author !== "[deleted]" ? `https://www.reddit.com/user/${d.author}` : undefined,
        title: d.title,
        content,
        createdAt: new Date(d.created_utc * 1000).toISOString(),
        metadata: {
          subreddit: d.subreddit,
          subredditPrefixed: d.subreddit_name_prefixed,
          upvotes: d.score,
          comments: d.num_comments,
          upvoteRatio: d.upvote_ratio,
          flair: d.link_flair_text ?? null,
          isSelf: d.is_self,
          matchedQuery: q,
        },
      };
    });
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export const redditSource: Source = {
  id: "reddit",
  name: "Reddit",
  available: Boolean(process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET),

  async fetch({ keywords, subreddits, timeWindow, limit }) {
    if (keywords.length === 0) return [];
    const token = await getToken();

    // Fan-out plan: each keyword × each subreddit. If no subs, run global search per keyword.
    // Per-query limit scaled so we don't blow past `limit` after dedupe — we'll over-fetch
    // by ~2x then dedupe and sort.
    const subList = subreddits && subreddits.length > 0 ? subreddits : [undefined];
    const perQuery = Math.min(100, Math.ceil((limit * 2) / Math.max(1, subList.length)));

    const tasks: Array<() => Promise<RawPost[]>> = [];
    for (const q of keywords) {
      for (const sub of subList) {
        tasks.push(() => searchOne({ token, q, subreddit: sub, time: timeWindow, limit: perQuery }));
      }
    }

    // Reddit free tier = 100 req/min. Keep concurrency at 6 to stay well under.
    const results: RawPost[] = [];
    for (const batch of chunk(tasks, 6)) {
      const res = await Promise.all(batch.map((t) => t().catch(() => [])));
      for (const r of res) results.push(...r);
    }

    // Dedupe by externalId; keep first occurrence (highest matched query order).
    const seen = new Set<string>();
    const deduped: RawPost[] = [];
    for (const p of results) {
      if (seen.has(p.externalId)) continue;
      seen.add(p.externalId);
      deduped.push(p);
    }

    // Sort by recency, then upvotes as tiebreaker.
    deduped.sort((a, b) => {
      const t = b.createdAt.localeCompare(a.createdAt);
      if (t !== 0) return t;
      return (b.metadata.upvotes ?? 0) - (a.metadata.upvotes ?? 0);
    });

    // Cap to 3× requested (scoring will narrow further). Gives Claude breadth.
    return deduped.slice(0, Math.max(limit * 3, 30));
  },
};
