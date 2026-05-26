/**
 * Instagram source — STUB. Apify (apify/instagram-scraper) is the cleanest path
 * given Meta's official API restrictions. Map posts/comments to RawPost.
 */

import type { Source } from "../types";

export const instagramSource: Source = {
  id: "instagram",
  name: "Instagram",
  available: false,
  async fetch() {
    throw new Error("Instagram source not yet implemented");
  },
};
