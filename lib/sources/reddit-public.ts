/**
 * Reddit source — public JSON API.
 *
 * Reddit exposes its data as JSON at /...json URLs without any auth. We use
 * the same endpoint shapes as the OAuth source but skip the token dance.
 *
 * Why this exists: Apify's Reddit scraper actors started failing silently in
 * 2024-2025 as Reddit hardened against scrapers. The Apify actor "succeeds"
 * (no error) but returns 0-2 items per search because Reddit served it a
 * page with no results. The public JSON endpoint serves real data.
 *
 * Rate limit: ~60 req/min for anonymous (vs OAuth's 100/min). We add small
 * inter-batch delays to stay under it. For Pulse's typical workload (~32
 * search queries per scan) this fits comfortably.
 *
 * No auth, no env vars, no setup. Always available.
 */

import type {
  AuthorContext, RawPost, Source, SourceAuthorContextResult,
  SourceFetchResult, TimeWindow,
} from "../types";
import { fetchWithRetry } from "../fetch-retry";

const BASE = "https://www.reddit.com";

function ua(): string {
  // Reddit blocks requests with generic UAs (curl/, fetch/, empty, etc.).
  // A descriptive UA passes their filter. The "by /u/..." suffix is the
  // recommended Reddit format but not strictly required for public JSON.
  return process.env.REDDIT_USER_AGENT ?? "Pulse-SignalScanner/1.0 (B2B research; +https://get-sidekick.com)";
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function mapPost(d: any): RawPost | null {
  if (!d?.name || !d?.permalink) return null;
  const subreddit = d.subreddit ?? "";
  const author = d.author ?? "[unknown]";
  return {
    sourceId: "reddit",
    externalId: d.name, // already in t3_xxx format
    url: `https://www.reddit.com${d.permalink}`,
    permalink: d.permalink,
    author,
    authorUrl: author !== "[unknown]" && author !== "[deleted]"
      ? `https://www.reddit.com/user/${author}` : undefined,
    title: d.title ?? "",
    content: (d.selftext ?? "").trim(),
    createdAt: new Date(((d.created_utc ?? 0) * 1000) || Date.now()).toISOString(),
    metadata: {
      subreddit,
      subredditPrefixed: subreddit ? `r/${subreddit}` : "",
      upvotes: d.score ?? 0,
      comments: d.num_comments ?? 0,
      provider: "reddit-public",
    },
  };
}

async function searchOne(opts: {
  q: string; subreddit?: string; time: TimeWindow; limit: number;
}): Promise<RawPost[]> {
  const { q, subreddit, time, limit } = opts;
  const path = subreddit
    ? `/r/${subreddit}/search.json?q=${encodeURIComponent(q)}&restrict_sr=on&sort=new&t=${time}&limit=${limit}`
    : `/search.json?q=${encodeURIComponent(q)}&sort=new&t=${time}&limit=${limit}`;
  const res = await fetchWithRetry(
    `${BASE}${path}`,
    { headers: { "User-Agent": ua(), Accept: "application/json" } },
    { label: "reddit public search", timeoutMs: 20_000, retries: 2 },
  );
  if (!res.ok) {
    if (res.status === 403) throw new Error("Reddit returned 403 — likely UA blocked or IP banned");
    if (res.status === 429) throw new Error("Reddit returned 429 — rate limit hit, slow down");
    return [];
  }
  const data: any = await res.json();
  const children: any[] = data?.data?.children ?? [];
  return children
    .filter((c) => c?.kind === "t3")
    .map((c) => mapPost(c.data))
    .filter((p): p is RawPost => p !== null);
}

async function fetchTopComments(post: RawPost, maxPerPost: number): Promise<RawPost[]> {
  const postId = post.externalId.replace(/^t3_/, "");
  const url = `${BASE}/comments/${postId}.json?sort=top&limit=${maxPerPost}`;
  const res = await fetchWithRetry(
    url,
    { headers: { "User-Agent": ua(), Accept: "application/json" } },
    { label: "reddit public comments", timeoutMs: 15_000, retries: 1 },
  );
  if (!res.ok) return [];
  const data: any = await res.json();
  // Reddit's comments endpoint returns [postListing, commentListing]
  const commentsListing = Array.isArray(data) ? data[1]?.data?.children : null;
  if (!commentsListing) return [];
  return commentsListing
    .filter((c: any) => c?.kind === "t1" && c?.data?.body)
    .filter((c: any) => !c.data.body.startsWith("[deleted]") && !c.data.body.startsWith("[removed]"))
    .filter((c: any) => c.data.body.length >= 40)
    .slice(0, maxPerPost)
    .map((c: any) => {
      const d = c.data;
      return {
        sourceId: "reddit" as const,
        externalId: `t1_${d.id}`,
        url: `https://www.reddit.com${d.permalink}`,
        permalink: d.permalink,
        author: d.author ?? "[unknown]",
        authorUrl: d.author && d.author !== "[deleted]" ? `https://www.reddit.com/user/${d.author}` : undefined,
        title: undefined,
        content: d.body,
        createdAt: new Date(((d.created_utc ?? 0) * 1000) || Date.now()).toISOString(),
        isComment: true,
        metadata: {
          subreddit: post.metadata.subreddit,
          subredditPrefixed: post.metadata.subredditPrefixed,
          upvotes: d.score ?? 0,
          parentPostId: post.externalId,
          parentTitle: post.title,
          parentUrl: post.url,
          provider: "reddit-public",
        },
      };
    });
}

async function fetchAuthorRecent(username: string): Promise<AuthorContext | null> {
  const url = `${BASE}/user/${encodeURIComponent(username)}/submitted.json?limit=10&sort=new`;
  try {
    const res = await fetchWithRetry(
      url,
      { headers: { "User-Agent": ua(), Accept: "application/json" } },
      { label: "reddit public user", timeoutMs: 15_000, retries: 1 },
    );
    if (!res.ok) return null;
    const data: any = await res.json();
    const items: any[] = data?.data?.children ?? [];
    const subs = new Set<string>();
    for (const it of items) if (it?.data?.subreddit) subs.add(it.data.subreddit);
    return {
      username,
      recentPostCount: items.length,
      recentSubreddits: Array.from(subs).slice(0, 10),
      summary: "",
      signalAdjustment: 0,
    };
  } catch {
    return null;
  }
}

export const redditPublicSource: Source = {
  id: "reddit",
  name: "Reddit (public JSON)",
  available: true, // No auth required — always works

  async fetch({ keywords, subreddits, timeWindow, limit }): Promise<SourceFetchResult> {
    if (keywords.length === 0) return { items: [], costUsd: 0 };
    const subList = subreddits && subreddits.length > 0 ? subreddits : [undefined];

    // Bound the total fetch
    const targetTotal = Math.min(Math.max(limit * 3, 30), 200);
    const totalQueries = Math.max(1, keywords.length * subList.length);
    // Ask for enough per-query so we hit target even after dedup
    const perQuery = Math.max(5, Math.min(50, Math.ceil((targetTotal * 1.5) / totalQueries)));

    // KEYWORD-FIRST iteration — broad coverage of subs when sliced
    const tasks: Array<() => Promise<RawPost[]>> = [];
    for (const kw of keywords) {
      for (const sub of subList) {
        tasks.push(() => searchOne({ q: kw, subreddit: sub, time: timeWindow, limit: perQuery })
          .catch((e) => {
            console.warn(`Reddit public search failed [${sub ?? "global"}/${kw}]:`, e?.message);
            return [];
          }));
      }
    }

    // 4 concurrent to stay polite to Reddit's anonymous rate limit (~60/min).
    // Small inter-batch delay also helps avoid the 429 cliff.
    const results: RawPost[] = [];
    for (const batch of chunk(tasks, 4)) {
      const res = await Promise.all(batch.map((t) => t()));
      for (const r of res) results.push(...r);
      if (results.length >= 200 * 2) break;
      await new Promise((r) => setTimeout(r, 250));
    }

    // Dedup by externalId
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
    return { items: deduped.slice(0, 200), costUsd: 0 };
  },

  async fetchComments(posts, maxPerPost): Promise<SourceFetchResult> {
    if (posts.length === 0) return { items: [], costUsd: 0 };
    const candidates = posts
      .filter((p) => !p.isComment)
      .filter((p) => (p.metadata.comments ?? 0) >= 2 || (p.metadata.upvotes ?? 0) >= 3)
      .slice(0, 20);
    const all: RawPost[] = [];
    for (const batch of chunk(candidates, 4)) {
      const res = await Promise.all(batch.map((p) => fetchTopComments(p, maxPerPost).catch(() => [])));
      for (const r of res) all.push(...r);
      await new Promise((r) => setTimeout(r, 250));
    }
    return { items: all, costUsd: 0 };
  },

  async fetchAuthorContext(usernames): Promise<SourceAuthorContextResult> {
    const unique = Array.from(new Set(usernames.filter((u) => u && u !== "[deleted]" && u !== "[unknown]"))).slice(0, 30);
    if (unique.length === 0) return { contexts: {}, costUsd: 0 };
    const out: Record<string, AuthorContext> = {};
    for (const batch of chunk(unique, 4)) {
      const res = await Promise.all(batch.map((u) => fetchAuthorRecent(u).catch(() => null)));
      for (let i = 0; i < batch.length; i++) {
        const r = res[i];
        if (r) out[batch[i]] = r;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return { contexts: out, costUsd: 0 };
  },
};
