"use client";

import { ExternalLink, MessageSquare, ArrowUp, Copy, Check } from "lucide-react";
import { useState } from "react";
import type { Signal } from "@/lib/types";
import { SIGNAL_TYPE_LABELS } from "@/lib/types";

export default function SignalCard({ signal, rank }: { signal: Signal; rank: number }) {
  const [copied, setCopied] = useState(false);

  const tone =
    signal.score >= 80
      ? "high"
      : signal.score >= 60
      ? "medium"
      : signal.score >= 40
      ? "low"
      : "weak";

  const toneColor = {
    high: "text-[var(--amber)] border-[var(--amber)]/40",
    medium: "text-[var(--moss)] border-[var(--moss)]/40",
    low: "text-[var(--text-dim)] border-[var(--line-strong)]",
    weak: "text-[var(--text-faint)] border-[var(--line)]",
  }[tone];

  async function copyText() {
    const text = `${signal.title ?? ""}\n\n${signal.content}\n\n${signal.url}`;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const ago = relativeTime(signal.createdAt);
  const sub = signal.metadata.subreddit ? `r/${signal.metadata.subreddit}` : "";
  const upvotes = signal.metadata.upvotes ?? 0;
  const comments = signal.metadata.comments ?? 0;
  const typeLabel = signal.signalType === "other" ? "Signal" : SIGNAL_TYPE_LABELS[signal.signalType];

  return (
    <article className="card p-5 sm:p-6 hover:border-[var(--line-strong)] transition-colors animate-fade-up">
      {/* Top row: rank + score + meta */}
      <div className="flex items-start gap-4 mb-4">
        <div className="font-mono text-[11px] text-[var(--text-faint)] pt-1">
          #{String(rank).padStart(2, "0")}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-1.5">
            <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--text-faint)]">
              {sub}
            </span>
            <span className="text-[11px] text-[var(--text-faint)] font-mono">{ago}</span>
            <span className="text-[11px] text-[var(--text-faint)] font-mono">
              u/{signal.author}
            </span>
          </div>
          {signal.title && (
            <h3 className="font-display text-[22px] leading-snug tracking-tight">
              {signal.title}
            </h3>
          )}
        </div>
        <div className={`flex items-baseline gap-1.5 px-2.5 py-1 rounded-md border ${toneColor} font-mono`}>
          <span className="text-2xl leading-none">{signal.score}</span>
          <span className="text-[10px] opacity-70">/100</span>
        </div>
      </div>

      {/* Content snippet */}
      {signal.content && (
        <p className="text-[14.5px] leading-relaxed text-[var(--text-dim)] mb-4 whitespace-pre-line">
          {truncate(signal.content, 380)}
        </p>
      )}

      {/* AI analysis */}
      <div className="rounded-md border hairline bg-[var(--bg-elev-2)] p-3.5 mb-4">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[10px] font-mono uppercase tracking-[0.2em] text-[var(--text-faint)]">
            Why this matched
          </span>
          <span className="text-[10px] font-mono uppercase tracking-[0.15em] px-1.5 py-0.5 rounded bg-[var(--bg)] border hairline text-[var(--amber)]">
            {typeLabel}
          </span>
        </div>
        <p className="text-[13.5px] leading-relaxed text-[var(--text)]">{signal.reasoning}</p>
        {signal.suggestedAction && (
          <div className="mt-3 pt-3 border-t hairline">
            <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-[var(--text-faint)] mb-1.5">
              Suggested action
            </div>
            <p className="text-[13.5px] leading-relaxed italic text-[var(--text)]">
              {signal.suggestedAction}
            </p>
          </div>
        )}
      </div>

      {/* Footer: stats + actions */}
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-4 text-[var(--text-faint)] font-mono">
          <span className="inline-flex items-center gap-1">
            <ArrowUp size={12} /> {upvotes}
          </span>
          <span className="inline-flex items-center gap-1">
            <MessageSquare size={12} /> {comments}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={copyText} className="btn btn-ghost text-xs py-1.5 px-2.5">
            {copied ? (
              <>
                <Check size={12} /> Copied
              </>
            ) : (
              <>
                <Copy size={12} /> Copy
              </>
            )}
          </button>
          <a
            href={signal.url}
            target="_blank"
            rel="noreferrer noopener"
            className="btn btn-ghost text-xs py-1.5 px-2.5"
          >
            Open <ExternalLink size={12} />
          </a>
        </div>
      </div>
    </article>
  );
}

function relativeTime(iso: string): string {
  const now = Date.now();
  const t = new Date(iso).getTime();
  const sec = Math.max(0, Math.floor((now - t) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n).trimEnd() + "…";
}
