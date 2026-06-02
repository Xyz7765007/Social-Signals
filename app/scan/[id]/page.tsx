"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, RefreshCw, AlertCircle, Filter, Loader2, Trash2 } from "lucide-react";
import type { Scan, SignalType } from "@/lib/types";
import { SIGNAL_TYPE_LABELS, SIGNAL_TYPES } from "@/lib/types";
import SignalCard from "@/components/SignalCard";

const POLL_INTERVAL = 2000;

export default function ScanPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [scan, setScan] = useState<Scan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // filter state
  const [minScore, setMinScore] = useState<number>(50);
  const [typeFilter, setTypeFilter] = useState<Set<SignalType | "other">>(new Set());

  async function handleDelete() {
    if (deleting) return;
    const confirmed = window.confirm(
      "Delete this scan? This removes it from storage permanently."
    );
    if (!confirmed) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/scans/${id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Delete failed (${res.status})`);
      }
      router.push("/history");
    } catch (e: any) {
      setError(e?.message ?? "Couldn't delete");
      setDeleting(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    let consecutiveFailures = 0;
    const MAX_TRANSIENT_FAILURES = 5;

    async function tick() {
      if (cancelled) return;
      try {
        const res = await fetch(`/api/scans/${id}`, { cache: "no-store" });

        if (res.status === 404) {
          // 404 is terminal — scan was deleted or never existed.
          setError("Scan not found. It may have been deleted.");
          return;
        }

        if (!res.ok) {
          // Other non-OK = transient. Back off briefly and retry.
          consecutiveFailures++;
          if (consecutiveFailures >= MAX_TRANSIENT_FAILURES) {
            setError(`Lost connection to server (${res.status}). Reload to try again.`);
            return;
          }
          setTimeout(tick, Math.min(POLL_INTERVAL * (consecutiveFailures + 1), 10_000));
          return;
        }

        const data: Scan = await res.json();
        if (cancelled) return;
        consecutiveFailures = 0;
        setScan(data);
        setError(null);

        if (data.progress.status === "complete" || data.progress.status === "failed") return;
        setTimeout(tick, POLL_INTERVAL);
      } catch (e: any) {
        if (cancelled) return;
        // Network error / offline — treat as transient.
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_TRANSIENT_FAILURES) {
          setError("Lost connection to server. Reload to try again.");
          return;
        }
        setTimeout(tick, Math.min(POLL_INTERVAL * (consecutiveFailures + 1), 10_000));
      }
    }
    tick();
    return () => { cancelled = true; };
  }, [id]);

  const filtered = useMemo(() => {
    if (!scan) return [];
    return scan.signals.filter((s) => {
      if (s.score < minScore) return false;
      if (typeFilter.size > 0 && !typeFilter.has(s.signalType)) return false;
      return true;
    });
  }, [scan, minScore, typeFilter]);

  if (error) {
    return (
      <div className="max-w-3xl mx-auto px-6 pt-20 text-center">
        <AlertCircle className="mx-auto mb-3 text-[var(--ember)]" />
        <p className="text-[var(--text-dim)]">{error}</p>
        <Link href="/" className="btn mt-6 inline-flex">
          <ArrowLeft size={14} /> Back
        </Link>
      </div>
    );
  }

  if (!scan) {
    return (
      <div className="max-w-3xl mx-auto px-6 pt-32 text-center text-[var(--text-faint)]">
        <Loader2 className="mx-auto mb-3 animate-spin" />
        Loading scan…
      </div>
    );
  }

  const inProgress = scan.progress.status !== "complete" && scan.progress.status !== "failed";

  return (
    <div className="max-w-4xl mx-auto px-6 pt-10 pb-20">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-5">
          <Link
            href="/"
            className="text-[11px] font-mono uppercase tracking-[0.2em] text-[var(--text-faint)] hover:text-[var(--text-dim)] inline-flex items-center gap-1.5"
          >
            <ArrowLeft size={12} /> New scan
          </Link>
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="text-[11px] font-mono uppercase tracking-[0.2em] text-[var(--text-faint)] hover:text-[var(--ember)] inline-flex items-center gap-1.5 transition-colors disabled:opacity-50"
            title="Delete this scan"
          >
            {deleting ? (
              <><Loader2 size={12} className="animate-spin" /> Deleting…</>
            ) : (
              <><Trash2 size={12} /> Delete</>
            )}
          </button>
        </div>
        <h1 className="font-display text-4xl sm:text-5xl tracking-tightest leading-[1.05] mb-3">
          {inProgress ? "Scanning…" : scan.progress.status === "failed" ? "Scan failed" : "Signal report"}
        </h1>
        <p className="text-[var(--text-dim)] text-[15px] max-w-2xl">
          {truncate(scan.input.businessDescription, 240)}
        </p>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-mono text-[var(--text-faint)] uppercase tracking-[0.16em]">
          <span>Source: Reddit</span>
          <span>Window: {scan.input.timeWindow}</span>
          {scan.input.campaignKey && <span>Campaign: {scan.input.campaignKey}</span>}
          {scan.stats && (
            <>
              <span>Posts: {scan.stats.postCount}</span>
              {scan.stats.commentCount > 0 && <span>Comments: {scan.stats.commentCount}</span>}
              {scan.stats.duplicateCount > 0 && <span>Skipped: {scan.stats.duplicateCount}</span>}
              {scan.stats.hubspotTasksCreated > 0 && <span>HubSpot: {scan.stats.hubspotTasksCreated} tasks</span>}
              <span>Duration: {(scan.stats.durationMs / 1000).toFixed(1)}s</span>
              <span>Cost: ${scan.stats.costUsd.toFixed(3)}</span>
            </>
          )}
        </div>
      </div>

      {/* Progress / Expansion */}
      {inProgress && <ProgressPane scan={scan} />}

      {scan.expansion && (
        <details className="mb-8 card p-4 group">
          <summary className="cursor-pointer flex items-center justify-between text-sm">
            <span className="text-[11px] font-mono uppercase tracking-[0.18em] text-[var(--text-faint)]">
              Strategy &middot; {scan.expansion.keywords.length} keywords &middot;{" "}
              {scan.expansion.subreddits.length} subreddits
            </span>
            <span className="text-[var(--text-faint)] group-open:rotate-90 transition-transform">
              ›
            </span>
          </summary>
          <div className="mt-4 space-y-4">
            <p className="text-sm text-[var(--text-dim)] italic">{scan.expansion.rationale}</p>
            <div>
              <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-[var(--text-faint)] mb-2">
                Keywords
              </div>
              <div className="flex flex-wrap gap-1.5">
                {scan.expansion.keywords.map((k) => (
                  <span key={k} className="chip">
                    {k}
                  </span>
                ))}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-[var(--text-faint)] mb-2">
                Subreddits
              </div>
              <div className="flex flex-wrap gap-1.5">
                {scan.expansion.subreddits.map((s) => (
                  <a
                    key={s}
                    href={`https://www.reddit.com/r/${s}`}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="chip hover:border-[var(--amber)] transition-colors"
                  >
                    <span className="text-[var(--text-faint)]">r/</span>
                    {s}
                  </a>
                ))}
              </div>
            </div>
          </div>
        </details>
      )}

      {/* Error */}
      {scan.progress.status === "failed" && (
        <div className="card p-5 border-[var(--ember)]/30 mb-8">
          <div className="flex items-start gap-3">
            <AlertCircle className="text-[var(--ember)] flex-shrink-0 mt-0.5" size={18} />
            <div>
              <div className="font-medium mb-1">Scan failed</div>
              <div className="text-sm text-[var(--text-dim)] font-mono">{scan.error}</div>
            </div>
          </div>
        </div>
      )}

      {/* Warnings (non-fatal) */}
      {scan.warnings && scan.warnings.length > 0 && (
        <details className="card p-4 mb-8 border-[var(--amber)]/30">
          <summary className="cursor-pointer flex items-center gap-2 text-sm">
            <AlertCircle size={14} className="text-[var(--amber)]" />
            <span className="text-[11px] font-mono uppercase tracking-[0.18em] text-[var(--amber)]">
              {scan.warnings.length} warning{scan.warnings.length === 1 ? "" : "s"}
            </span>
            <span className="text-[12px] text-[var(--text-dim)]">— scan completed but some steps had issues</span>
          </summary>
          <ul className="mt-3 space-y-1.5 text-[13px] text-[var(--text-dim)] font-mono">
            {scan.warnings.map((w, i) => (
              <li key={i} className="flex gap-2"><span className="text-[var(--text-faint)]">·</span>{w}</li>
            ))}
          </ul>
        </details>
      )}

      {/* Results */}
      {!inProgress && scan.progress.status === "complete" && (
        <>
          {scan.signals.length === 0 ? (
            <div className="card p-10 text-center">
              <div className="font-display text-2xl mb-2">No matching signals</div>
              <p className="text-sm text-[var(--text-dim)] mb-5">
                {scan.stats?.rawCount === 0
                  ? "Reddit returned 0 posts for these keywords + subreddits. Try broader keywords."
                  : `Pulled ${scan.stats?.rawCount} posts but none scored above the threshold. Try a longer window or different signal types.`}
              </p>
              <Link href="/" className="btn">
                Run another scan
              </Link>
            </div>
          ) : (
            <>
              <FilterBar
                minScore={minScore}
                setMinScore={setMinScore}
                typeFilter={typeFilter}
                setTypeFilter={setTypeFilter}
                total={scan.signals.length}
                shown={filtered.length}
                available={Array.from(new Set(scan.signals.map((s) => s.signalType)))}
              />
              <div className="space-y-4 mt-6">
                {filtered.map((s, i) => (
                  <SignalCard key={s.externalId} signal={s} rank={i + 1} />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function ProgressPane({ scan }: { scan: Scan }) {
  const stages = ["expanding", "fetching", "fetching_comments", "enriching", "scoring", "drafting", "pushing"] as const;
  const stageLabels: Record<string, string> = {
    expanding: "Expand",
    fetching: "Fetch",
    fetching_comments: "Comments",
    enriching: "Enrich",
    scoring: "Score",
    drafting: "Draft",
    pushing: "Push",
  };
  const currentIdx = stages.indexOf(scan.progress.status as any);
  const pct =
    scan.progress.total > 0
      ? Math.min(100, (scan.progress.scored / scan.progress.total) * 100)
      : ((currentIdx + 1) / stages.length) * 100;

  return (
    <div className="card p-5 mb-8">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <RefreshCw size={14} className="animate-spin text-[var(--amber)]" />
          <span className="text-sm">{scan.progress.message}</span>
        </div>
        <span className="text-xs font-mono text-[var(--text-faint)]">
          {Math.round(pct)}%
        </span>
      </div>
      <div className="h-[3px] bg-[var(--bg-elev-2)] rounded-full overflow-hidden">
        <div
          className="h-full bg-[var(--amber)] transition-all duration-700 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-4 grid grid-cols-4 sm:grid-cols-7 gap-2 text-[10px] font-mono uppercase tracking-[0.15em]">
        {stages.map((s, i) => (
          <div
            key={s}
            className={
              i <= currentIdx
                ? "text-[var(--text-dim)]"
                : "text-[var(--text-faint)] opacity-50"
            }
          >
            {String(i + 1).padStart(2, "0")} {stageLabels[s]}
          </div>
        ))}
      </div>
    </div>
  );
}

function FilterBar({
  minScore,
  setMinScore,
  typeFilter,
  setTypeFilter,
  total,
  shown,
  available,
}: {
  minScore: number;
  setMinScore: (n: number) => void;
  typeFilter: Set<SignalType | "other">;
  setTypeFilter: (s: Set<SignalType | "other">) => void;
  total: number;
  shown: number;
  available: (SignalType | "other")[];
}) {
  function toggleType(t: SignalType | "other") {
    const next = new Set(typeFilter);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    setTypeFilter(next);
  }
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-[11px] font-mono uppercase tracking-[0.18em] text-[var(--text-faint)]">
          <Filter size={12} />
          Filter &middot; {shown} of {total}
        </div>
        {(minScore > 0 || typeFilter.size > 0) && (
          <button
            onClick={() => {
              setMinScore(0);
              setTypeFilter(new Set());
            }}
            className="text-[11px] font-mono uppercase tracking-[0.15em] text-[var(--text-faint)] hover:text-[var(--text)]"
          >
            Reset
          </button>
        )}
      </div>
      <div className="space-y-3">
        <div>
          <div className="flex justify-between text-[10px] font-mono uppercase tracking-[0.18em] text-[var(--text-faint)] mb-1.5">
            <span>Min score</span>
            <span className="text-[var(--amber)]">{minScore}</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={minScore}
            onChange={(e) => setMinScore(Number(e.target.value))}
            className="w-full accent-[var(--amber)]"
          />
        </div>
        {available.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            {available.map((t) => {
              const on = typeFilter.has(t);
              const label = t === "other" ? "Other" : SIGNAL_TYPE_LABELS[t];
              return (
                <button
                  key={t}
                  onClick={() => toggleType(t)}
                  className={`chip cursor-pointer transition-colors ${
                    on
                      ? "border-[var(--amber)] text-[var(--amber)]"
                      : "hover:border-[var(--line-strong)]"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n).trimEnd() + "…";
}
