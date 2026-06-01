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
  keywords?: string[];
  subreddits?: string[];
  timeWindow: TimeWindow;
  maxResults: number;
  sources: SourceId[];

  // ─── Phase 2 additions ────────────────────────────────────────────────────
  /** Terms that look adjacent but aren't real buying signal — scoring prompt
   *  actively downweights matches mentioning these without intent. */
  antiSignals?: string[];

  /** When two scans share a campaignKey, the second skips posts/comments that
   *  earlier scans already surfaced. Enables clean weekly cadence. */
  campaignKey?: string;

  /** Free-text voice/tone guide used by the reply drafter. */
  voice?: string;

  /** Generate a reply draft for each high-scoring signal. */
  draftReplies?: boolean;

  /** Include top comments of matched posts in scoring. */
  includeComments?: boolean;

  /** Fetch author profile context for each post and use it in scoring. */
  enrichAuthors?: boolean;

  /** HubSpot push — optional. */
  hubspotToken?: string;
  hubspotOwnerId?: string;
  hubspotPushThreshold?: number; // default 70
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
  createdAt: string;
  metadata: Record<string, any>;
  /** When true, this RawPost is a comment under another post. */
  isComment?: boolean;
}

export interface AuthorContext {
  username: string;
  recentPostCount: number;
  recentSubreddits: string[];
  summary: string;
  signalAdjustment: number;
}

export interface Signal extends RawPost {
  score: number;
  reasoning: string;
  signalType: SignalType | "other";
  suggestedAction: string;
  replyDraft?: string;
  authorContext?: AuthorContext;
  isComment?: boolean;
  isDuplicate?: boolean;
  hubspotTaskId?: string;
}

export type ScanStatus =
  | "queued"
  | "expanding"
  | "fetching"
  | "fetching_comments"
  | "enriching"
  | "scoring"
  | "drafting"
  | "pushing"
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
    postCount: number;
    commentCount: number;
    dedupedCount: number;
    scoredCount: number;
    duplicateCount: number;
    durationMs: number;
    costUsd: number;
    hubspotTasksCreated: number;
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
  fetchComments?(posts: RawPost[], maxPerPost: number): Promise<RawPost[]>;
  fetchAuthorContext?(usernames: string[]): Promise<Record<string, AuthorContext>>;
}
