/**
 * Reddit source — Apify implementation with LISTING-BASED scraping.
 *
 * ════════════════════════════════════════════════════════════════════════
 * Why listings, not search:
 *
 * Reddit's anti-bot system in 2026 is most aggressive on /search/ endpoints
 * — search URLs are the easiest abuse vector for data harvesting, so Reddit
 * either serves "no results" pages, captcha challenges, or empty listings
 * when Apify proxies hit them. We saw this in practice: 4-1 posts per scan
 * across 20+ search URLs.
 *
 * Subreddit LISTING pages (/r/{sub}/new/, /r/{sub}/hot/) are different.
 * Every human browsing Reddit hits these. Blocking them would break Reddit.
 * Apify scrapers can pull listings reliably.
 *
 * Strategy:
 *   1. Scrape /r/{sub}/new/ for each target subreddit
 *   2. Pull up to 50 recent posts per sub (8 subs × 50 = 400 posts max)
 *   3. Filter in OUR code by:
 *        - time window (e.g. last 7 days for "week")
 *        - keyword match (any keyword appearing in title or body)
 *   4. Return top HARD_FETCH_CAP=200 by recency
 *
 * Cost: ~$0.50-1.20 per scan depending on plan + perSubCap. Worth it for
 * reliable data vs $0.005 of garbage from search.
 *
 * Residential proxies are the actor's DEFAULT. We let it use them unless
 * you explicitly opt-out with APIFY_DATACENTER_PROXY=true (cheaper but
 * less reliable — Reddit blocks datacenter IPs more aggressively).
 * ════════════════════════════════════════════════════════════════════════
 */

import type {
  AuthorContext, RawPost, Source, SourceAuthorContextResult,
  SourceFetchResult, TimeWindow,
} from "../types";
import { fetchWithRetry } from "../fetch-retry";

const APIFY_API = "https://api.apify.com/v2";
const DEFAULT_ACTOR = "trudax~reddit-scraper-lite";

/**
 * Hard ceiling on raw posts returned by fetch(). Bounds worst-case Apify
 * cost. Listings approach can pull 400 raw posts before filtering, but
 * after time + keyword filter we typically end up with 20-80 — the cap
 * is a safety net for the unlikely "everything matches" case.
 */
const HARD_FETCH_CAP = 200;

/**
 * Per-sub listing depth. Tune to balance cost vs comprehensiveness vs
 * Vercel's 300s function timeout.
 *
 * 25 = Reddit's default listing page size. Going higher (50, 100) requires
 * the actor to paginate, which serializes requests and balloons runtime
 * past Vercel's 300s limit. With 8 subs × 25 posts × ~3s per page = ~60s
 * actor runtime, comfortably under timeout.
 */
const PER_SUB_LISTING_CAP = 25;

