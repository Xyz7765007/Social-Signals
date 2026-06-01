/**
 * Reddit source — OAuth client_credentials.
 *
 * Free 100 req/min. Used when REDDIT_CLIENT_ID + SECRET are set.
 *
 * Adds (Phase 2):
 *   - fetchComments() — pulls top N comments per post
 *   - fetchAuthorContext() — pulls recent submissions to summarize the author
 */

import type { AuthorContext, RawPost, Source, TimeWindow } from "../types";

const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const API_BASE = "https://oauth.reddit.com";

interface TokenCache { token: string; expiresAt: number; }
const g = globalThis as any;
const getCache = (): TokenCache | null => g.__redditToken ?? null;
const setCache = (c: TokenCache) => { g.__redditToken = c; };

async function getToken(): Promise<string> {
  const cached = getCache();
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const id = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error("Reddit OAuth credentials missing. Set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET or switch to APIFY_TOKEN.");
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
  if (!res.ok) throw new Error(`Reddit token request failed: ${res.status} ${await res.text()}`);
  const json: any = await res.json();
  setCache({ token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 });
  return json.access_token;
}

function ua() { return process.env.REDDIT_USER_AGENT ?? "Pulse/1.0"; }

// ─── SEARCH ────────────────────────────────────────────────────────────────

async function searchOne(opts: {
  token: string; q: string; subreddit?: string; time: TimeWindow; limit: number;
}): Promise<RawPost[]> {
  const { token, q, subreddit, time, limit } = opts;
  const params = new URLSearchParams({
    q, sort: "new", t: time,
    limit: String(Math.min(limit, 100)),
    raw_json: "1",
  });
  if (subreddit) params.set("restrict_sr", "true");
  const url = subreddit
    ? `${API_BASE}/r/${subreddit}/search?${params}`
    : `${API_BASE}/search?${params}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, "User-Agent": ua() } });
  if (!res.ok) return [];
  const data: any = await res.json();
  const children: any[] = data?.data?.children ?? [];
  return children
    .filter((c) => !c.data.over_18)
    .map((c): RawPost => {
      const d = c.data;
      return {
        sourceId: "reddit",
        externalId: d.name,
        url: `https://www.reddit.com${d.permalink}`,
        permalink: d.permalink,
        author: d.author,
        authorUrl: d.author && d.author !== "[deleted]" ? `https://www.reddit.com/user/${d.author}` : undefined,
        title: d.title,
        content: (d.selftext ?? "").trim(),
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

// ─── COMMENTS ──────────────────────────────────────────────────────────────

async function fetchTopComments(token: string, post: RawPost, maxPerPost: number): Promise<RawPost[]> {
  // Drop t3_ prefix from name to get bare ID for the comments endpoint
  const postId = post.externalId.replace(/^t3_/, "");
  const url = `${API_BASE}/comments/${postId}?sort=top&limit=${Math.min(maxPerPost + 2, 10)}&depth=1&raw_json=1`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, "User-Agent": ua() } });
  if (!res.ok) return [];
  const data: any = await res.json();
  // Reddit returns [post, comments] — comments live at index 1
  const commentChildren: any[] = data?.[1]?.data?.children ?? [];
  const comments: RawPost[] = [];
  for (const child of commentChildren) {
    if (child.kind !== "t1") continue; // skip "more" objects
    const d = child.data;
    if (!d || d.stickied) continue;
    const body = (d.body ?? "").trim();
    if (!body || body === "[deleted]" || body === "[removed]") continue;
    if (body.length < 40) continue; // skip one-line junk
    comments.push({
      sourceId: "reddit",
      externalId: d.name, // t1_xxx — globally unique
      url: `https://www.reddit.com${d.permalink}`,
      permalink: d.permalink,
      author: d.author,
      authorUrl: d.author && d.author !== "[deleted]" ? `https://www.reddit.com/user/${d.author}` : undefined,
      title: undefined,
      content: body,
      createdAt: new Date(d.created_utc * 1000).toISOString(),
      isComment: true,
      metadata: {
        subreddit: d.subreddit,
        subredditPrefixed: `r/${d.subreddit}`,
        upvotes: d.score,
        replies: d.replies?.data?.children?.length ?? 0,
        parentPostId: post.externalId,
        parentTitle: post.title,
        parentUrl: post.url,
      },
    });
    if (comments.length >= maxPerPost) break;
  }
  return comments;
}

