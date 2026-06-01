/**
 * AI layer.
 *
 * Three Claude calls per scan:
 *   1) expand   — keywords + subreddits from business desc + ICP
 *   2) score    — batch grade posts and comments with anti-signal awareness
 *                 and (optionally) author-context adjustments
 *   3) draft    — per high-scoring signal, write a reply in the client's voice
 *
 * Models (May 2026):
 *   claude-opus-4-7              $5 / $25 per MTok
 *   claude-sonnet-4-6            $3 / $15 per MTok   ← used for all three
 *   claude-haiku-4-5-20251001    $1 / $5 per MTok
 *
 * Cost knobs in PRICING; switch MODEL_DRAFT to Haiku to save on drafts.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  AuthorContext, RawPost, ScanInput, Signal, SignalType,
} from "../types";
import { SIGNAL_TYPES, SIGNAL_TYPE_LABELS } from "../types";

const MODEL_SCORING = "claude-sonnet-4-6";
const MODEL_EXPANSION = "claude-sonnet-4-6";
const MODEL_DRAFT = "claude-sonnet-4-6";
const MODEL_AUTHOR_SUMMARY = "claude-haiku-4-5-20251001";

const SCORING_BATCH_SIZE = 12; // smaller batch since prompts are larger now
const DRAFT_BATCH_SIZE = 1;    // drafts are one-shot per signal for quality

const PRICING: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
  "claude-opus-4-7": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku-4-5-20251001": { inputPerMTok: 1, outputPerMTok: 5 },
};

function client(): Anthropic {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
  return new Anthropic({ apiKey: key });
}

function extractJson(text: string): any {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fence ? fence[1] : text).trim();
  try { return JSON.parse(candidate); }
  catch {
    const m = candidate.match(/[\[{][\s\S]*[\]}]/);
    if (m) return JSON.parse(m[0]);
    throw new Error(`Could not parse JSON from model output: ${text.slice(0, 300)}`);
  }
}

function estimateCost(model: string, usage: { input_tokens: number; output_tokens: number } | undefined): number {
  if (!usage) return 0;
  const p = PRICING[model];
  if (!p) return 0;
  return (usage.input_tokens * p.inputPerMTok) / 1_000_000
       + (usage.output_tokens * p.outputPerMTok) / 1_000_000;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// 1) EXPANSION
// ───────────────────────────────────────────────────────────────────────────

export interface Expansion {
  keywords: string[];
  subreddits: string[];
  rationale: string;
  costUsd: number;
}

export async function expandScanInput(input: ScanInput): Promise<Expansion> {
  if (input.keywords?.length && input.subreddits?.length) {
    return {
      keywords: input.keywords,
      subreddits: input.subreddits,
      rationale: "Used user-supplied keywords and subreddits.",
      costUsd: 0,
    };
  }

  const signalTypeList = input.signalTypes.map((t) => `- ${t}: ${SIGNAL_TYPE_LABELS[t]}`).join("\n");
  const antiSignalsLine = input.antiSignals?.length
    ? `\nAVOID THESE TOPICS as keywords (they pull noise, not buying intent):\n${input.antiSignals.map((s) => `- ${s}`).join("\n")}`
    : "";

  const prompt = `You are a B2B outbound research analyst. Convert this business context into Reddit search parameters.

BUSINESS:
${input.businessDescription}

IDEAL CUSTOMER:
${input.icp}

SIGNAL TYPES TO FIND:
${signalTypeList}
${antiSignalsLine}

USER-PROVIDED KEYWORDS: ${input.keywords?.join(", ") || "(none — generate them)"}
USER-PROVIDED SUBREDDITS: ${input.subreddits?.join(", ") || "(none — suggest them)"}

Generate:
1. KEYWORDS (6–12 short search phrases, 1–3 words each). Mix product category terms, pain-point phrases, buying-intent phrases ("recommendations for", "anyone use"), and competitor names if relevant. Do NOT include any terms from the AVOID list above.
2. SUBREDDITS (6–15 subreddit names, no r/ prefix). Communities where the ICP hangs out. Avoid huge default subs unless directly relevant.
3. RATIONALE (1–2 sentences).

Return ONLY valid JSON:
{"keywords": ["..."], "subreddits": ["..."], "rationale": "..."}`;

  const c = client();
  const res = await c.messages.create({
    model: MODEL_EXPANSION, max_tokens: 1500, temperature: 0.3,
    messages: [{ role: "user", content: prompt }],
  });
  const tb = res.content.find((b) => b.type === "text");
  if (!tb || tb.type !== "text") throw new Error("No text response from Claude during expansion");
  const parsed = extractJson(tb.text);
  return {
    keywords: dedupe([...(input.keywords ?? []), ...((parsed.keywords as string[]) ?? [])]),
    subreddits: dedupe([...(input.subreddits ?? []), ...((parsed.subreddits as string[]) ?? [])]).map(stripSubPrefix),
    rationale: String(parsed.rationale ?? ""),
    costUsd: estimateCost(MODEL_EXPANSION, res.usage),
  };
}

function dedupe(arr: string[]): string[] {
  const seen = new Set<string>(); const out: string[] = [];
  for (const item of arr.map((s) => s.trim()).filter(Boolean)) {
    const k = item.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k); out.push(item);
  }
  return out;
}
function stripSubPrefix(s: string): string { return s.replace(/^\/?r\//i, "").trim(); }

// ───────────────────────────────────────────────────────────────────────────
// 2) AUTHOR SUMMARIES (Haiku — cheap, in bulk)
// ───────────────────────────────────────────────────────────────────────────

export async function summarizeAuthors(
  contexts: Record<string, AuthorContext>,
  input: ScanInput,
): Promise<{ contexts: Record<string, AuthorContext>; costUsd: number }> {
  const entries = Object.values(contexts).filter((c) => c.recentSubreddits.length > 0);
  if (entries.length === 0) return { contexts, costUsd: 0 };

  const prompt = `You are screening Reddit authors for a B2B outbound team.

CUSTOMER BUSINESS:
${input.businessDescription}

IDEAL CUSTOMER:
${input.icp}

For each author below, based on the subreddits they recently posted in:
1. Write a 1-sentence read on who they likely are.
2. Give a signalAdjustment: how much to adjust a signal score by, on -20 to +20 scale.
   +10 to +20: clearly looks like the customer's ICP
   +1 to +9:   adjacent / possibly ICP
   0:          neutral / not enough info
   -1 to -9:   probably not ICP
   -10 to -20: clearly not ICP (e.g. bot, hobbyist account, journalist, AskReddit power user)

AUTHORS:
${entries.map((a) => `[${a.username}] recent subreddits: ${a.recentSubreddits.join(", ")} (${a.recentPostCount} posts)`).join("\n")}

Return ONLY valid JSON:
[{"username":"...","summary":"...","signalAdjustment": 0}, ...]`;

  const c = client();
  const res = await c.messages.create({
    model: MODEL_AUTHOR_SUMMARY, max_tokens: 2000, temperature: 0,
    messages: [{ role: "user", content: prompt }],
  });
  const tb = res.content.find((b) => b.type === "text");
  if (!tb || tb.type !== "text") return { contexts, costUsd: estimateCost(MODEL_AUTHOR_SUMMARY, res.usage) };
  let parsed: any[];
  try { parsed = extractJson(tb.text); } catch { return { contexts, costUsd: estimateCost(MODEL_AUTHOR_SUMMARY, res.usage) }; }
  if (!Array.isArray(parsed)) return { contexts, costUsd: estimateCost(MODEL_AUTHOR_SUMMARY, res.usage) };

  const out = { ...contexts };
  for (const row of parsed) {
    const u = String(row?.username ?? "");
    if (!out[u]) continue;
    out[u] = {
      ...out[u],
      summary: String(row.summary ?? "").slice(0, 200),
      signalAdjustment: clamp(Number(row.signalAdjustment ?? 0), -20, 20),
    };
  }
  return { contexts: out, costUsd: estimateCost(MODEL_AUTHOR_SUMMARY, res.usage) };
}

// ───────────────────────────────────────────────────────────────────────────
// 3) SCORING
// ───────────────────────────────────────────────────────────────────────────

export interface ScoringResult { signals: Signal[]; costUsd: number; warnings: string[]; }
interface ScoredItem {
  index: number; score: number; signalType: SignalType | "other";
  reasoning: string; suggestedAction: string;
}

export async function scorePosts(
  input: ScanInput,
  posts: RawPost[],
  authors: Record<string, AuthorContext>,
  onBatch?: (done: number) => void,
): Promise<ScoringResult> {
  if (posts.length === 0) return { signals: [], costUsd: 0, warnings: [] };

  const batches = chunk(posts, SCORING_BATCH_SIZE);
  const allScored: ScoredItem[] = [];
  const warnings: string[] = [];
  let cost = 0;
  let done = 0;
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    try {
      const { scored, costUsd } = await scoreBatch(input, batch, done, authors);
      allScored.push(...scored);
      cost += costUsd;
    } catch (e: any) {
      // One bad batch shouldn't kill the whole scan. Log and continue —
      // those items just won't appear in the results.
      warnings.push(`Scoring batch ${i + 1}/${batches.length} failed (${batch.length} items skipped): ${e?.message ?? e}`);
    }
    done += batch.length;
    onBatch?.(done);
  }

  const signals: Signal[] = allScored
    .map((s) => {
      const post = posts[s.index];
      if (!post) return null;
      const ac = authors[post.author];
      const adj = ac?.signalAdjustment ?? 0;
      const finalScore = clamp(s.score + adj, 0, 100);
      return {
        ...post,
        score: finalScore,
        signalType: s.signalType,
        reasoning: s.reasoning,
        suggestedAction: s.suggestedAction,
        authorContext: ac,
      } as Signal;
    })
    .filter((x): x is Signal => x !== null)
    .filter((s) => s.score >= 20)
    .sort((a, b) => b.score - a.score);

  return { signals, costUsd: cost, warnings };
}

async function scoreBatch(
  input: ScanInput, batch: RawPost[], offset: number, authors: Record<string, AuthorContext>,
): Promise<{ scored: ScoredItem[]; costUsd: number }> {
  const signalTypeList = SIGNAL_TYPES.map((t) => `  - ${t}: ${SIGNAL_TYPE_LABELS[t]}`).join("\n");
  const targetTypes = input.signalTypes.join(", ");

  const antiSignalsBlock = input.antiSignals?.length
    ? `\nANTI-SIGNALS — these terms LOOK relevant but typically aren't real buying intent for this customer:
${input.antiSignals.map((s) => `  - ${s}`).join("\n")}
If a post is primarily ABOUT one of these without expressing buying intent for the customer's actual product, score ≤ 30.\n`
    : "";

  const items = batch.map((p, i) => {
    const sub = p.metadata.subreddit ? `r/${p.metadata.subreddit}` : "";
    const meta = [
      sub,
      p.metadata.upvotes != null ? `${p.metadata.upvotes} upvotes` : "",
      p.metadata.comments != null ? `${p.metadata.comments} comments` : "",
      p.isComment ? "TYPE: comment" : "TYPE: post",
    ].filter(Boolean).join(" · ");
    const parent = p.isComment && p.metadata.parentTitle
      ? `\nThis is a comment under post: "${p.metadata.parentTitle}"`
      : "";
    const ac = authors[p.author];
    const authorLine = ac?.summary
      ? `\nAuthor read: ${ac.summary} (recent subs: ${ac.recentSubreddits.slice(0, 5).join(", ")})`
      : "";
    const body = (p.content || "").slice(0, 1200);
    const title = p.title ? `Title: ${p.title}` : "(no title — comment)";
    return `[POST ${offset + i}]
${meta}${parent}${authorLine}
${title}
Body: ${body || "(no body)"}`;
  }).join("\n\n---\n\n");

  const prompt = `You are an outbound signal analyst scoring Reddit posts and comments for B2B relevance.

CUSTOMER BUSINESS:
${input.businessDescription}

CUSTOMER'S IDEAL CUSTOMER:
${input.icp}

SIGNAL TYPES THEY WANT (prioritize these):
${targetTypes}

ALL VALID SIGNAL TYPES:
${signalTypeList}
  - other: doesn't fit a specific type but is still relevant
${antiSignalsBlock}
SCORING RUBRIC (0–100):
  90–100: Crystal-clear high-intent signal. ICP fit obvious. Author has clear problem the customer solves. Comment-worthy NOW.
  70–89:  Strong signal. Likely ICP. Real pain or active research expressed.
  50–69:  Moderate signal. Adjacent ICP or general problem-space discussion, not high-urgency.
  30–49:  Tangential — same topic but unclear who/why or low intent.
  0–29:   Not relevant. Filter out.

HARD RULES:
- Moderator / news bot / megathread → score ≤ 30 unless content itself is a buyer signal.
- "Asking for a friend" — still valid, score normally.
- Nostalgic / academic / hypothetical → ≤ 40 unless reveals active need.
- Vague positivity ("just love X tool!") → ≤ 40.
- Reward specificity (named tools, named pain, alternative-seeking).
- For COMMENTS: score the comment's content, but if its content depends on its parent post's context, take parent into account.

SUGGESTED ACTION: One concise sentence. e.g. "Reply with a soft intro mentioning your X feature", "DM referencing the pain about Y", "Skip — too early".

POSTS TO SCORE:
${items}

Return ONLY valid JSON, an array with one object per post in the same order, using the absolute post indices shown:
[{"index": ${offset}, "score": 0, "signalType": "pain_point", "reasoning": "1 sentence", "suggestedAction": "1 sentence"}, ...]`;

  const c = client();
  const res = await c.messages.create({
    model: MODEL_SCORING, max_tokens: 4000, temperature: 0,
    messages: [{ role: "user", content: prompt }],
  });
  const tb = res.content.find((b) => b.type === "text");
  if (!tb || tb.type !== "text") throw new Error("No text response from Claude during scoring");
  const parsed = extractJson(tb.text);
  if (!Array.isArray(parsed)) throw new Error("Scoring response was not an array");

  const scored: ScoredItem[] = parsed
    .filter((x: any) => typeof x?.index === "number" && Number.isFinite(x.index))
    .filter((x: any) => x.index >= offset && x.index < offset + batch.length)
    .map((x: any) => ({
      index: x.index,
      // Clamp score in case model returns out-of-range. The author-adjustment
      // step clamps again, but doing it here means a bad raw score (-50, 150)
      // can't poison the downstream sort.
      score: clamp(typeof x.score === "number" && Number.isFinite(x.score) ? x.score : 0, 0, 100),
      signalType: isSignalType(x.signalType) ? x.signalType : "other",
      reasoning: String(x.reasoning ?? "").slice(0, 400),
      suggestedAction: String(x.suggestedAction ?? "").slice(0, 300),
    }));
  return { scored, costUsd: estimateCost(MODEL_SCORING, res.usage) };
}

function isSignalType(s: any): s is SignalType { return typeof s === "string" && SIGNAL_TYPES.includes(s as SignalType); }
function clamp(n: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, n)); }

// ───────────────────────────────────────────────────────────────────────────
// 4) REPLY DRAFTER
// ───────────────────────────────────────────────────────────────────────────

export async function draftReply(
  input: ScanInput,
  signal: Signal,
): Promise<{ draft: string; costUsd: number }> {
  const voice = (input.voice ?? "").trim();
  const voiceBlock = voice
    ? `BRAND VOICE TO MATCH:\n${voice}\n`
    : `BRAND VOICE: Default to a low-key, peer-to-peer tone. NEVER salesy. Reddit penalizes anything that sounds like marketing copy.\n`;

  const parent = signal.isComment && signal.metadata.parentTitle
    ? `\nThis is replying to a COMMENT under the post "${signal.metadata.parentTitle}". Make sure the reply makes sense in that thread context.`
    : "";

  const prompt = `You are drafting a Reddit reply for a B2B outbound team. The reply will be posted publicly under the author's post or comment.

CUSTOMER BUSINESS:
${input.businessDescription}

${voiceBlock}
THE POST/COMMENT TO REPLY TO:
Subreddit: r/${signal.metadata.subreddit ?? "unknown"}
Author: u/${signal.author}
${signal.title ? `Title: ${signal.title}` : ""}
Body: ${(signal.content || "").slice(0, 1500)}
${parent}

WHY THIS WAS SURFACED:
${signal.reasoning}

WRITE A REPLY THAT:
- Sounds like a real human on Reddit, not marketing.
- 2–4 short sentences. Long replies get downvoted.
- Acknowledges the specific thing they said. Don't generic-respond.
- Only mention the product/company by name if it's genuinely the answer to their question. When unsure, skip the name and just be helpful.
- Never use phrases like "I'd love to help" / "feel free to reach out" / "we offer" / "check out our".
- Never use emojis.
- Never use AI tells: "great question", "excellent point", em-dashes used like asides, "—", "delve", "navigate".
- If a soft self-mention is appropriate, phrase as "we built X to solve exactly this — happy to share notes if useful" or similar.
- If the post is too early-stage or off-topic for a reply, output: "[SKIP] — reason"

Return ONLY the reply text (no quotes, no preamble, no JSON).`;

  const c = client();
  const res = await c.messages.create({
    model: MODEL_DRAFT, max_tokens: 600, temperature: 0.5,
    messages: [{ role: "user", content: prompt }],
  });
  const tb = res.content.find((b) => b.type === "text");
  const draft = tb && tb.type === "text" ? tb.text.trim() : "";
  return { draft, costUsd: estimateCost(MODEL_DRAFT, res.usage) };
}

export async function draftRepliesForSignals(
  input: ScanInput,
  signals: Signal[],
  threshold: number,
  onEach?: (done: number, total: number) => void,
): Promise<{ signals: Signal[]; costUsd: number }> {
  const targets = signals.filter((s) => s.score >= threshold);
  let cost = 0;
  // Run drafts in parallel batches of 4
  const result: Signal[] = signals.slice();
  let done = 0;
  for (const batch of chunk(targets, 4)) {
    const drafts = await Promise.all(batch.map((s) => draftReply(input, s).catch(() => ({ draft: "", costUsd: 0 }))));
    for (let i = 0; i < batch.length; i++) {
      const sig = batch[i];
      const d = drafts[i];
      cost += d.costUsd;
      const idx = result.findIndex((x) => x.externalId === sig.externalId);
      if (idx >= 0) result[idx] = { ...result[idx], replyDraft: d.draft };
      done++;
      onEach?.(done, targets.length);
    }
  }
  return { signals: result, costUsd: cost };
}

export { DRAFT_BATCH_SIZE };
