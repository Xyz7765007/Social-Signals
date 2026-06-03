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
 * 20 = slightly under Reddit's default page size of 25. Smaller cap means
 * the actor needs less scroll time per sub. With 3 subs × ~30s + startup
 * ≈ 100s per chunk, comfortable under Apify's 180s actor timeout.
 */
const PER_SUB_LISTING_CAP = 20;

const TIME_WINDOW_MS: Record<string, number> = {
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
};

/**
 * Subreddits per Apify run.
 *
 * The actor visits startUrls SEQUENTIALLY in a single browser. Two timers
 * matter here, and people confuse them:
 *
 *   - scrollTimeout (per page): how long to scroll EACH listing for more
 *     items. Set to 20s. This is the input field on the actor.
 *
 *   - Actor timeout (per run): TOTAL wall time for the whole run. Set via
 *     `&timeout=180` on the API URL. This is the hard cap that kills the run.
 *
 * For a 3-sub chunk, total ≈ subs × (page-load + scroll + extract) + startup.
 * With heavy subs (r/singapore, r/Entrepreneur, r/smallbusiness), per-page
 * time can hit 50-60s — so 3 heavies × 55s + 30s overhead = ~195s, exceeds
 * the 180s actor timeout. We observed this exact failure.
 *
 * With 2 subs per chunk: 2 × 55s + 30s = ~140s worst case. Comfortably under.
 *
 * Cost: same total Apify spend (same total subs scraped); we just split into
 * more parallel runs. RAM: 4 × 2GB = 8GB total, at Apify Free's cap.
 */
const SUBS_PER_APIFY_CALL = 2;

/**
 * Round-robin distribute subs across N chunks instead of slicing.
 *
 * Why: subs vary wildly in traffic and page complexity. r/Entrepreneur and
 * r/smallbusiness are huge and slow to scrape. r/sgsmallbusiness is tiny
 * and fast. Slicing [0..3] vs [4..7] can stack all the slow ones in one
 * chunk, guaranteeing that chunk times out.
 *
 * Round-robin guarantees each chunk has a mix — both an "easy" sub and a
 * "hard" sub. No chunk gets stuck holding the bag.
 */
function distributeSubs(subs: string[]): string[][] {
  const chunkCount = Math.max(1, Math.ceil(subs.length / SUBS_PER_APIFY_CALL));
  const chunks: string[][] = Array.from({ length: chunkCount }, () => []);
  for (let i = 0; i < subs.length; i++) {
    chunks[i % chunkCount].push(subs[i]);
  }
  return chunks;
}

function chunkArr<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

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

/**
 * Estimated cost per scraped result for trudax/reddit-scraper-lite.
 *
 * Actor docs: "1,000 results for less than $4 in platform usage credits"
 * → ~$0.004 per result.
 *
 * We use $0.005 to slightly over-estimate (preferable to under-reporting cost
 * to the user). Real billing observed: $0.24 for ~50 items = $0.0048/item.
 *
 * This is a FALLBACK. If the response includes a runId we can look up the
 * actual billed cost from /actor-runs/{id}. Estimate is used when the runId
 * header is missing (which happens on this actor in current Apify API).
 */
const APIFY_COST_PER_RESULT = 0.005;

