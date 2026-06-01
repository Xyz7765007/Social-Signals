import type { Source, SourceId } from "../types";
import { redditOauthSource } from "./reddit-oauth";
import { redditApifySource } from "./reddit-apify";
import { twitterSource } from "./twitter";
import { newsSource } from "./news";
import { instagramSource } from "./instagram";

/**
 * Reddit provider selection.
 *
 * Set REDDIT_PROVIDER=oauth | apify to force a specific provider. If unset,
 * we pick automatically: OAuth if its credentials are present, else Apify if
 * APIFY_TOKEN is present, else mark as unavailable.
 *
 * Why two providers: Reddit silently blocks app creation for new/unverified
 * accounts. Apify is the no-friction fallback — same data, ~$0.003 per result.
 */
function pickRedditSource(): Source {
  const forced = process.env.REDDIT_PROVIDER?.toLowerCase();
  if (forced === "oauth") return redditOauthSource;
  if (forced === "apify") return redditApifySource;

  // Auto: prefer OAuth (free), fall back to Apify (paid but reliable).
  if (redditOauthSource.available) return redditOauthSource;
  if (redditApifySource.available) return redditApifySource;

  // Neither available — return OAuth (its fetch will throw with a helpful message).
  return redditOauthSource;
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
