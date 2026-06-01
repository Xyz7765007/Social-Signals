/**
 * Scan orchestrator.
 *
 * Pipeline:
 *   1. expanding         AI generates keywords + subreddits
 *   2. fetching          Sources pull posts
 *   3. fetching_comments (opt) pulls top comments for engaged posts
 *   4. dedup_seen        skip externalIds already seen on this campaign
 *   5. enriching         (opt) fetch + Claude-summarize author profiles
 *   6. scoring           Claude scores each item with anti-signals + author ctx
 *   7. drafting          (opt) reply drafts for signals ≥ 60
 *   8. pushing           (opt) HubSpot tasks for signals ≥ threshold
 *   9. complete
 *
 * Resilience model:
 *  - Each phase updates progress + scan.updatedAt so the UI can detect stalls
 *  - Non-fatal failures (one comment-fetch source down, one scoring batch
 *    malformed, HubSpot rate-limited) collect into scan.warnings; the scan
 *    keeps going with whatever it did get
 *  - Fatal failures (Anthropic auth, source unavailable, storage down) set
 *    scan.error and status=failed. The catch block's persist attempt is
 *    itself wrapped so a storage outage doesn't shadow the original error.
 */

import { randomUUID } from "crypto";
import { getSource } from "./sources";
import { storage } from "./storage";
import { expandScanInput, scorePosts, summarizeAuthors, draftRepliesForSignals } from "./scoring";
import { pushSignalsToHubspot } from "./integrations/hubspot";
import type {
  AuthorContext, RawPost, Scan, ScanInput, ScanProgress, Signal, SourceId,
} from "./types";

export function createScan(input: ScanInput): Scan {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    input,
    progress: { status: "queued", message: "Queued", fetched: 0, scored: 0, total: 0 },
    signals: [],
    warnings: [],
  };
}

