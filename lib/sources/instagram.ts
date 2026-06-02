// Stub — implement when ready. See reddit-oauth.ts for the pattern.
import type { Source } from "../types";

export const instagramSource: Source = {
  id: "instagram",
  name: "Instagram",
  available: false,
  async fetch() { return { items: [], costUsd: 0 }; },
};
