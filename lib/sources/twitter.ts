/**
 * Twitter/X source — STUB. Same Source interface; plug in when ready.
 *
 * Recommended path: official X API v2 with `recent search` (last 7 days, free
 * tier limited) or Apify's apidojo/tweet-scraper for broader history.
 * Map tweets to RawPost the same way we do for Reddit.
 */

import type { Source } from "../types";

export const twitterSource: Source = {
  id: "twitter",
  name: "Twitter / X",
  available: false, // flip when TWITTER_BEARER_TOKEN or APIFY_TWITTER_ACTOR_ID is wired
  async fetch() {
    throw new Error("Twitter source not yet implemented");
  },
};
