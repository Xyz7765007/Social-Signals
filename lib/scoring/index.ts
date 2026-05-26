/**
 * AI layer.
 *
 * Two Claude calls per scan:
 *   1) `expand` — turn business description + ICP + signal types into
 *      (keywords, subreddits, rationale). Cheap, one-shot.
 *   2) `score`  — batch-score raw posts against the user's intent. Returns
 *      score (0–100), signalType, reasoning, suggestedAction per post.
 *
 * Why batching: each post is a few hundred tokens; one batched call per ~15
 * posts is ~50x cheaper and ~10x faster than per-post calls, and lets the
 * model see relative quality.
 *
 * Scoring rubric is strict on purpose. We want recall first (don't miss real
 * signal) and precision second (a few mid-score items is fine).
 */

import Anthropic from "@anthropic-ai/sdk";
import type { RawPost, ScanInput, Signal, SignalType } from "../types";
import { SIGNAL_TYPES, SIGNAL_TYPE_LABELS } from "../types";

// gpt-5.4-style cost note: Claude Sonnet 4.5 ≈ $3 in / $15 out per 1M tokens.
// We track approximate cost per scan in stats.costUsd.
const MODEL = "claude-sonnet-4-5";
const SCORING_BATCH_SIZE = 15;

const PRICING = {
  inputPerMTok: 3,
  outputPerMTok: 15,
};

function client(): Anthropic {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
  return new Anthropic({ apiKey: key });
}

function extractJson(text: string): any {
  // Be defensive about fenced code blocks or stray prose.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fence ? fence[1] : text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    // try to find the first { ... } or [ ... ] block
    const objMatch = candidate.match(/[\[{][\s\S]*[\]}]/);
    if (objMatch) return JSON.parse(objMatch[0]);
    throw new Error(`Could not parse JSON from model output: ${text.slice(0, 300)}`);
  }
}

// -------------------------------------------------------------------
// 1) EXPANSION
// -------------------------------------------------------------------

export interface Expansion {
  keywords: string[];
  subreddits: string[];
  rationale: string;
  costUsd: number;
}

