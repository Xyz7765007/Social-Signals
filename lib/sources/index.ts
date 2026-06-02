import type { Source, SourceId } from "../types";
import { redditOauthSource } from "./reddit-oauth";
import { redditApifySource } from "./reddit-apify";
import { redditPublicSource } from "./reddit-public";
import { twitterSource } from "./twitter";
import { newsSource } from "./news";
import { instagramSource } from "./instagram";

/**
 * Reddit provider selection — listings strategy makes Apify reliable again.
 *
 *  1. OAuth (REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET): free, 100 req/min,
 *     officially supported. Requires Reddit app creation — sometimes blocked.
 *  2. Apify (APIFY_TOKEN): scrapes subreddit LISTINGS (not search), then
 *     filters in-code by time + keyword. Reliable in 2026 because Reddit
 *     doesn't aggressively block listing pages. Paid: ~$0.50-1.20/scan.
 *  3. Public JSON: anonymous Reddit JSON. Officially blocked in 2026 but
 *     occasionally works. Kept as last-ditch fallback only.
 *
 * Override with REDDIT_PROVIDER=oauth | apify | public.
 */
function pickRedditSource(): Source {
  const forced = process.env.REDDIT_PROVIDER?.toLowerCase();
  if (forced === "oauth") return redditOauthSource;
  if (forced === "apify") return redditApifySource;
  if (forced === "public") return redditPublicSource;

  // Auto-select. OAuth wins if creds set (free + most reliable). Otherwise
  // Apify with listings strategy is the proven path. Public JSON is a
  // last-resort fallback if neither is configured.
  if (redditOauthSource.available) return redditOauthSource;
  if (redditApifySource.available) return redditApifySource;
  return redditPublicSource;
}

const reddit = pickRedditSource();

export const SOURCES: Record<SourceId, Source> = {
  reddit,
  twitter: twitterSource,
  news: newsSource,
  instagram: instagramSource,
};

export function getSource(id: SourceId): Source {
  const s = SOURCES[id];
  if (!s) throw new Error(`Unknown source: ${id}`);
  return s;
}

export function listSources(): Source[] {
  return Object.values(SOURCES);
}
