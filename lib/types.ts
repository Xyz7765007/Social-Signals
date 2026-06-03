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

/**
 * Saved scan setup. Lets users (Kunal, team) save a named scan config and
 * reload it on the form rather than re-pasting business description, ICP,
 * keywords, subreddits etc. every time. Common pattern: per-client preset
 * ("Osome SG", "Osome HK") + per-campaign-stage variant.
 *
 * Stored separately from Scan records — presets are templates, scans are runs.
 */
export interface ScanPreset {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** The full scan config, ready to apply to the form. campaignKey, hubspot
   *  token, etc. are all included — user can override per-run on the form. */
  input: ScanInput;
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

/** Per-phase cost breakdown in USD. Sum equals stats.costUsd. */
export interface CostBreakdown {
  // Anthropic — by phase
  expansion: number;
  scoring: number;
  drafting: number;
  authorSummary: number;
  // Data providers
  apify: number;
  // Future: twitterApi, newsApi, etc.
  total: number;
}

export interface Scan {
  id: string;
  createdAt: string;
  /** Updated on every progress write. Lets the UI detect stalled scans. */
  updatedAt: string;
  input: ScanInput;
  expansion?: {
    keywords: string[];
    subreddits: string[];
    rationale: string;
  };
  progress: ScanProgress;
  signals: Signal[];
  /** Fatal error message — set when status === "failed". */
  error?: string;
  /** Non-fatal warnings collected during the scan (rate limits, partial
   *  failures, HubSpot push errors, etc). The scan can still complete with
   *  warnings — they're surfaced to the user but don't block. */
  warnings?: string[];
  stats?: {
    rawCount: number;
    postCount: number;
    commentCount: number;
    dedupedCount: number;
    scoredCount: number;
    duplicateCount: number;
    durationMs: number;
    /** Sum of all phase costs. Equals stats.costs.total when present. */
    costUsd: number;
    /** Detailed per-phase breakdown. Optional for backward-compat with old scans. */
    costs?: CostBreakdown;
    hubspotTasksCreated: number;
  };
}

export interface SourceFetchResult {
  items: RawPost[];
  /** USD spent on this fetch call (data provider only — Anthropic costs are
   *  tracked separately in the scoring layer). Free providers return 0. */
  costUsd: number;
}

export interface SourceAuthorContextResult {
  contexts: Record<string, AuthorContext>;
  costUsd: number;
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
  }): Promise<SourceFetchResult>;
  /** Optional — pull top comments for given posts. Sources that don't support
   *  this can omit; orchestrator handles `undefined` gracefully. */
  fetchComments?(posts: RawPost[], maxPerPost: number): Promise<SourceFetchResult>;
  /** Optional — fetch a quick author profile. */
  fetchAuthorContext?(usernames: string[]): Promise<SourceAuthorContextResult>;
}