// ─── AUTHOR CONTEXT ────────────────────────────────────────────────────────

async function fetchAuthorRecent(token: string, username: string): Promise<AuthorContext | null> {
  if (!username || username === "[deleted]" || username === "AutoModerator") return null;
  const url = `${API_BASE}/user/${encodeURIComponent(username)}/submitted?limit=10&sort=new&raw_json=1`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, "User-Agent": ua() } });
  if (!res.ok) return null;
  const data: any = await res.json();
  const items: any[] = data?.data?.children ?? [];
  const subs = new Set<string>();
  for (const it of items) if (it?.data?.subreddit) subs.add(it.data.subreddit);
  return {
    username,
    recentPostCount: items.length,
    recentSubreddits: Array.from(subs).slice(0, 10),
    summary: "", // filled by scoring layer with Claude
    signalAdjustment: 0,
  };
}

// ─── SOURCE EXPORT ─────────────────────────────────────────────────────────

export const redditOauthSource: Source = {
  id: "reddit",
  name: "Reddit (OAuth)",
  available: Boolean(process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET),

  async fetch({ keywords, subreddits, timeWindow, limit }) {
    if (keywords.length === 0) return [];
    const token = await getToken();
    const subList = subreddits && subreddits.length > 0 ? subreddits : [undefined];
    const perQuery = Math.min(100, Math.ceil((limit * 2) / Math.max(1, subList.length)));
    const tasks: Array<() => Promise<RawPost[]>> = [];
    for (const q of keywords) for (const sub of subList) {
      tasks.push(() => searchOne({ token, q, subreddit: sub, time: timeWindow, limit: perQuery }));
    }
    const results: RawPost[] = [];
    for (const batch of chunk(tasks, 6)) {
      const res = await Promise.all(batch.map((t) => t().catch(() => [])));
      for (const r of res) results.push(...r);
    }
    const seen = new Set<string>();
    const deduped: RawPost[] = [];
    for (const p of results) {
      if (seen.has(p.externalId)) continue;
      seen.add(p.externalId);
      deduped.push(p);
    }
    deduped.sort((a, b) => {
      const t = b.createdAt.localeCompare(a.createdAt);
      if (t !== 0) return t;
      return (b.metadata.upvotes ?? 0) - (a.metadata.upvotes ?? 0);
    });
    return deduped.slice(0, Math.max(limit * 3, 30));
  },

  async fetchComments(posts, maxPerPost) {
    if (posts.length === 0) return [];
    const token = await getToken();
    // Only pull comments for posts likely to have signal — high comment count or upvotes
    const candidates = posts
      .filter((p) => !p.isComment)
      .filter((p) => (p.metadata.comments ?? 0) >= 2 || (p.metadata.upvotes ?? 0) >= 3)
      .slice(0, 25); // hard cap on cost
    const all: RawPost[] = [];
    for (const batch of chunk(candidates, 5)) {
      const res = await Promise.all(batch.map((p) => fetchTopComments(token, p, maxPerPost).catch(() => [])));
      for (const r of res) all.push(...r);
    }
    return all;
  },

  async fetchAuthorContext(usernames) {
    const unique = Array.from(new Set(usernames.filter((u) => u && u !== "[deleted]")));
    if (unique.length === 0) return {};
    const token = await getToken();
    const out: Record<string, AuthorContext> = {};
    // Cap to 30 unique authors per scan to control rate
    for (const batch of chunk(unique.slice(0, 30), 5)) {
      const res = await Promise.all(batch.map((u) => fetchAuthorRecent(token, u).catch(() => null)));
      for (let i = 0; i < batch.length; i++) {
        const r = res[i];
        if (r) out[batch[i]] = r;
      }
    }
    return out;
  },
};
