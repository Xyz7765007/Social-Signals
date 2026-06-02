// Stub — implement when ready. See reddit-oauth.ts for the pattern.
import type { Source } from "../types";

export const twitterSource: Source = {
  id: "twitter",
  name: "Twitter",
  available: false,
  async fetch() { return { items: [], costUsd: 0 }; },
};