const TIME_WINDOW_MS: Record<string, number> = {
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
};

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
  // memory=8192 gives the actor ~8-way browser parallelism (Apify's
  // Crawlee allocates ~512MB per concurrent browser). With 8 subreddit
  // listings × 30s scrollTimeout, sequential = 240s (exceeds Vercel cap).
  // 8-way parallel = ~30-50s. timeout=240s leaves room for orchestrator
  // overhead within Vercel's 300s function limit.
  const url = `${APIFY_API}/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?token=${token}&memory=8192&timeout=240`;
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }, { label: `apify ${actorId}`, timeoutMs: 260_000, retries: 0 });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Apify run failed: ${res.status} ${errBody.slice(0, 200)}`);
  }
  const runId = res.headers.get("X-Apify-Run-Id") ?? res.headers.get("x-apify-run-id");
  const items: ApifyItem[] = await res.json();

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
        const reported = Number(data?.data?.usageTotalUsd ?? 0);
        if (Number.isFinite(reported) && reported >= 0) costUsd = reported;
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

/**
 * Normalize a keyword for matching. Lowercase + collapse whitespace + strip
 * surrounding quotes. Preserves multi-word phrases as substrings to match.
 */
function normalizeKw(kw: string): string {
  return kw.toLowerCase().replace(/\s+/g, " ").replace(/^["']|["']$/g, "").trim();
}

/**
 * Build a haystack from a post for keyword matching. Lowercase title + body
 * concatenated. We match substring (so "incorporate company" matches
 * "want to incorporate company in SG").
 */
function postHaystack(post: RawPost): string {
  return `${post.title ?? ""} ${post.content ?? ""}`.toLowerCase();
}

export const redditApifySource: Source = {
  id: "reddit",
  name: "Reddit (Apify)",
  available: Boolean(process.env.APIFY_TOKEN),

  async fetch({ keywords, subreddits, timeWindow, limit }): Promise<SourceFetchResult> {
    if (keywords.length === 0) return { items: [], costUsd: 0 };
    const token = process.env.APIFY_TOKEN!;
    const actorId = process.env.APIFY_REDDIT_ACTOR_ID ?? DEFAULT_ACTOR;

    // Use SUBREDDIT LISTINGS, not search URLs. Reddit's anti-bot is much
    // less aggressive on listings — these are how every Reddit user browses.
    const subList = subreddits && subreddits.length > 0 ? subreddits : ["all"];
    const startUrls = subList.map((sub) => ({
      url: `https://www.reddit.com/r/${sub}/new/`,
    }));

    // Pull more posts than we'll keep — keyword/time filter happens in code,
    // so the actor needs slack. Apify cost is bounded by maxItems.
    const targetTotal = Math.min(subList.length * PER_SUB_LISTING_CAP, HARD_FETCH_CAP * 2);

    const { items, costUsd } = await runActor(actorId, token, {
      startUrls,
      sort: "new",
      // Schema flags — drop the work we don't need so the actor finishes faster.
      skipComments: true,   // listing scrape doesn't need per-post comments
      skipCommunity: true,  // don't pull community metadata pages
      skipUserPosts: true,  // don't follow into user profiles
      includeNSFW: false,   // actor default is TRUE — explicitly off
      maxItems: targetTotal,
      maxPostCount: PER_SUB_LISTING_CAP,
      // scrollTimeout (seconds): time the actor keeps scrolling the listing
      // page to load more posts via infinite scroll. Actor's default is 40s.
      // We set 30s — gives Reddit's JS-heavy page time to render the initial
      // listing AND a few seconds to load any lazy-rendered posts, but
      // shaves off enough to fit within Vercel's 300s function cap when
      // running across 8 subs with memory=8192 parallelism.
      // Going lower (e.g. 8s) caused pages to bail before fully rendering →
      // 1-4 posts pulled instead of 25.
      scrollTimeout: 30,
      // Server-side time filter — let actor skip pages of old posts.
      // Format is ISO date string; actor stops when it sees posts older
      // than this. Backstopped by our in-code time filter below.
      postDateLimit: new Date(Date.now() - (TIME_WINDOW_MS[timeWindow] ?? TIME_WINDOW_MS.week)).toISOString(),
      // proxy: omitted — actor default is `{useApifyProxy: true,
      // apifyProxyGroups: ["RESIDENTIAL"]}` which is what we want. Overriding
      // to plain datacenter was making us look like a bot to Reddit. Opt-out
      // to datacenter (cheaper but unreliable) via APIFY_DATACENTER_PROXY=true.
      ...(process.env.APIFY_DATACENTER_PROXY === "true"
        ? { proxy: { useApifyProxy: true, apifyProxyGroups: [] } }
        : {}),
    });

    // ── Post-filter by time window ───────────────────────────────────────
    const windowMs = TIME_WINDOW_MS[timeWindow] ?? TIME_WINDOW_MS.week;
    const cutoff = Date.now() - windowMs;

    // ── Post-filter by keyword match ─────────────────────────────────────
    // Match substring (case-insensitive) in title + body. Multi-word
    // phrases match if the phrase appears together. Single words match
    // anywhere.
    const kwLower = keywords.map(normalizeKw).filter((k) => k.length >= 2);
    if (kwLower.length === 0) {
      return { items: [], costUsd };
    }

    const matched: RawPost[] = [];
    for (const it of items) {
      if (it.over18 || it.isAd) continue;
      if (it.dataType && it.dataType !== "post") continue;

      const post = mapPost(it);
      if (!post) continue;

      // Time filter
      const createdMs = new Date(post.createdAt).getTime();
      if (!Number.isFinite(createdMs) || createdMs < cutoff) continue;

      // Keyword filter — any keyword appearing as substring counts
      const haystack = postHaystack(post);
      const hasMatch = kwLower.some((kw) => haystack.includes(kw));
      if (!hasMatch) continue;

      matched.push(post);
    }

    // Dedup by externalId
    const seen = new Set<string>();
    const deduped: RawPost[] = [];
    for (const p of matched) {
      if (seen.has(p.externalId)) continue;
      seen.add(p.externalId);
      deduped.push(p);
    }

    // Sort newest first, then by upvotes as tiebreaker
    deduped.sort((a, b) => {
      const t = b.createdAt.localeCompare(a.createdAt);
      if (t !== 0) return t;
      return (b.metadata.upvotes ?? 0) - (a.metadata.upvotes ?? 0);
    });

    return { items: deduped.slice(0, HARD_FETCH_CAP), costUsd };
  },

  async fetchComments(posts, maxPerPost): Promise<SourceFetchResult> {
    if (posts.length === 0) return { items: [], costUsd: 0 };
    const token = process.env.APIFY_TOKEN!;
    const actorId = process.env.APIFY_REDDIT_ACTOR_ID ?? DEFAULT_ACTOR;

    // Only pull comments for posts likely to have signal
    const candidates = posts
      .filter((p) => !p.isComment)
      .filter((p) => (p.metadata.comments ?? 0) >= 2 || (p.metadata.upvotes ?? 0) >= 3)
      .slice(0, 15);
    if (candidates.length === 0) return { items: [], costUsd: 0 };

    const parents = new Map(candidates.map((p) => [p.externalId, p]));

    // For comments, scrape individual post URLs — those work fine through
    // Apify since they're not search.
    const { items, costUsd } = await runActor(actorId, token, {
      startUrls: candidates.map((p) => ({ url: p.url })),
      sort: "top",
      skipUserPosts: true,
      skipCommunity: true,
      includeNSFW: false,
      maxItems: candidates.length * maxPerPost,
      maxComments: maxPerPost,
      // 15s scroll budget for comment pages — top comments are at the top
      // and load quickly, but Reddit's post page still needs ~5-10s to
      // render before extraction. 15s is a safe floor.
      scrollTimeout: 15,
      ...(process.env.APIFY_DATACENTER_PROXY === "true"
        ? { proxy: { useApifyProxy: true, apifyProxyGroups: [] } }
        : {}),
    });
    const comments = items
      .filter((it) => !it.over18 && (!it.dataType || it.dataType === "comment"))
      .map((it) => mapComment(it, parents))
      .filter((c): c is RawPost => c !== null);
    return { items: comments, costUsd };
  },

  async fetchAuthorContext(usernames): Promise<SourceAuthorContextResult> {
    // Best-effort. Public Reddit JSON for user profiles is blocked or
    // rate-limited in 2026, but we try anyway with proper UA. If it fails,
    // we return empty contexts and scoring continues without author info.
    const unique = Array.from(new Set(usernames.filter((u) => u && u !== "[deleted]" && u !== "[unknown]"))).slice(0, 20);
    const out: Record<string, AuthorContext> = {};
    const ua = process.env.REDDIT_USER_AGENT ?? "Pulse-SignalScanner/1.0 (B2B research)";
    const tasks = unique.map(async (u) => {
      try {
        const res = await fetchWithRetry(
          `https://www.reddit.com/user/${encodeURIComponent(u)}/submitted.json?limit=10&sort=new`,
          { headers: { "User-Agent": ua, Accept: "application/json" } },
          { label: "reddit user profile", timeoutMs: 10_000, retries: 0 },
        );
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
      } catch {
        // Silent fail — author context is best-effort
      }
    });
    // Process serially with small delay to avoid overwhelming Reddit
    for (let i = 0; i < tasks.length; i++) {
      await tasks[i];
      if (i < tasks.length - 1) await new Promise((r) => setTimeout(r, 100));
    }
    return { contexts: out, costUsd: 0 };
  },
};
