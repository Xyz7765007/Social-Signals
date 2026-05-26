"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ArrowRight, Plus, X, Loader2, Sparkles } from "lucide-react";
import type { SignalType, TimeWindow } from "@/lib/types";
import { SIGNAL_TYPE_LABELS } from "@/lib/types";

const SIGNAL_OPTIONS: { id: SignalType; label: string; hint: string }[] = [
  { id: "pain_point", label: "Pain points", hint: "complaints, frustrations" },
  { id: "buying_intent", label: "Buying intent", hint: "actively evaluating, asking how-to-buy" },
  { id: "recommendation_request", label: "Asking for recs", hint: "\"what tool do you use for…\"" },
  { id: "competitor_mention", label: "Competitor mentions", hint: "named alternatives in your space" },
  { id: "switching_intent", label: "Switching intent", hint: "\"moving away from X\"" },
  { id: "complaint", label: "Complaints about incumbents", hint: "trashing existing solution" },
  { id: "product_question", label: "Product questions", hint: "how-to / setup / feature asks" },
];

const TIME_OPTIONS: { id: TimeWindow; label: string; sub: string }[] = [
  { id: "hour", label: "Last hour", sub: "real-time" },
  { id: "day", label: "Last 24 hours", sub: "fresh" },
  { id: "week", label: "Last week", sub: "recommended" },
  { id: "month", label: "Last month", sub: "broad sweep" },
];

const COUNT_OPTIONS = [10, 25, 50, 100];

