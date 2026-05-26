/**
 * News source — STUB. NewsAPI / GDELT / GNews / Google News RSS are all candidates.
 * Map articles to RawPost (title, content=summary, url, createdAt=publishedAt).
 */

import type { Source } from "../types";

export const newsSource: Source = {
  id: "news",
  name: "News",
  available: false,
  async fetch() {
    throw new Error("News source not yet implemented");
  },
};
