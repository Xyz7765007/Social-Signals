"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Clock, ChevronRight, Loader2 } from "lucide-react";

interface ScanListItem {
  id: string;
  createdAt: string;
  status: string;
  message: string;
  businessDescription: string;
  timeWindow: string;
  signalCount: number;
}

export default function HistoryPage() {
  const [scans, setScans] = useState<ScanListItem[] | null>(null);

  useEffect(() => {
    fetch("/api/scans")
      .then((r) => r.json())
      .then((d) => setScans(d.scans ?? []));
  }, []);

  return (
    <div className="max-w-4xl mx-auto px-6 pt-16 pb-20">
      <h1 className="font-display text-5xl tracking-tightest mb-2">History</h1>
      <p className="text-[var(--text-dim)] mb-10">Past scans, newest first.</p>

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
            return (
              <Link
                key={s.id}
                href={`/scan/${s.id}`}
                className="card flex items-center gap-4 p-4 hover:border-[var(--line-strong)] transition-colors"
              >
                <div
                  className={`w-2 h-2 rounded-full ${
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
                    {ago} &middot; {s.timeWindow} &middot;{" "}
                    {isDone ? `${s.signalCount} signals` : s.status}
                  </div>
                </div>
                <ChevronRight size={16} className="text-[var(--text-faint)]" />
              </Link>
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
