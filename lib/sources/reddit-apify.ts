/**
 * Reddit source — Apify implementation.
 *
 * Used when REDDIT_PROVIDER=apify or as fallback when OAuth credentials are
 * absent. Actor: trudax/reddit-scraper-lite (~$3.40 per 1k results).
 *
 * Phase 2: fetchComments() runs the same actor against startUrls scoped to
 * each matched post, with type=comments. Author context isn't easy via Apify
 * cheaply, so we fall back to /user/{u}.json (public, unauthenticated).
 */

import type { AuthorContext, RawPost, Source, TimeWindow } from "../types";

const APIFY_API = "https://api.apify.com/v2";
const DEFAULT_ACTOR = "trudax~reddit-scraper-lite";

interface ApifyItem {
  id?: string; parsedId?: string; url?: string;
  username?: string; author?: string;
  title?: string; body?: string; text?: string;
  communityName?: string; parsedCommunityName?: string; subreddit?: string;
  numberOfComments?: number; numComments?: number;
  upVotes?: number; score?: number;
  createdAt?: string | number; created?: string | number; scrapedAt?: string;
  over18?: boolean; isAd?: boolean;
  dataType?: string;
  postId?: string; permalink?: string;
  parentPostId?: string;
}

async function runActor(actorId: string, token: string, input: any): Promise<ApifyItem[]> {
  const url = `${APIFY_API}/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?token=${token}&memory=2048&timeout=300`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Apify run failed: ${res.status} ${await res.text().catch(() => "")}`);
  return await res.json();
}

function mapPost(it: ApifyItem): RawPost | null {
  const externalId = it.parsedId ?? (it.id ? `t3_${it.id}` : null) ?? it.postId ?? null;
  const postUrl = it.url ?? (it.permalink ? `https://www.reddit.com${it.permalink}` : null);
  if (!externalId || !postUrl) return null;
  const subreddit = it.parsedCommunityName ?? it.subreddit ?? (it.communityName ? it.communityName.replace(/^r\//, "") : "");
  const createdRaw = it.createdAt ?? it.created ?? it.scrapedAt;
  const createdAt = typeof createdRaw === "number"
    ? new Date(createdRaw * 1000).toISOString()
    : createdRaw ? new Date(createdRaw).toISOString() : new Date().toISOString();
  const author = it.username ?? it.author ?? "[unknown]";
  return {
    sourceId: "reddit",
    externalId,
    url: postUrl,
    permalink: it.permalink ?? postUrl.replace(/^https?:\/\/[^/]+/, ""),
    author,
    authorUrl: author && author !== "[unknown]" && author !== "[deleted]" ? `https://www.reddit.com/user/${author}` : undefined,
    title: it.title ?? "",
    content: (it.body ?? it.text ?? "").trim(),
    createdAt,
    metadata: {
      subreddit,
      subredditPrefixed: subreddit ? `r/${subreddit}` : "",
      upvotes: it.upVotes ?? it.score ?? 0,
      comments: it.numberOfComments ?? it.numComments ?? 0,
      provider: "apify",
    },
  };
}

function mapComment(it: ApifyItem, parents: Map<string, RawPost>): RawPost | null {
  const externalId = it.parsedId ?? (it.id ? `t1_${it.id}` : null);
  const commentUrl = it.url ?? (it.permalink ? `https://www.reddit.com${it.permalink}` : null);
  if (!externalId || !commentUrl) return null;
  const author = it.username ?? it.author ?? "[unknown]";
  const body = (it.body ?? it.text ?? "").trim();
  if (!body || body.length < 40) return null;
  const subreddit = it.parsedCommunityName ?? it.subreddit ?? "";
  const createdRaw = it.createdAt ?? it.created;
  const createdAt = typeof createdRaw === "number"
    ? new Date(createdRaw * 1000).toISOString()
    : createdRaw ? new Date(createdRaw).toISOString() : new Date().toISOString();
  const parent = it.parentPostId ? parents.get(it.parentPostId) : undefined;
  return {
    sourceId: "reddit",
    externalId,
    url: commentUrl,
    permalink: it.permalink ?? commentUrl.replace(/^https?:\/\/[^/]+/, ""),
    author,
    authorUrl: author && author !== "[deleted]" ? `https://www.reddit.com/user/${author}` : undefined,
    title: undefined,
    content: body,
    createdAt,
    isComment: true,
    metadata: {
      subreddit,
      subredditPrefixed: subreddit ? `r/${subreddit}` : "",
      upvotes: it.upVotes ?? it.score ?? 0,
      parentPostId: it.parentPostId,
      parentTitle: parent?.title,
      parentUrl: parent?.url,
      provider: "apify",
    },
  };
}

function buildSearchUrls(opts: { keywords: string[]; subreddits?: string[]; timeWindow: TimeWindow }) {
  const { keywords, subreddits, timeWindow } = opts;
  const urls: { url: string; method: "GET" }[] = [];
  if (subreddits && subreddits.length > 0) {
    for (const sub of subreddits) for (const kw of keywords) {
      urls.push({
        url: `https://www.reddit.com/r/${sub}/search/?q=${encodeURIComponent(kw)}&restrict_sr=1&sort=new&t=${timeWindow}`,
        method: "GET",
      });
    }
  }
  return urls;
}

export const redditApifySource: Source = {
  id: "reddit",
  name: "Reddit (Apify)",
  available: Boolean(process.env.APIFY_TOKEN),

  async fetch({ keywords, subreddits, timeWindow, limit }) {
    if (keywords.length === 0) return [];
    const token = process.env.APIFY_TOKEN!;
    const actorId = process.env.APIFY_REDDIT_ACTOR_ID ?? DEFAULT_ACTOR;
    const startUrls = buildSearchUrls({ keywords, subreddits, timeWindow }).slice(0, 40);
    const items = await runActor(actorId, token, {
      startUrls,
      searches: keywords.slice(0, 8),
      type: "posts",
      sort: "new",
      time: timeWindow,
      maxItems: Math.max(limit * 3, 60),
      maxPostCount: Math.max(limit * 3, 60),
      maxComments: 0,
      maxCommunitiesAndUsers: 0,
      proxy: { useApifyProxy: true },
    });
    const raw = items
      .filter((it) => !it.over18 && !it.isAd && (!it.dataType || it.dataType === "post"))
      .map(mapPost)
      .filter((p): p is RawPost => p !== null);
    const seen = new Set<string>();
    const deduped: RawPost[] = [];
    for (const p of raw) {
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
    const token = process.env.APIFY_TOKEN!;
    const actorId = process.env.APIFY_REDDIT_ACTOR_ID ?? DEFAULT_ACTOR;
    // Only pull for high-engagement posts to control cost
    const candidates = posts
      .filter((p) => !p.isComment)
      .filter((p) => (p.metadata.comments ?? 0) >= 2 || (p.metadata.upvotes ?? 0) >= 3)
      .slice(0, 15);
    if (candidates.length === 0) return [];
    const parents = new Map(candidates.map((p) => [p.externalId, p]));
    const items = await runActor(actorId, token, {
      startUrls: candidates.map((p) => ({ url: p.url, method: "GET" as const })),
      type: "comments",
      sort: "top",
      maxItems: candidates.length * maxPerPost,
      maxComments: maxPerPost,
      maxCommentsPerPost: maxPerPost,
      maxCommunitiesAndUsers: 0,
      proxy: { useApifyProxy: true },
    });
    return items
      .filter((it) => !it.over18 && (!it.dataType || it.dataType === "comment"))
      .map((it) => mapComment(it, parents))
      .filter((c): c is RawPost => c !== null);
  },

  async fetchAuthorContext(usernames) {
    // Use public Reddit JSON for author profile — cheaper than spinning Apify
    // for tiny per-user pulls. Unauthenticated, lower limits but read-only & low risk.
    const unique = Array.from(new Set(usernames.filter((u) => u && u !== "[deleted]" && u !== "[unknown]"))).slice(0, 30);
    const out: Record<string, AuthorContext> = {};
    const tasks = unique.map(async (u) => {
      try {
        const res = await fetch(`https://www.reddit.com/user/${encodeURIComponent(u)}/submitted.json?limit=10&sort=new`, {
          headers: { "User-Agent": process.env.REDDIT_USER_AGENT ?? "Pulse/1.0" },
        });
        if (!res.ok) return;
        const data: any = await res.json();
        const items: any[] = data?.data?.children ?? [];
        const subs = new Set<string>();
        for (const it of items) if (it?.data?.subreddit) subs.add(it.data.subreddit);
        out[u] = {
          username: u,
          recentPostCount: items.length,
          recentSubreddits: Array.from(subs).slice(0, 10),
          summary: "",
          signalAdjustment: 0,
        };
      } catch {}
    });
    // chunked to ~10 parallel to keep IP polite
    for (let i = 0; i < tasks.length; i += 10) {
      await Promise.all(tasks.slice(i, i + 10));
    }
    return out;
  },
};
