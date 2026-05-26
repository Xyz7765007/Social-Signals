// Core domain types. Keep source-agnostic — Reddit-specific data goes in `metadata`.

export type SourceId = "reddit" | "twitter" | "news" | "instagram";

export type TimeWindow = "hour" | "day" | "week" | "month";

export const SIGNAL_TYPES = [
  "pain_point",
  "buying_intent",
  "competitor_mention",
  "recommendation_request",
  "product_question",
  "complaint",
  "switching_intent",
] as const;
export type SignalType = (typeof SIGNAL_TYPES)[number];

export const SIGNAL_TYPE_LABELS: Record<SignalType, string> = {
  pain_point: "Pain point",
  buying_intent: "Buying intent",
  competitor_mention: "Competitor mention",
  recommendation_request: "Asking for recommendations",
  product_question: "Product question",
  complaint: "Complaint about existing solution",
  switching_intent: "Switching from current tool",
};

export interface ScanInput {
  businessDescription: string;
  icp: string;
  signalTypes: SignalType[];
  keywords?: string[];          // optional — AI generates if omitted
  subreddits?: string[];        // optional — AI suggests if omitted
  timeWindow: TimeWindow;
  maxResults: number;           // 10 | 25 | 50 | 100
  sources: SourceId[];          // ["reddit"] for now
}

export interface RawPost {
  sourceId: SourceId;
  externalId: string;
  url: string;
  permalink: string;
  author: string;
  authorUrl?: string;
  title?: string;
  content: string;
  createdAt: string;            // ISO
  metadata: Record<string, any>;
}

export interface Signal extends RawPost {
  score: number;                // 0–100
  reasoning: string;            // why this matches
  signalType: SignalType | "other";
  suggestedAction: string;      // what to do about it
}

export type ScanStatus =
  | "queued"
  | "expanding"      // AI generating keywords/subreddits
  | "fetching"       // pulling from sources
  | "scoring"        // Claude scoring
  | "complete"
  | "failed";

export interface ScanProgress {
  status: ScanStatus;
  message: string;
  fetched: number;
  scored: number;
  total: number;
}

export interface Scan {
  id: string;
  createdAt: string;
  input: ScanInput;
  expansion?: {
    keywords: string[];
    subreddits: string[];
    rationale: string;
  };
  progress: ScanProgress;
  signals: Signal[];
  error?: string;
  stats?: {
    rawCount: number;
    dedupedCount: number;
    scoredCount: number;
    durationMs: number;
    costUsd: number;
  };
}

export interface Source {
  id: SourceId;
  name: string;
  available: boolean;
  fetch(params: {
    keywords: string[];
    subreddits?: string[];
    timeWindow: TimeWindow;
    limit: number;
  }): Promise<RawPost[]>;
}
