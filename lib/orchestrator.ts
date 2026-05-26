/**
 * Scan orchestrator.
 *
 * Runs a single scan to completion, updating the persisted scan record at each
 * phase so the UI can poll for progress.
 *
 * Phases:
 *   expanding  → AI suggests keywords + subreddits
 *   fetching   → pulls posts from each requested source in parallel
 *   scoring    → AI scores in batches, with progress updates
 *   complete   → final signals + stats persisted
 */

import { randomUUID } from "crypto";
import { getSource } from "./sources";
import { storage } from "./storage";
import { expandScanInput, scorePosts } from "./scoring";
import type { RawPost, Scan, ScanInput, Signal, SourceId } from "./types";

export function createScan(input: ScanInput): Scan {
  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    input,
    progress: {
      status: "queued",
      message: "Queued",
      fetched: 0,
      scored: 0,
      total: 0,
    },
    signals: [],
  };
}

export async function runScan(scanId: string): Promise<void> {
  const start = Date.now();
  const scan = await storage.get(scanId);
  if (!scan) throw new Error("Scan not found");

  try {
    // 1. EXPAND --------------------------------------------------------------
    await update(scan, {
      status: "expanding",
      message: "Generating keywords and subreddits",
    });
    const expansion = await expandScanInput(scan.input);
    scan.expansion = {
      keywords: expansion.keywords,
      subreddits: expansion.subreddits,
      rationale: expansion.rationale,
    };
    let totalCost = expansion.costUsd;
    await storage.put(scan);

    // 2. FETCH ---------------------------------------------------------------
    await update(scan, {
      status: "fetching",
      message: `Searching ${scan.input.sources.join(", ")}`,
    });

    const allRaw: RawPost[] = [];
    for (const id of scan.input.sources) {
      const src = getSource(id as SourceId);
      if (!src.available) {
        // Quietly skip unavailable sources (stubs). Reddit will be available
        // when REDDIT_CLIENT_ID/SECRET are set.
        continue;
      }
      const posts = await src.fetch({
        keywords: expansion.keywords,
        subreddits: id === "reddit" ? expansion.subreddits : undefined,
        timeWindow: scan.input.timeWindow,
        limit: scan.input.maxResults,
      });
      allRaw.push(...posts);
      await update(scan, {
        status: "fetching",
        message: `Pulled ${allRaw.length} from ${src.name}`,
        fetched: allRaw.length,
      });
    }

    // Cross-source dedupe (defensive — same URL appearing twice).
    const seen = new Set<string>();
    const deduped: RawPost[] = [];
    for (const p of allRaw) {
      const key = `${p.sourceId}:${p.externalId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(p);
    }

    if (deduped.length === 0) {
      scan.signals = [];
      scan.progress = {
        status: "complete",
        message:
          "Search complete — no matching posts found. Try a broader time window or more keywords.",
        fetched: 0,
        scored: 0,
        total: 0,
      };
      scan.stats = {
        rawCount: 0,
        dedupedCount: 0,
        scoredCount: 0,
        durationMs: Date.now() - start,
        costUsd: totalCost,
      };
      await storage.put(scan);
      return;
    }

    // 3. SCORE ---------------------------------------------------------------
    await update(scan, {
      status: "scoring",
      message: `Scoring ${deduped.length} posts`,
      fetched: deduped.length,
      total: deduped.length,
    });

    const { signals, costUsd } = await scorePosts(scan.input, deduped, async (done) => {
      await update(scan, {
        status: "scoring",
        message: `Scoring ${done} / ${deduped.length}`,
        fetched: deduped.length,
        scored: done,
        total: deduped.length,
      });
    });
    totalCost += costUsd;

    const final: Signal[] = signals.slice(0, scan.input.maxResults);
    scan.signals = final;
    scan.stats = {
      rawCount: allRaw.length,
      dedupedCount: deduped.length,
      scoredCount: signals.length,
      durationMs: Date.now() - start,
      costUsd: totalCost,
    };
    scan.progress = {
      status: "complete",
      message: `Found ${final.length} signal${final.length === 1 ? "" : "s"}`,
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

async function update(
  scan: Scan,
  patch: Partial<Scan["progress"]> & { status: Scan["progress"]["status"] }
) {
  scan.progress = { ...scan.progress, ...patch };
  await storage.put(scan);
}