async function runActor(actorId: string, token: string, input: any): Promise<ActorRunResult> {
  // /run-sync-get-dataset-items: proven endpoint that returns dataset items.
  //
  // We previously tried /run-sync (no "-get-dataset-items") hoping it would
  // return the run object with cost info — turns out that endpoint returns
  // the actor's OUTPUT key-value store record, which is empty for this
  // actor. Triggered "Unexpected end of JSON input" on every chunk.
  const url = `${APIFY_API}/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?token=${token}&memory=2048&timeout=180`;
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }, { label: `apify ${actorId}`, timeoutMs: 200_000, retries: 0 });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Apify HTTP ${res.status}: ${errBody.slice(0, 200)}`);
  }

  // Defensive parsing — Apify sometimes returns empty body when the actor
  // times out, and JSON.parse("") throws "Unexpected end of JSON input"
  // which is hard to diagnose. Read as text first and handle each failure
  // mode explicitly.
  const text = await res.text();
  if (text.trim().length === 0) {
    console.warn(`Apify ${actorId}: empty response body (actor likely timed out before producing items)`);
    return { items: [], costUsd: 0 };
  }

  let items: ApifyItem[];
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      console.warn(`Apify ${actorId}: response not array (got ${typeof parsed}). Preview: ${text.slice(0, 150)}`);
      return { items: [], costUsd: 0 };
    }
    items = parsed;
  } catch (e: any) {
    console.warn(`Apify ${actorId}: JSON parse failed (${e?.message}). Preview: ${text.slice(0, 150)}`);
    return { items: [], costUsd: 0 };
  }

  // Try to get actual billed cost. Apify-Run-Id header may or may not be
  // present depending on actor + API version. Fall back to per-result estimate.
  const runId =
    res.headers.get("Apify-Run-Id") ??
    res.headers.get("X-Apify-Run-Id") ??
    res.headers.get("apify-run-id");

  let costUsd = 0;
  let costSource = "estimated";

  if (runId) {
    try {
      const runRes = await fetchWithRetry(
        `${APIFY_API}/actor-runs/${runId}?token=${token}`,
        {},
        { label: "apify cost", timeoutMs: 15_000, retries: 1 },
      );
      if (runRes.ok) {
        const data: any = await runRes.json();
        const reported = Number(data?.data?.usageTotalUsd ?? 0);
        if (Number.isFinite(reported) && reported > 0) {
          costUsd = reported;
          costSource = "billed";
        }
      }
    } catch {
      // Fall through to estimate
    }
  }

  if (costUsd === 0) {
    // Fallback: estimate from item count
    costUsd = items.length * APIFY_COST_PER_RESULT;
  }

  console.log(`Apify ${actorId} → ${items.length} items, $${costUsd.toFixed(4)} (${costSource})`);
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
 * Generic words that match too broadly to be useful as anchors. If the user's
 * keyword is "accounting services" and we anchored on "services" alone, every
 * single SaaS / agency / consultancy post on r/Entrepreneur would match.
 * "Company", "business", etc. are universally present in business subreddits.
 */
const ANCHOR_DENYLIST = new Set([
  // Articles, prepositions, pronouns
  "the", "a", "an", "of", "in", "for", "to", "and", "or", "is", "are",
  "with", "by", "from", "on", "at", "as", "be", "my", "we", "i", "you",
  // Generic biz nouns — present in nearly every business post
  "company", "business", "service", "services", "provider", "providers",
  "firm", "firms",
  // Verbs that match too broadly
  "looking", "find", "get", "want", "need", "use", "using",
]);

/**
 * Build keyword matchers from user input. Returns:
 *   - phrases: full multi-word substrings (e.g. "incorporate company")
 *   - anchors: significant single words extracted from phrases (e.g.
 *     "incorporate", "accounting", "singapore", "bookkeeping")
 *
 * A post matches if EITHER its haystack contains a full phrase OR contains
 * at least one anchor word. This is much more forgiving than requiring
 * exact phrase substrings — "looking for an accountant" matches anchor
 * "accountant" even though it doesn't match phrase "looking for accountant".
 */
function buildKeywordMatchers(keywords: string[]): { phrases: string[]; anchors: string[] } {
  const phraseSet = new Set<string>();
  const anchorSet = new Set<string>();
  for (const kw of keywords) {
    const norm = normalizeKw(kw);
    if (norm.length < 2) continue;
    phraseSet.add(norm);
    // Also extract individual significant words as anchors
    for (const word of norm.split(/\s+/)) {
      // Min length 3 to avoid "a", "to" etc, but allow short specific terms
      // like "gst", "acra", "ai"
      if (word.length >= 3 && !ANCHOR_DENYLIST.has(word)) {
        anchorSet.add(word);
      }
    }
  }
  return { phrases: Array.from(phraseSet), anchors: Array.from(anchorSet) };
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

    const subList = subreddits && subreddits.length > 0 ? subreddits : ["all"];

    // Round-robin distribute subs across chunks. Each chunk becomes a
    // parallel Apify run. See distributeSubs comment for why round-robin
    // vs straight slicing matters.
    const subChunks = distributeSubs(subList);

    // Total raw posts we want across all chunks. Cap at HARD_FETCH_CAP × 2
    // (we filter heavily after, so over-fetch is fine).
    const targetTotalAcrossChunks = Math.min(
      subList.length * PER_SUB_LISTING_CAP,
      HARD_FETCH_CAP * 2,
    );
    const targetPerChunk = Math.ceil(targetTotalAcrossChunks / subChunks.length);

    const windowMs = TIME_WINDOW_MS[timeWindow] ?? TIME_WINDOW_MS.week;
    const postDateLimit = new Date(Date.now() - windowMs).toISOString();

    // Optional proxy override — actor default is RESIDENTIAL which is what
    // we want. Opt-out to cheaper datacenter only via env var.
    const proxyOverride = process.env.APIFY_DATACENTER_PROXY === "true"
      ? { proxy: { useApifyProxy: true, apifyProxyGroups: [] } }
      : {};

    // Track which chunks failed so the orchestrator can surface this in
    // scan.warnings rather than the user seeing "0 posts" with no explanation.
    const chunkFailures: string[] = [];

    // Fire all chunks in parallel. One chunk's failure doesn't kill the
    // whole fetch — we collect what we can.
    const chunkResults = await Promise.all(subChunks.map(async (subs, idx) => {
      const startUrls = subs.map((sub) => ({
        url: `https://www.reddit.com/r/${sub}/new/`,
      }));
      try {
        return await runActor(actorId, token, {
          startUrls,
          skipComments: true,
          skipCommunity: true,
          skipUserPosts: true,
          includeNSFW: false,
          maxItems: targetPerChunk,
          maxPostCount: PER_SUB_LISTING_CAP,
          // scrollTimeout=20 (seconds). 25 was right at the timeout cliff —
          // one chunk hit Apify's 180s actor timeout when it had 2 heavy
          // subs (singapore + smallbusiness). 20s per sub × 3 subs +
          // startup ≈ 95s, comfortable margin under 180s.
          //
          // Lower than 20 (we tried 8) caused pages to bail before fully
          // rendering. 20 is the practical floor for Reddit's JS-heavy pages.
          scrollTimeout: 20,
          postDateLimit,
          ...proxyOverride,
        });
      } catch (e: any) {
        const msg = `Apify chunk ${idx + 1}/${subChunks.length} (${subs.join(", ")}) failed: ${e?.message ?? "unknown"}`;
        console.warn(msg);
        chunkFailures.push(msg);
        return { items: [], costUsd: 0 };
      }
    }));

    // If EVERY chunk failed, this is a real fetch failure — throw so the
    // orchestrator marks it as failed rather than completing with 0 posts.
    if (chunkFailures.length === subChunks.length && subChunks.length > 0) {
      throw new Error(
        `All ${subChunks.length} Apify chunks failed. First error: ${chunkFailures[0]}`,
      );
    }

    // Merge items and costs across all parallel runs
    const allItems = chunkResults.flatMap((r) => r.items);
    const costUsd = chunkResults.reduce((sum, r) => sum + r.costUsd, 0);

    // ── Post-filter by time window ───────────────────────────────────────
    const cutoff = Date.now() - windowMs;

    // ── Post-filter by keyword match ─────────────────────────────────────
    // Match either a full phrase OR any anchor word. The old "phrase-only"
    // filter was so strict it dropped posts like "I need an accountant"
    // because that doesn't contain the exact phrase "looking for accountant".
    const { phrases, anchors } = buildKeywordMatchers(keywords);
    if (phrases.length === 0 && anchors.length === 0) {
      return { items: [], costUsd };
    }

    let filteredByTime = 0;
    let filteredByKeyword = 0;
    let filteredOther = 0;

    const matched: RawPost[] = [];
    for (const it of allItems) {
      if (it.over18 || it.isAd) { filteredOther++; continue; }
      if (it.dataType && it.dataType !== "post") { filteredOther++; continue; }

      const post = mapPost(it);
      if (!post) { filteredOther++; continue; }

      const createdMs = new Date(post.createdAt).getTime();
      if (!Number.isFinite(createdMs) || createdMs < cutoff) {
        filteredByTime++;
        continue;
      }

      const haystack = postHaystack(post);
      let hasMatch = false;
      for (const phrase of phrases) {
        if (haystack.includes(phrase)) { hasMatch = true; break; }
      }
      if (!hasMatch) {
        for (const anchor of anchors) {
          if (haystack.includes(anchor)) { hasMatch = true; break; }
        }
      }
      if (!hasMatch) {
        filteredByKeyword++;
        continue;
      }

      matched.push(post);
    }

    // Diagnostic so Vercel logs explain "why so few posts?"
    console.log(
      `Apify fetch: ${allItems.length} raw → ${matched.length} matched ` +
      `(filtered: ${filteredByTime} old, ${filteredByKeyword} no-keyword-match, ${filteredOther} other) ` +
      `| phrases=${phrases.length} anchors=${anchors.length}`,
    );

    // Dedup
    const seen = new Set<string>();
    const deduped: RawPost[] = [];
    for (const p of matched) {
      if (seen.has(p.externalId)) continue;
      seen.add(p.externalId);
      deduped.push(p);
    }

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

    // Only pull comments for posts likely to have signal. Cap at 8 (down
    // from 15) — actor processes these sequentially in one browser, so
    // 15 × ~15s = 225s vs 8 × ~15s = 120s. Lower count keeps us in budget
    // within Vercel's 300s cap after the listings fetch.
    const candidates = posts
      .filter((p) => !p.isComment)
      .filter((p) => (p.metadata.comments ?? 0) >= 2 || (p.metadata.upvotes ?? 0) >= 3)
      .slice(0, 8);
    if (candidates.length === 0) return { items: [], costUsd: 0 };

    const parents = new Map(candidates.map((p) => [p.externalId, p]));

    // For comments, scrape individual post URLs — those work fine through
    // Apify since they're not search pages.
    const { items, costUsd } = await runActor(actorId, token, {
      startUrls: candidates.map((p) => ({ url: p.url })),
      // `sort` is IGNORED with startUrls — URL determines comment sort.
      // Reddit's default is "best" which surfaces top-voted, which is fine.
      skipUserPosts: true,
      skipCommunity: true,
      includeNSFW: false,
      maxItems: candidates.length * maxPerPost,
      maxComments: maxPerPost,
      // 15s gives post page time to render. Top comments load at the top.
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