export async function expandScanInput(input: ScanInput): Promise<Expansion> {
  // If user supplied both, skip the call entirely.
  if (input.keywords?.length && input.subreddits?.length) {
    return {
      keywords: input.keywords,
      subreddits: input.subreddits,
      rationale: "Used user-supplied keywords and subreddits.",
      costUsd: 0,
    };
  }

  const signalTypeList = input.signalTypes
    .map((t) => `- ${t}: ${SIGNAL_TYPE_LABELS[t]}`)
    .join("\n");

  const prompt = `You are a B2B outbound research analyst. Convert this business context into Reddit search parameters.

BUSINESS:
${input.businessDescription}

IDEAL CUSTOMER:
${input.icp}

SIGNAL TYPES TO FIND:
${signalTypeList}

USER-PROVIDED KEYWORDS: ${input.keywords?.join(", ") || "(none — generate them)"}
USER-PROVIDED SUBREDDITS: ${input.subreddits?.join(", ") || "(none — suggest them)"}

Generate:
1. KEYWORDS (6–12 short search phrases, 1–3 words each). Mix:
   - direct product category terms
   - pain-point language people use ("hate using X", "looking for alternative to Y")
   - buying-intent phrases ("recommendations for", "anyone use", "best tool for")
   - competitor names if relevant
   Avoid generic terms that return noise. Prefer specific over broad.

2. SUBREDDITS (6–15 subreddit names, no r/ prefix). Mix:
   - communities where the ICP hangs out (e.g. r/sales, r/startups)
   - topic-specific subs related to the problem space
   - location/industry subs if ICP is geo/vertical specific
   Avoid: huge default subs (askreddit, news) unless directly relevant.

3. RATIONALE (1–2 sentences explaining your picks).

Return ONLY valid JSON:
{"keywords": ["...", "..."], "subreddits": ["...", "..."], "rationale": "..."}`;

  const c = client();
  const res = await c.messages.create({
    model: MODEL,
    max_tokens: 1500,
    temperature: 0.3,
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = res.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text response from Claude during expansion");
  }
  const parsed = extractJson(textBlock.text);

  const merged = {
    keywords: dedupe([...(input.keywords ?? []), ...((parsed.keywords as string[]) ?? [])]),
    subreddits: dedupe([
      ...(input.subreddits ?? []),
      ...((parsed.subreddits as string[]) ?? []),
    ]).map(stripSubPrefix),
    rationale: String(parsed.rationale ?? ""),
    costUsd: estimateCost(res.usage),
  };

  return merged;
}

function dedupe(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of arr.map((s) => s.trim()).filter(Boolean)) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function stripSubPrefix(s: string): string {
  return s.replace(/^\/?r\//i, "").trim();
}

// -------------------------------------------------------------------
// 2) SCORING
// -------------------------------------------------------------------

export interface ScoringResult {
  signals: Signal[];
  costUsd: number;
}

interface ScoredItem {
  index: number;
  score: number;
  signalType: SignalType | "other";
  reasoning: string;
  suggestedAction: string;
}

export async function scorePosts(
  input: ScanInput,
  posts: RawPost[],
  onBatch?: (done: number) => void
): Promise<ScoringResult> {
  if (posts.length === 0) return { signals: [], costUsd: 0 };

  const batches = chunk(posts, SCORING_BATCH_SIZE);
  const allScored: ScoredItem[] = [];
  let cost = 0;

  let done = 0;
  for (const batch of batches) {
    const { scored, costUsd } = await scoreBatch(input, batch, done);
    allScored.push(...scored);
    cost += costUsd;
    done += batch.length;
    onBatch?.(done);
  }

  const signals: Signal[] = allScored
    .map((s) => {
      const post = posts[s.index];
      if (!post) return null;
      return {
        ...post,
        score: clamp(s.score, 0, 100),
        signalType: s.signalType,
        reasoning: s.reasoning,
        suggestedAction: s.suggestedAction,
      } as Signal;
    })
    .filter((x): x is Signal => x !== null)
    // Keep the threshold loose — UI handles filtering. We return everything ≥ 20.
    .filter((s) => s.score >= 20)
    .sort((a, b) => b.score - a.score);

  return { signals, costUsd: cost };
}

async function scoreBatch(
  input: ScanInput,
  batch: RawPost[],
  offset: number
): Promise<{ scored: ScoredItem[]; costUsd: number }> {
  const signalTypeList = SIGNAL_TYPES.map(
    (t) => `  - ${t}: ${SIGNAL_TYPE_LABELS[t]}`
  ).join("\n");

  const targetTypes = input.signalTypes.join(", ");

  const items = batch
    .map((p, i) => {
      const sub = p.metadata.subreddit ? `r/${p.metadata.subreddit}` : "";
      const meta = [
        sub,
        p.metadata.upvotes != null ? `${p.metadata.upvotes} upvotes` : "",
        p.metadata.comments != null ? `${p.metadata.comments} comments` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      const body = (p.content || "").slice(0, 1200);
      return `[POST ${offset + i}]
${meta}
Title: ${p.title ?? "(no title)"}
Body: ${body || "(no body — link or media post)"}`;
    })
    .join("\n\n---\n\n");

  const prompt = `You are an outbound signal analyst scoring Reddit posts for B2B relevance.

CUSTOMER BUSINESS:
${input.businessDescription}

CUSTOMER'S IDEAL CUSTOMER:
${input.icp}

SIGNAL TYPES THEY WANT (prioritize these):
${targetTypes}

ALL VALID SIGNAL TYPES:
${signalTypeList}
  - other: doesn't fit a specific type but is still relevant

SCORING RUBRIC (0–100):
  90–100: Crystal-clear high-intent signal. ICP fit obvious. Author has clear problem the customer solves. Comment-worthy NOW.
  70–89:  Strong signal. Likely ICP. Real pain or active research expressed.
  50–69:  Moderate signal. Adjacent ICP or general problem-space discussion, not high-urgency.
  30–49:  Tangential — same topic but unclear who/why or low intent.
  0–29:   Not relevant. Filter out.

HARD RULES:
- If the post is from a moderator, news bot, or megathread, score ≤ 30 unless content itself is a buyer signal.
- If author is asking on someone else's behalf (e.g. "asking for a friend"), still valid — score normally.
- Discount nostalgic / academic / hypothetical posts (≤ 40) unless they reveal active need.
- Be skeptical of vague positivity ("just love X tool!") — score ≤ 40.
- Reward specificity (named tools, named pain, named alternative-seeking).

SUGGESTED ACTION:
- One concise sentence. What should the customer do? Examples: "Reply with a soft intro mentioning your X feature", "Send a DM referencing the specific pain about Y", "Skip — too early, monitor author".

POSTS TO SCORE:
${items}

Return ONLY valid JSON, an array with one object per post in the same order, using the absolute post indices shown:

[
  {"index": ${offset}, "score": 0, "signalType": "pain_point", "reasoning": "1 sentence why this score", "suggestedAction": "1 sentence"},
  ...
]`;

  const c = client();
  const res = await c.messages.create({
    model: MODEL,
    max_tokens: 4000,
    temperature: 0,
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = res.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text response from Claude during scoring");
  }
  const parsed = extractJson(textBlock.text);
  if (!Array.isArray(parsed)) {
    throw new Error("Scoring response was not an array");
  }

  const scored: ScoredItem[] = parsed
    .filter((x: any) => typeof x?.index === "number")
    .map((x: any) => ({
      index: x.index,
      score: typeof x.score === "number" ? x.score : 0,
      signalType: isSignalType(x.signalType) ? x.signalType : "other",
      reasoning: String(x.reasoning ?? "").slice(0, 400),
      suggestedAction: String(x.suggestedAction ?? "").slice(0, 300),
    }));

  return { scored, costUsd: estimateCost(res.usage) };
}

function isSignalType(s: any): s is SignalType {
  return typeof s === "string" && SIGNAL_TYPES.includes(s as SignalType);
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function estimateCost(usage: { input_tokens: number; output_tokens: number } | undefined): number {
  if (!usage) return 0;
  return (
    (usage.input_tokens * PRICING.inputPerMTok) / 1_000_000 +
    (usage.output_tokens * PRICING.outputPerMTok) / 1_000_000
  );
}
