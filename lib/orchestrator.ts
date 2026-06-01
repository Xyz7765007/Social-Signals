/**
 * Scan orchestrator.
 *
 * Pipeline:
 *   1. expanding         AI generates keywords + subreddits
 *   2. fetching          Sources pull posts
 *   3. fetching_comments (if includeComments) pulls top comments for engaged posts
 *   4. dedup_seen        skip externalIds already seen on this campaign
 *   5. enriching         (if enrichAuthors) fetch + Claude-summarize author profiles
 *   6. scoring           Claude scores each item with anti-signals + author context
 *   7. drafting          (if draftReplies) generate reply drafts for high scorers
 *   8. pushing           (if hubspotToken) create HubSpot tasks for high scorers
 *   9. complete
 *
 * Each phase persists progress so the UI can poll.
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
  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    input,
    progress: { status: "queued", message: "Queued", fetched: 0, scored: 0, total: 0 },
    signals: [],
  };
}

export async function runScan(scanId: string): Promise<void> {
  const start = Date.now();
  const scan = await storage.get(scanId);
  if (!scan) throw new Error("Scan not found");

  try {
    let totalCost = 0;
    const includeComments = scan.input.includeComments ?? true;
    const enrichAuthors = scan.input.enrichAuthors ?? true;
    const draftReplies = scan.input.draftReplies ?? true;
    const hubspotPushThreshold = scan.input.hubspotPushThreshold ?? 70;

    // 1. EXPAND ─────────────────────────────────────────────────────────────
    await update(scan, { status: "expanding", message: "Generating keywords and subreddits" });
    const expansion = await expandScanInput(scan.input);
    scan.expansion = {
      keywords: expansion.keywords,
      subreddits: expansion.subreddits,
      rationale: expansion.rationale,
    };
    totalCost += expansion.costUsd;
    await storage.put(scan);

    // 2. FETCH POSTS ────────────────────────────────────────────────────────
    await update(scan, { status: "fetching", message: `Searching ${scan.input.sources.join(", ")}` });
    const allPosts: RawPost[] = [];
    const sourceMap = new Map<SourceId, ReturnType<typeof getSource>>();
    for (const id of scan.input.sources) {
      const src = getSource(id as SourceId);
      if (!src.available) continue;
      sourceMap.set(id as SourceId, src);
      const posts = await src.fetch({
        keywords: expansion.keywords,
        subreddits: id === "reddit" ? expansion.subreddits : undefined,
        timeWindow: scan.input.timeWindow,
        limit: scan.input.maxResults,
      });
      allPosts.push(...posts);
      await update(scan, { status: "fetching", message: `Pulled ${allPosts.length} from ${src.name}`, fetched: allPosts.length });
    }

    // Cross-source dedup
    const byId = new Set<string>();
    const posts: RawPost[] = [];
    for (const p of allPosts) {
      const k = `${p.sourceId}:${p.externalId}`;
      if (byId.has(k)) continue;
      byId.add(k); posts.push(p);
    }

    // 3. FETCH COMMENTS ─────────────────────────────────────────────────────
    let comments: RawPost[] = [];
    if (includeComments) {
      await update(scan, {
        status: "fetching_comments",
        message: `Fetching top comments for ${Math.min(25, posts.length)} engaged posts`,
        fetched: posts.length,
      });
      for (const src of sourceMap.values()) {
        if (!src.fetchComments) continue;
        try {
          const cmnts = await src.fetchComments(posts, 3);
          comments.push(...cmnts);
        } catch (e) {
          console.warn("Comment fetch failed", e);
        }
      }
      // Dedup comments
      const cseen = new Set<string>();
      comments = comments.filter((c) => {
        if (cseen.has(c.externalId)) return false;
        cseen.add(c.externalId); return true;
      });
    }

    const allItems: RawPost[] = [...posts, ...comments];

    // 4. DEDUP SEEN ─────────────────────────────────────────────────────────
    let preDedupCount = allItems.length;
    let deduped = allItems;
    let duplicateCount = 0;
    if (scan.input.campaignKey) {
      const seen = await storage.getSeen(scan.input.campaignKey);
      deduped = allItems.filter((p) => !seen.has(p.externalId));
      duplicateCount = allItems.length - deduped.length;
    }

    if (deduped.length === 0) {
      scan.signals = [];
      scan.progress = {
        status: "complete",
        message: scan.input.campaignKey && duplicateCount > 0
          ? `Search complete — all ${duplicateCount} matches already surfaced in earlier scans this campaign.`
          : "Search complete — no matching items found. Try a broader time window or more keywords.",
        fetched: preDedupCount, scored: 0, total: 0,
      };
      scan.stats = {
        rawCount: allItems.length, postCount: posts.length, commentCount: comments.length,
        dedupedCount: 0, scoredCount: 0, duplicateCount,
        durationMs: Date.now() - start, costUsd: totalCost,
        hubspotTasksCreated: 0,
      };
      await storage.put(scan);
      return;
    }

    // 5. ENRICH AUTHORS ─────────────────────────────────────────────────────
    let authors: Record<string, AuthorContext> = {};
    if (enrichAuthors) {
      await update(scan, {
        status: "enriching",
        message: "Enriching author context",
        fetched: deduped.length, total: deduped.length,
      });
      for (const src of sourceMap.values()) {
        if (!src.fetchAuthorContext) continue;
        try {
          const usernames = deduped.map((p) => p.author).filter(Boolean);
          const ctxRaw = await src.fetchAuthorContext(usernames);
          const { contexts, costUsd } = await summarizeAuthors(ctxRaw, scan.input);
          authors = { ...authors, ...contexts };
          totalCost += costUsd;
        } catch (e) {
          console.warn("Author enrichment failed", e);
        }
      }
    }

    // 6. SCORE ──────────────────────────────────────────────────────────────
    await update(scan, {
      status: "scoring",
      message: `Scoring ${deduped.length} items`,
      fetched: deduped.length, total: deduped.length,
    });
    const { signals: scored, costUsd: scoreCost } = await scorePosts(
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

    let finalSignals: Signal[] = scored.slice(0, scan.input.maxResults);

    // 7. DRAFT REPLIES ──────────────────────────────────────────────────────
    if (draftReplies && finalSignals.length > 0) {
      const draftThreshold = 60;
      const draftTargets = finalSignals.filter((s) => s.score >= draftThreshold).length;
      if (draftTargets > 0) {
        await update(scan, {
          status: "drafting",
          message: `Drafting replies for ${draftTargets} high-score signals`,
          fetched: deduped.length, scored: deduped.length, total: deduped.length,
        });
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
      }
    }

    // 8. HUBSPOT PUSH ───────────────────────────────────────────────────────
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
        } catch (e) {
          console.warn("HubSpot push failed", e);
        }
      }
    }

    // Record seen for future dedup
    if (scan.input.campaignKey) {
      await storage.addSeen(scan.input.campaignKey, deduped.map((p) => p.externalId));
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
    scan.progress = {
      status: "complete",
      message: `Found ${finalSignals.length} signal${finalSignals.length === 1 ? "" : "s"}${duplicateCount > 0 ? ` (skipped ${duplicateCount} already-seen)` : ""}`,
      fetched: deduped.length,
      scored: deduped.length,
      total: deduped.length,
    };
    await storage.put(scan);
  } catch (err: any) {
    scan.error = err?.message ?? String(err);
    scan.progress = {
      status: "failed",
      message: scan.error ?? "Failed",
      fetched: scan.progress.fetched,
      scored: scan.progress.scored,
      total: scan.progress.total,
    };
    await storage.put(scan);
    throw err;
  }
}

async function update(scan: Scan, patch: Partial<ScanProgress> & { status: ScanProgress["status"] }) {
  scan.progress = { ...scan.progress, ...patch };
  await storage.put(scan);
}
