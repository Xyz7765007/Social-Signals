"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Clock, ChevronRight, Loader2, Trash2 } from "lucide-react";

interface ScanListItem {
  id: string;
  createdAt: string;
  status: string;
  message: string;
  businessDescription: string;
  campaignKey?: string;
  timeWindow: string;
  signalCount: number;
}

export default function HistoryPage() {
  const [scans, setScans] = useState<ScanListItem[] | null>(null);
  const [deleting, setDeleting] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/scans")
      .then((r) => r.json())
      .then((d) => setScans(d.scans ?? []))
      .catch(() => setError("Couldn't load scans"));
  }, []);

  async function handleDelete(id: string, e: React.MouseEvent) {
    // The row itself is a <Link>, so we must stop both default and propagation
    // or the click navigates to the scan page before/after the delete fires.
    e.preventDefault();
    e.stopPropagation();
    if (deleting.has(id)) return;
    const confirmed = window.confirm("Delete this scan?");
    if (!confirmed) return;

    // Optimistic UI: drop from list immediately. Restore on failure.
    const prev = scans;
    setScans((cur) => cur?.filter((s) => s.id !== id) ?? null);
    setDeleting((d) => new Set(d).add(id));

    try {
      const res = await fetch(`/api/scans/${id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Delete failed (${res.status})`);
      }
    } catch (err: any) {
      // Restore the optimistic removal
      setScans(prev);
      setError(err?.message ?? "Couldn't delete");
    } finally {
      setDeleting((d) => {
        const next = new Set(d);
        next.delete(id);
        return next;
      });
    }
  }

  // A scan is "stalled" if it's in a non-terminal state but was created long
  // enough ago that any sane orchestrator would have finished by now. These
  // are typically orphans from the old fire-and-forget bug or from Vercel
  // hitting maxDuration mid-pipeline.
  const stalled = (scans ?? []).filter((s) => {
    const isTerminal = s.status === "complete" || s.status === "failed";
    if (isTerminal) return false;
    const ageMs = Date.now() - new Date(s.createdAt).getTime();
    return ageMs > 5 * 60 * 1000; // older than 5 min and still not done = stalled
  });

  async function cleanupStalled() {
    if (stalled.length === 0) return;
    const confirmed = window.confirm(
      `Delete ${stalled.length} stalled scan${stalled.length === 1 ? "" : "s"}? (These are scans stuck before completing — usually orphans from a deploy or timeout.)`
    );
    if (!confirmed) return;
    const ids = stalled.map((s) => s.id);
    const prev = scans;
    setScans((cur) => cur?.filter((s) => !ids.includes(s.id)) ?? null);
    setDeleting((d) => {
      const next = new Set(d);
      for (const id of ids) next.add(id);
      return next;
    });
    // Fire deletes in parallel; tolerate individual failures
    const results = await Promise.allSettled(
      ids.map((id) => fetch(`/api/scans/${id}`, { method: "DELETE" })),
    );
    const failed = results.filter((r) => r.status === "rejected" || (r.status === "fulfilled" && !r.value.ok && r.value.status !== 404));
    if (failed.length > 0) {
      // Restore the ones that didn't actually delete — refetch is simpler
      const r = await fetch("/api/scans");
      const d = await r.json();
      setScans(d.scans ?? prev);
      setError(`${failed.length} of ${ids.length} couldn't be deleted`);
    }
    setDeleting(new Set());
  }

  return (
    <div className="max-w-4xl mx-auto px-6 pt-16 pb-20">
      <div className="mb-10 flex items-end justify-between flex-wrap gap-4">
        <div>
          <h1 className="font-display text-5xl tracking-tightest mb-2">History</h1>
          <p className="text-[var(--text-dim)]">Past scans, newest first.</p>
        </div>
        {stalled.length > 0 && (
          <button
            onClick={cleanupStalled}
            className="btn text-xs px-3 py-2 hover:border-[var(--ember)] hover:text-[var(--ember)] transition-colors"
            title="Delete scans that never completed (orphans from timeouts or old deploys)"
          >
            <Trash2 size={12} /> Clear {stalled.length} stalled
          </button>
        )}
      </div>

      {error && (
        <div className="card p-3 mb-4 border-[var(--ember)]/30 text-sm text-[var(--ember)]">
          {error}
        </div>
      )}

      {scans === null ? (
        <div className="text-[var(--text-faint)] flex items-center gap-2">
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      ) : scans.length === 0 ? (
        <div className="card p-10 text-center">
          <Clock className="mx-auto mb-3 text-[var(--text-faint)]" />
          <p className="text-[var(--text-dim)] mb-5">No scans yet.</p>
          <Link href="/" className="btn btn-primary">
            Run your first scan
          </Link>
        </div>
      ) : (
        <div className="space-y-2">
          {scans.map((s) => {
            const ago = relativeTime(s.createdAt);
            const isDone = s.status === "complete";
            const isFailed = s.status === "failed";
            const isDeleting = deleting.has(s.id);
            return (
              <div
                key={s.id}
                className="card flex items-center gap-4 p-4 hover:border-[var(--line-strong)] transition-colors group"
              >
                <Link href={`/scan/${s.id}`} className="flex-1 flex items-center gap-4 min-w-0">
                  <div
                    className={`w-2 h-2 rounded-full flex-shrink-0 ${
                      isDone
                        ? "bg-[var(--moss)]"
                        : isFailed
                        ? "bg-[var(--ember)]"
                        : "bg-[var(--amber)] animate-pulse"
                    }`}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm truncate">{s.businessDescription || "(no description)"}</div>
                    <div className="mt-0.5 text-[11px] font-mono uppercase tracking-[0.15em] text-[var(--text-faint)]">
                      {ago} &middot; {s.timeWindow}
                      {s.campaignKey ? ` · ${s.campaignKey}` : ""} &middot;{" "}
                      {isDone ? `${s.signalCount} signals` : s.status}
                    </div>
                  </div>
                </Link>
                <button
                  onClick={(e) => handleDelete(s.id, e)}
                  disabled={isDeleting}
                  className="p-2 rounded text-[var(--text-faint)] hover:text-[var(--ember)] hover:bg-[var(--ember)]/[0.06] transition-colors disabled:opacity-40"
                  title="Delete scan"
                  aria-label="Delete scan"
                >
                  {isDeleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                </button>
                <ChevronRight size={14} className="text-[var(--text-faint)] opacity-40" />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function relativeTime(iso: string): string {
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}
