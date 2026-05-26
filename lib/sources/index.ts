import type { Source, SourceId } from "../types";
import { redditSource } from "./reddit";
import { twitterSource } from "./twitter";
import { newsSource } from "./news";
import { instagramSource } from "./instagram";

export const SOURCES: Record<SourceId, Source> = {
  reddit: redditSource,
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
