/**
 * Reddit source — Apify implementation.
 *
 * Cost tracking: after each actor run, we read `X-Apify-Run-Id` from the
 * response header and GET the run object to retrieve `usageTotalUsd` —
 * Apify's authoritative billed cost. This is the ground truth, not an estimate.
 *
 * Actor: trudax/reddit-scraper-lite (~$3.40 per 1k results in practice, but
 * actual price varies by compute units and dataset writes — read it from
 * Apify rather than estimating).
 */

import type {
  AuthorContext, RawPost, Source, SourceAuthorContextResult,
  SourceFetchResult, TimeWindow,
} from "../types";
import { fetchWithRetry } from "../fetch-retry";

const APIFY_API = "https://api.apify.com/v2";
const DEFAULT_ACTOR = "trudax~reddit-scraper-lite";

/**
 * Hard ceiling on raw posts fetched per scan.
 *
 * Apify bills per result. Without this cap, a scan with 12 keywords × 7
 * subreddits = 84 combinations can run away into thousands of posts —
 * burning credits and producing noisy data we then have to dedup + score.
 *
 * 200 is enough for good dedup + scoring filtering on a maxResults=100 scan,
 * and bounds worst-case cost at ~$0.60/scan on the Apify Reddit actor.
 *
 * Comments use a separate, smaller cap (15 posts × 3 comments = 45 max).
 */
const HARD_FETCH_CAP = 200;

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

interface ActorRunResult {
  items: ApifyItem[];
  costUsd: number;
}