export async function runScan(scanId: string): Promise<void> {
  const start = Date.now();
  const scan = await storage.get(scanId);
  if (!scan) throw new Error("Scan not found");
  if (!scan.warnings) scan.warnings = [];

  // Defensive: failures inside this fn must not leak past `runScan`. We catch,
  // mark failed, and try to persist — but if the persist itself fails, swallow
  // that secondary error so the primary cause is visible in logs.
  try {
    let totalCost = 0;
    const includeComments = scan.input.includeComments ?? true;
    const enrichAuthors = scan.input.enrichAuthors ?? true;
    const draftReplies = scan.input.draftReplies ?? true;
    const hubspotPushThreshold = scan.input.hubspotPushThreshold ?? 70;

    // ── 1. EXPAND ───────────────────────────────────────────────────────────
    await update(scan, { status: "expanding", message: "Generating keywords and subreddits" });
    const expansion = await expandScanInput(scan.input);
    if (!expansion.keywords.length) {
      throw new Error("No keywords produced. Add at least one in the Refine section, or rewrite your business description.");
    }
    scan.expansion = {
      keywords: expansion.keywords,
      subreddits: expansion.subreddits,
      rationale: expansion.rationale,
    };
    totalCost += expansion.costUsd;
    await safePut(scan);

    // ── 2. FETCH POSTS ──────────────────────────────────────────────────────
    await update(scan, { status: "fetching", message: `Searching ${scan.input.sources.join(", ")}` });
    const allPosts: RawPost[] = [];
    const sourceMap = new Map<SourceId, ReturnType<typeof getSource>>();
    let availableSourceCount = 0;
    for (const id of scan.input.sources) {
      const src = getSource(id as SourceId);
      if (!src.available) {
        scan.warnings.push(`Source ${id} not configured (skipped)`);
        continue;
      }
      availableSourceCount++;
      sourceMap.set(id as SourceId, src);
      try {
        const posts = await src.fetch({
          keywords: expansion.keywords,
          subreddits: id === "reddit" ? expansion.subreddits : undefined,
          timeWindow: scan.input.timeWindow,
          limit: scan.input.maxResults,
        });
        allPosts.push(...posts);
        await update(scan, {
          status: "fetching",
          message: `Pulled ${allPosts.length} from ${src.name}`,
          fetched: allPosts.length,
        });
      } catch (e: any) {
        // One source failing shouldn't kill a multi-source scan
        const msg = `${src.name} fetch failed: ${e?.message ?? e}`;
        scan.warnings.push(msg);
        console.warn(msg);
      }
    }
    if (availableSourceCount === 0) {
      throw new Error(
        `No sources available. Configure at least one of: REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET, or APIFY_TOKEN.`
      );
    }

    // Cross-source dedup
    const byId = new Set<string>();
    const posts: RawPost[] = [];
    for (const p of allPosts) {
      const k = `${p.sourceId}:${p.externalId}`;
      if (byId.has(k)) continue;
      byId.add(k); posts.push(p);
    }

    // ── 3. FETCH COMMENTS ───────────────────────────────────────────────────
    let comments: RawPost[] = [];
    if (includeComments && posts.length > 0) {
      await update(scan, {
        status: "fetching_comments",
        message: `Fetching top comments for engaged posts`,
        fetched: posts.length,
      });
      for (const [srcId, src] of sourceMap.entries()) {
        if (!src.fetchComments) continue;
        try {
          const cmnts = await src.fetchComments(posts, 3);
          comments.push(...cmnts);
        } catch (e: any) {
          const msg = `Comment fetch failed (${srcId}): ${e?.message ?? e}`;
          scan.warnings.push(msg);
          console.warn(msg);
        }
      }
      const cseen = new Set<string>();
      comments = comments.filter((c) => {
        if (cseen.has(c.externalId)) return false;
        cseen.add(c.externalId); return true;
      });
    }

    const allItems: RawPost[] = [...posts, ...comments];

    // ── 4. DEDUP SEEN ───────────────────────────────────────────────────────
    let deduped = allItems;
    let duplicateCount = 0;
    if (scan.input.campaignKey) {
      try {
        const seen = await storage.getSeen(scan.input.campaignKey);
        deduped = allItems.filter((p) => !seen.has(p.externalId));
        duplicateCount = allItems.length - deduped.length;
      } catch (e: any) {
        // Non-fatal — proceed with no dedup
        const msg = `Dedup lookup failed (continuing without dedup): ${e?.message ?? e}`;
        scan.warnings.push(msg);
        console.warn(msg);
      }
    }

    if (deduped.length === 0) {
      scan.signals = [];
      scan.stats = {
        rawCount: allItems.length, postCount: posts.length, commentCount: comments.length,
        dedupedCount: 0, scoredCount: 0, duplicateCount,
        durationMs: Date.now() - start, costUsd: totalCost, hubspotTasksCreated: 0,
      };
      scan.progress = {
        status: "complete",
        message: scan.input.campaignKey && duplicateCount > 0
          ? `Complete — all ${duplicateCount} matches already surfaced in earlier scans this campaign.`
          : "Complete — no matching items found. Try a broader time window or more keywords.",
        fetched: allItems.length, scored: 0, total: 0,
      };
      await safePut(scan);
      return;
    }

    // ── 5. ENRICH AUTHORS ───────────────────────────────────────────────────
    let authors: Record<string, AuthorContext> = {};
    if (enrichAuthors) {
      await update(scan, {
        status: "enriching",
        message: "Enriching author context",
        fetched: deduped.length, total: deduped.length,
      });
      for (const [srcId, src] of sourceMap.entries()) {
        if (!src.fetchAuthorContext) continue;
        try {
          const usernames = deduped.map((p) => p.author).filter(Boolean);
          const ctxRaw = await src.fetchAuthorContext(usernames);
          const { contexts, costUsd } = await summarizeAuthors(ctxRaw, scan.input);
          authors = { ...authors, ...contexts };
          totalCost += costUsd;
        } catch (e: any) {
          const msg = `Author enrichment failed (${srcId}, continuing without): ${e?.message ?? e}`;
          scan.warnings.push(msg);
          console.warn(msg);
        }
      }
    }

    // ── 6. SCORE ───────────────────────────────────────────────────────────
    await update(scan, {
      status: "scoring",
      message: `Scoring ${deduped.length} items`,
      fetched: deduped.length, total: deduped.length,
    });
    const { signals: scored, costUsd: scoreCost, warnings: scoreWarnings } = await scorePosts(
      scan.input, deduped, authors,
      async (done) => {
        await update(scan, {
          status: "scoring",
          message: `Scoring ${done} / ${deduped.length}`,
          fetched: deduped.length, scored: done, total: deduped.length,
        });
      },
    );
    totalCost += scoreCost;
    for (const w of scoreWarnings) scan.warnings.push(w);

    let finalSignals: Signal[] = scored.slice(0, scan.input.maxResults);

    // ── 7. DRAFT REPLIES ───────────────────────────────────────────────────
    if (draftReplies && finalSignals.length > 0) {
      const draftThreshold = 60;
      const draftTargets = finalSignals.filter((s) => s.score >= draftThreshold).length;
      if (draftTargets > 0) {
        await update(scan, {
          status: "drafting",
          message: `Drafting replies for ${draftTargets} high-score signals`,
          fetched: deduped.length, scored: deduped.length, total: deduped.length,
        });
        try {
          const { signals: withDrafts, costUsd: draftCost } = await draftRepliesForSignals(
            scan.input, finalSignals, draftThreshold,
            async (done, total) => {
              await update(scan, {
                status: "drafting",
                message: `Drafting replies ${done} / ${total}`,
                fetched: deduped.length, scored: deduped.length, total: deduped.length,
              });
            },
          );
          finalSignals = withDrafts;
          totalCost += draftCost;
        } catch (e: any) {
          const msg = `Reply drafting failed (continuing without drafts): ${e?.message ?? e}`;
          scan.warnings.push(msg);
          console.warn(msg);
        }
      }
    }

    // ── 8. HUBSPOT PUSH ────────────────────────────────────────────────────
    let hubspotTasksCreated = 0;
    if (scan.input.hubspotToken) {
      const pushTargets = finalSignals.filter((s) => s.score >= hubspotPushThreshold);
      if (pushTargets.length > 0) {
        await update(scan, {
          status: "pushing",
          message: `Pushing ${pushTargets.length} signals to HubSpot`,
          fetched: deduped.length, scored: deduped.length, total: deduped.length,
        });
        try {
          const r = await pushSignalsToHubspot(pushTargets, scan.input.hubspotToken, scan.input.hubspotOwnerId);
          hubspotTasksCreated = r.created;
          for (const sig of finalSignals) {
            if (r.taskIds[sig.externalId]) sig.hubspotTaskId = r.taskIds[sig.externalId];
          }
          if (r.failed > 0) {
            scan.warnings.push(`HubSpot push: ${r.failed} of ${pushTargets.length} tasks failed. First error: ${r.errors[0] ?? "unknown"}`);
          }
        } catch (e: any) {
          const msg = `HubSpot push failed (signals are still in Pulse): ${e?.message ?? e}`;
          scan.warnings.push(msg);
          console.warn(msg);
        }
      }
    }

    // Record seen for future dedup — best effort, don't fail scan if it fails
    if (scan.input.campaignKey) {
      try {
        await storage.addSeen(scan.input.campaignKey, deduped.map((p) => p.externalId));
      } catch (e: any) {
        const msg = `Couldn't record seen signals (dedup may miss next run): ${e?.message ?? e}`;
        scan.warnings.push(msg);
        console.warn(msg);
      }
    }

    scan.signals = finalSignals;
    scan.stats = {
      rawCount: allItems.length,
      postCount: posts.length,
      commentCount: comments.length,
      dedupedCount: deduped.length,
      scoredCount: scored.length,
      duplicateCount,
      durationMs: Date.now() - start,
      costUsd: totalCost,
      hubspotTasksCreated,
    };
    const warningSuffix = scan.warnings.length > 0 ? ` · ${scan.warnings.length} warning${scan.warnings.length === 1 ? "" : "s"}` : "";
    scan.progress = {
      status: "complete",
      message: `Found ${finalSignals.length} signal${finalSignals.length === 1 ? "" : "s"}${duplicateCount > 0 ? ` (skipped ${duplicateCount} already-seen)` : ""}${warningSuffix}`,
      fetched: deduped.length,
      scored: deduped.length,
      total: deduped.length,
    };
    await safePut(scan);
  } catch (err: any) {
    scan.error = sanitizeError(err);
    scan.progress = {
      status: "failed",
      message: scan.error,
      fetched: scan.progress.fetched,
      scored: scan.progress.scored,
      total: scan.progress.total,
    };
    scan.updatedAt = new Date().toISOString();
    // Persist the failure marker. If THIS fails, swallow so the original
    // error remains visible in server logs (don't shadow with storage error).
    try { await storage.put(scan); } catch (persistErr) {
      console.error(`Failed to persist failed scan ${scan.id}:`, persistErr);
    }
    // Don't rethrow — runScan is fire-and-forget. Caller already returned 201.
  }
}

