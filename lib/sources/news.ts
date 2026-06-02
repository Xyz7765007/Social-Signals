// Stub — implement when ready. See reddit-oauth.ts for the pattern.
import type { Source } from "../types";

export const newsSource: Source = {
  id: "news",
  name: "News",
  available: false,
  async fetch() { return { items: [], costUsd: 0 }; },
};