async function runActor(actorId: string, token: string, input: any): Promise<ActorRunResult> {
  const url = `${APIFY_API}/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?token=${token}&memory=2048&timeout=300`;
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }, { label: `apify ${actorId}`, timeoutMs: 330_000, retries: 1 });
  if (!res.ok) throw new Error(`Apify run failed: ${res.status} ${await res.text().catch(() => "")}`);

  // The run ID lets us look up the actual billed cost.
  const runId = res.headers.get("X-Apify-Run-Id") ?? res.headers.get("x-apify-run-id");
  const items: ApifyItem[] = await res.json();

  // Cost lookup is best-effort — never fail the scan if Apify's cost API is
  // slow or unavailable. We just report 0 in that case.
  let costUsd = 0;
  if (runId) {
    try {
      const runRes = await fetchWithRetry(
        `${APIFY_API}/actor-runs/${runId}?token=${token}`,
        {},
        { label: "apify run cost", timeoutMs: 15_000, retries: 1 },
      );
      if (runRes.ok) {
        const data: any = await runRes.json();
        // Apify's run object: data.data.usageTotalUsd
        const reported = Number(data?.data?.usageTotalUsd ?? 0);
        if (Number.isFinite(reported) && reported >= 0) {
          costUsd = reported;
        }
      }
    } catch (e) {
      console.warn("Apify cost lookup failed (continuing with cost=0):", e);
    }
  }

  return { items, costUsd };
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

  // No subreddits → cross-Reddit search per keyword (one URL per keyword).
  if (!subreddits || subreddits.length === 0) {
    for (const kw of keywords) {
      urls.push({
        url: `https://www.reddit.com/search/?q=${encodeURIComponent(kw)}&sort=new&t=${timeWindow}`,
        method: "GET",
      });
    }
    return urls;
  }

  // KEYWORD-FIRST iteration: emit (keyword 1 × every sub) before moving to
  // (keyword 2 × every sub). Critical when the array gets sliced downstream
  // — slicing sub-first would cover one sub deeply and miss the rest entirely.
  // Keyword-first guarantees broad keyword + broad subreddit coverage even
  // when we slice to ~32 URLs.
  for (const kw of keywords) {
    for (const sub of subreddits) {
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

  async fetch({ keywords, subreddits, timeWindow, limit }): Promise<SourceFetchResult> {
    if (keywords.length === 0) return { items: [], costUsd: 0 };
    const token = process.env.APIFY_TOKEN!;
    const actorId = process.env.APIFY_REDDIT_ACTOR_ID ?? DEFAULT_ACTOR;

    // Strict cap on what we ask Apify to return. Use min() not max() —
    // the bug we hit before was using Math.max which never went below 60.
    // Cap target = min(limit * 3, HARD_FETCH_CAP). For limit=25 → 75. For
    // limit=100 → 200 (the ceiling).
    const targetTotal = Math.min(Math.max(limit * 3, 30), HARD_FETCH_CAP);

    // Reduce the number of startUrls we hand the actor. With keyword-first
    // iteration in buildSearchUrls, 32 URLs covers ~4 keywords × 8 subreddits
    // — broad enough to find signal, narrow enough that maxItems caps cost.
    // The HARD_FETCH_CAP slice at the end of fetch() is the real safety net.
    const startUrls = buildSearchUrls({ keywords, subreddits, timeWindow }).slice(0, 32);

    // Per-community cap. Keep below targetTotal so no single sub can consume
    // the whole budget.
    const perCommunityCap = Math.max(10, Math.ceil(targetTotal / Math.max(1, startUrls.length || 1)));

    const { items, costUsd } = await runActor(actorId, token, {
      startUrls,
      // Drop the `searches` param — we already have startUrls covering
      // every keyword × subreddit combination we care about. Passing both
      // doubles the fetch.
      type: "posts",
      sort: "new",
      time: timeWindow,
      maxItems: targetTotal,
      maxPostCount: perCommunityCap,
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
    // Final defense — even if Apify ignored our caps, slice to HARD_FETCH_CAP.
    return { items: deduped.slice(0, HARD_FETCH_CAP), costUsd };
  },

  async fetchComments(posts, maxPerPost): Promise<SourceFetchResult> {
    if (posts.length === 0) return { items: [], costUsd: 0 };
    const token = process.env.APIFY_TOKEN!;
    const actorId = process.env.APIFY_REDDIT_ACTOR_ID ?? DEFAULT_ACTOR;
    const candidates = posts
      .filter((p) => !p.isComment)
      .filter((p) => (p.metadata.comments ?? 0) >= 2 || (p.metadata.upvotes ?? 0) >= 3)
      .slice(0, 15);
    if (candidates.length === 0) return { items: [], costUsd: 0 };
    const parents = new Map(candidates.map((p) => [p.externalId, p]));
    const { items, costUsd } = await runActor(actorId, token, {
      startUrls: candidates.map((p) => ({ url: p.url, method: "GET" as const })),
      type: "comments",
      sort: "top",
      maxItems: candidates.length * maxPerPost,
      maxComments: maxPerPost,
      maxCommentsPerPost: maxPerPost,
      maxCommunitiesAndUsers: 0,
      proxy: { useApifyProxy: true },
    });
    const comments = items
      .filter((it) => !it.over18 && (!it.dataType || it.dataType === "comment"))
      .map((it) => mapComment(it, parents))
      .filter((c): c is RawPost => c !== null);
    return { items: comments, costUsd };
  },

  async fetchAuthorContext(usernames): Promise<SourceAuthorContextResult> {
    // Use unauthenticated Reddit JSON for author profile — Apify would cost
    // way more for tiny per-user pulls and this is read-only low-risk data.
    const unique = Array.from(new Set(usernames.filter((u) => u && u !== "[deleted]" && u !== "[unknown]"))).slice(0, 30);
    const out: Record<string, AuthorContext> = {};
    const tasks = unique.map(async (u) => {
      try {
        const res = await fetchWithRetry(`https://www.reddit.com/user/${encodeURIComponent(u)}/submitted.json?limit=10&sort=new`, {
          headers: { "User-Agent": process.env.REDDIT_USER_AGENT ?? "Pulse/1.0" },
        }, { label: "reddit user profile", timeoutMs: 15_000, retries: 1 });
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
    for (let i = 0; i < tasks.length; i += 10) {
      await Promise.all(tasks.slice(i, i + 10));
    }
    return { contexts: out, costUsd: 0 };
  },
};