function sanitizeError(err: any): string {
  const msg = err?.message ?? String(err);
  // Strip any API keys, tokens, or PII that might have leaked into the message.
  return msg
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-***")
    .replace(/pat[A-Za-z0-9_-]{14,}/g, "pat***")
    .replace(/apify_api_[A-Za-z0-9_-]+/g, "apify_***")
    .replace(/Bearer\s+[A-Za-z0-9_\-.]+/g, "Bearer ***")
    .slice(0, 1000);
}

async function update(scan: Scan, patch: Partial<ScanProgress> & { status: ScanProgress["status"] }) {
  scan.progress = { ...scan.progress, ...patch };
  scan.updatedAt = new Date().toISOString();
  await safePut(scan);
}

async function safePut(scan: Scan): Promise<void> {
  scan.updatedAt = new Date().toISOString();
  try {
    await storage.put(scan);
  } catch (e: any) {
    // A mid-scan storage hiccup shouldn't kill the in-flight work. The next
    // update will retry. Surface as a warning so the user sees it on completion.
    const msg = `Storage write failed (will retry next phase): ${e?.message ?? e}`;
    if (!scan.warnings) scan.warnings = [];
    if (!scan.warnings.includes(msg)) scan.warnings.push(msg);
    console.warn(msg);
  }
}