export default function ScanForm() {
  const router = useRouter();
  const [business, setBusiness] = useState("");
  const [icp, setIcp] = useState("");
  const [signalTypes, setSignalTypes] = useState<SignalType[]>([
    "pain_point",
    "buying_intent",
    "recommendation_request",
  ]);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [kwDraft, setKwDraft] = useState("");
  const [subreddits, setSubreddits] = useState<string[]>([]);
  const [srDraft, setSrDraft] = useState("");
  const [timeWindow, setTimeWindow] = useState<TimeWindow>("week");
  const [maxResults, setMaxResults] = useState<number>(25);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = useMemo(
    () => business.trim().length >= 10 && icp.trim().length >= 5 && signalTypes.length > 0,
    [business, icp, signalTypes]
  );

  function toggleSignal(t: SignalType) {
    setSignalTypes((prev) => (prev.includes(t) ? prev.filter((s) => s !== t) : [...prev, t]));
  }

  function addItem(draft: string, list: string[], setList: (l: string[]) => void, setDraft: (s: string) => void) {
    const parts = draft
      .split(/[,\n]/g)
      .map((s) => s.trim().replace(/^\/?r\//i, ""))
      .filter(Boolean);
    if (!parts.length) return;
    const merged = Array.from(new Set([...list, ...parts]));
    setList(merged.slice(0, 20));
    setDraft("");
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/scans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessDescription: business,
          icp,
          signalTypes,
          keywords: keywords.length ? keywords : undefined,
          subreddits: subreddits.length ? subreddits : undefined,
          timeWindow,
          maxResults,
          sources: ["reddit"],
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Scan failed to start");
      router.push(`/scan/${json.id}`);
    } catch (e: any) {
      setError(e?.message ?? "Something went wrong");
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-6 pt-16 pb-24">
      {/* Hero */}
      <div className="mb-14 animate-fade-up">
        <div className="text-[11px] font-mono uppercase tracking-[0.22em] text-[var(--text-faint)] mb-4">
          Reddit&nbsp;·&nbsp;v0.1
        </div>
        <h1 className="font-display text-5xl sm:text-6xl tracking-tightest leading-[1.02]">
          Listen for the
          <br />
          <span className="italic text-[var(--amber)]">moments worth replying to.</span>
        </h1>
        <p className="mt-5 text-[var(--text-dim)] max-w-xl text-[15px] leading-relaxed">
          Tell Pulse what you do and who you sell to. It surfaces real Reddit conversations matching
          your ICP &mdash; ranked by intent, with a one-line reply suggestion for each.
        </p>
      </div>

      {/* Form */}
      <div className="space-y-10">
        {/* STEP 1: Business */}
        <Section number="01" title="What does your business do?">
          <textarea
            className="textarea"
            placeholder="e.g. We sell AI-powered SDR infrastructure for B2B teams in APAC. Outbound campaigns end-to-end: sourcing, scoring, sending, replying. Pricing: $3K–$8K/mo retainer."
            value={business}
            onChange={(e) => setBusiness(e.target.value)}
            rows={4}
            maxLength={1200}
          />
          <p className="text-xs text-[var(--text-faint)] mt-2 font-mono">
            {business.length}/1200 &middot; specificity matters &mdash; vague descriptions = noisy signals
          </p>
        </Section>

        {/* STEP 2: ICP */}
        <Section number="02" title="Who is your ideal customer?">
          <textarea
            className="textarea"
            placeholder="e.g. B2B SaaS companies, 50–500 employees, in APAC. Founders or VPs of Sales/Marketing who are running outbound but don't have a dedicated SDR ops team."
            value={icp}
            onChange={(e) => setIcp(e.target.value)}
            rows={3}
            maxLength={800}
          />
          <p className="text-xs text-[var(--text-faint)] mt-2 font-mono">
            {icp.length}/800
          </p>
        </Section>

        {/* STEP 3: Signal types */}
        <Section number="03" title="What signals matter?">
          <div className="grid sm:grid-cols-2 gap-2">
            {SIGNAL_OPTIONS.map((s) => {
              const on = signalTypes.includes(s.id);
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => toggleSignal(s.id)}
                  className={`text-left p-3.5 rounded-md border transition-all ${
                    on
                      ? "border-[var(--amber)] bg-[var(--amber)]/[0.06]"
                      : "border-[var(--line)] hover:border-[var(--line-strong)] bg-[var(--bg-elev)]"
                  }`}
                  aria-pressed={on}
                >
                  <div className="flex items-start gap-2.5">
                    <div
                      className={`w-3.5 h-3.5 rounded-sm mt-0.5 flex items-center justify-center flex-shrink-0 border ${
                        on
                          ? "bg-[var(--amber)] border-[var(--amber)]"
                          : "border-[var(--line-strong)]"
                      }`}
                    >
                      {on && (
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                          <path
                            d="M1.5 5L4 7.5L8.5 2.5"
                            stroke="#0c0b08"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      )}
                    </div>
                    <div>
                      <div className="text-sm font-medium">{s.label}</div>
                      <div className="text-xs text-[var(--text-faint)] mt-0.5">{s.hint}</div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </Section>

        {/* STEP 4: Refinement (optional) */}
        <Section
          number="04"
          title="Refine (optional)"
          subtitle="Leave blank and Pulse generates these for you."
        >
          <div className="space-y-5">
            <ChipInput
              label="Keywords"
              hint="Phrases people would actually type. Comma or Enter to add."
              placeholder="e.g. need a CRM, hate hubspot, looking for SDR tool"
              draft={kwDraft}
              setDraft={setKwDraft}
              items={keywords}
              setItems={setKeywords}
              onAdd={() => addItem(kwDraft, keywords, setKeywords, setKwDraft)}
            />
            <ChipInput
              label="Subreddits"
              hint="Where your ICP actually hangs out. Names only, no r/."
              placeholder="e.g. sales, sweatystartup, b2bmarketing"
              draft={srDraft}
              setDraft={setSrDraft}
              items={subreddits}
              setItems={setSubreddits}
              onAdd={() => addItem(srDraft, subreddits, setSubreddits, setSrDraft)}
              prefix="r/"
            />
          </div>
        </Section>

        {/* STEP 5: Time + count */}
        <Section number="05" title="How far back & how many?">
          <div className="space-y-5">
            <div>
              <div className="text-[11px] font-mono uppercase tracking-[0.18em] text-[var(--text-faint)] mb-2.5">
                Post age
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {TIME_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setTimeWindow(opt.id)}
                    className={`p-3 rounded-md border text-left transition-all ${
                      timeWindow === opt.id
                        ? "border-[var(--amber)] bg-[var(--amber)]/[0.06]"
                        : "border-[var(--line)] hover:border-[var(--line-strong)] bg-[var(--bg-elev)]"
                    }`}
                  >
                    <div className="text-sm font-medium">{opt.label}</div>
                    <div className="text-[11px] text-[var(--text-faint)] mt-0.5 font-mono">
                      {opt.sub}
                    </div>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="text-[11px] font-mono uppercase tracking-[0.18em] text-[var(--text-faint)] mb-2.5">
                Max signals
              </div>
              <div className="grid grid-cols-4 gap-2">
                {COUNT_OPTIONS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setMaxResults(n)}
                    className={`p-3 rounded-md border font-mono transition-all ${
                      maxResults === n
                        ? "border-[var(--amber)] bg-[var(--amber)]/[0.06] text-[var(--text)]"
                        : "border-[var(--line)] hover:border-[var(--line-strong)] bg-[var(--bg-elev)] text-[var(--text-dim)]"
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </Section>

        {/* Submit */}
        <div className="pt-4 border-t hairline">
          {error && (
            <div className="mb-4 text-sm text-[var(--ember)] font-mono">{error}</div>
          )}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
            <div className="text-xs text-[var(--text-faint)] font-mono">
              Powered by Reddit API · scored by Claude Sonnet · ~30–60s per scan
            </div>
            <button
              type="button"
              onClick={submit}
              disabled={!canSubmit || submitting}
              className="btn btn-primary px-6 py-3"
            >
              {submitting ? (
                <>
                  <Loader2 size={16} className="animate-spin" /> Starting scan…
                </>
              ) : (
                <>
                  <Sparkles size={16} /> Run scan <ArrowRight size={16} />
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({
  number,
  title,
  subtitle,
  children,
}: {
  number: string;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="animate-fade-up">
      <div className="flex items-baseline gap-3 mb-3.5">
        <span className="font-mono text-[11px] tracking-[0.2em] text-[var(--text-faint)]">
          {number}
        </span>
        <h2 className="font-display text-[26px] tracking-tightest leading-none">{title}</h2>
      </div>
      {subtitle && (
        <p className="text-[13px] text-[var(--text-faint)] mb-3 -mt-1">{subtitle}</p>
      )}
      {children}
    </section>
  );
}

function ChipInput({
  label,
  hint,
  placeholder,
  draft,
  setDraft,
  items,
  setItems,
  onAdd,
  prefix,
}: {
  label: string;
  hint: string;
  placeholder: string;
  draft: string;
  setDraft: (s: string) => void;
  items: string[];
  setItems: (l: string[]) => void;
  onAdd: () => void;
  prefix?: string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-[11px] font-mono uppercase tracking-[0.18em] text-[var(--text-faint)]">
          {label}
        </div>
        <div className="text-[11px] text-[var(--text-faint)] font-mono">{items.length}/20</div>
      </div>
      <div className="text-xs text-[var(--text-faint)] mb-2">{hint}</div>
      <div className="flex gap-2">
        <input
          className="input flex-1"
          placeholder={placeholder}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              onAdd();
            }
          }}
        />
        <button type="button" onClick={onAdd} className="btn" disabled={!draft.trim()}>
          <Plus size={14} /> Add
        </button>
      </div>
      {items.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {items.map((item) => (
            <span key={item} className="chip chip-removable">
              {prefix && <span className="text-[var(--text-faint)]">{prefix}</span>}
              {item}
              <button
                type="button"
                aria-label="remove"
                onClick={() => setItems(items.filter((x) => x !== item))}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
