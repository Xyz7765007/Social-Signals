"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Plus, X, Loader2, Sparkles, ChevronDown, Bookmark, Check, Trash2 } from "lucide-react";
import type { ScanInput, ScanPreset, SignalType, TimeWindow } from "@/lib/types";

interface PresetLite {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  preview: {
    businessSnippet: string;
    keywordCount: number;
    subredditCount: number;
    campaignKey: string | null;
    timeWindow: string;
  };
}

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

  // Core fields
  const [business, setBusiness] = useState("");
  const [icp, setIcp] = useState("");
  const [signalTypes, setSignalTypes] = useState<SignalType[]>([
    "pain_point", "buying_intent", "recommendation_request",
  ]);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [kwDraft, setKwDraft] = useState("");
  const [subreddits, setSubreddits] = useState<string[]>([]);
  const [srDraft, setSrDraft] = useState("");
  const [timeWindow, setTimeWindow] = useState<TimeWindow>("week");
  const [maxResults, setMaxResults] = useState<number>(25);

  // Advanced fields
  const [advOpen, setAdvOpen] = useState(false);
  const [antiSignals, setAntiSignals] = useState<string[]>([]);
  const [asDraft, setAsDraft] = useState("");
  const [campaignKey, setCampaignKey] = useState("");
  const [voice, setVoice] = useState("");
  const [includeComments, setIncludeComments] = useState(true);
  const [enrichAuthors, setEnrichAuthors] = useState(true);
  const [draftReplies, setDraftReplies] = useState(true);
  const [hubspotToken, setHubspotToken] = useState("");
  const [hubspotOwnerId, setHubspotOwnerId] = useState("");
  const [hubspotPushThreshold, setHubspotPushThreshold] = useState(70);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ─── Saved setups (presets) ──────────────────────────────────────────────
  const [presets, setPresets] = useState<PresetLite[]>([]);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  // Fetch presets on mount
  useEffect(() => {
    fetch("/api/presets")
      .then((r) => r.ok ? r.json() : { presets: [] })
      .then((data) => setPresets(data.presets ?? []))
      .catch(() => setPresets([]));
  }, []);

  // Capture current form state as a ScanInput (for saving)
  function captureInput(): ScanInput {
    return {
      businessDescription: business,
      icp,
      signalTypes,
      keywords: keywords.length ? keywords : undefined,
      subreddits: subreddits.length ? subreddits : undefined,
      antiSignals: antiSignals.length ? antiSignals : undefined,
      timeWindow,
      maxResults,
      sources: ["reddit"],
      campaignKey: campaignKey.trim() || undefined,
      voice: voice.trim() || undefined,
      includeComments,
      enrichAuthors,
      draftReplies,
      hubspotToken: hubspotToken.trim() || undefined,
      hubspotOwnerId: hubspotOwnerId.trim() || undefined,
      hubspotPushThreshold: hubspotToken.trim() ? hubspotPushThreshold : undefined,
    };
  }

  // Apply a loaded preset's input to all form fields
  function applyPreset(input: ScanInput) {
    setBusiness(input.businessDescription ?? "");
    setIcp(input.icp ?? "");
    setSignalTypes(input.signalTypes ?? []);
    setKeywords(input.keywords ?? []);
    setSubreddits(input.subreddits ?? []);
    setAntiSignals(input.antiSignals ?? []);
    setTimeWindow(input.timeWindow ?? "week");
    setMaxResults(input.maxResults ?? 25);
    setCampaignKey(input.campaignKey ?? "");
    setVoice(input.voice ?? "");
    setIncludeComments(input.includeComments ?? true);
    setEnrichAuthors(input.enrichAuthors ?? true);
    setDraftReplies(input.draftReplies ?? true);
    setHubspotToken(input.hubspotToken ?? "");
    setHubspotOwnerId(input.hubspotOwnerId ?? "");
    setHubspotPushThreshold(input.hubspotPushThreshold ?? 70);
    // Open advanced if the preset uses any advanced fields
    if (input.antiSignals?.length || input.campaignKey || input.voice || input.hubspotToken) {
      setAdvOpen(true);
    }
  }

  async function loadPreset(id: string) {
    setPresetsOpen(false);
    try {
      const res = await fetch(`/api/presets/${id}`);
      if (!res.ok) throw new Error("Failed to load");
      const { preset } = await res.json() as { preset: ScanPreset };
      applyPreset(preset.input);
    } catch (e: any) {
      setError(`Couldn't load preset: ${e?.message ?? e}`);
    }
  }

  async function savePreset() {
    if (!saveName.trim()) return;
    setSaving(true);
    try {
      const res = await fetch("/api/presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: saveName.trim(), input: captureInput() }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Save failed");
      setPresets((prev) => [{
        id: json.preset.id,
        name: json.preset.name,
        createdAt: json.preset.createdAt,
        updatedAt: json.preset.updatedAt,
        preview: {
          businessSnippet: business.slice(0, 90),
          keywordCount: keywords.length,
          subredditCount: subreddits.length,
          campaignKey: campaignKey.trim() || null,
          timeWindow,
        },
      }, ...prev]);
      setSaveDialogOpen(false);
      setSaveName("");
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
    } catch (e: any) {
      setError(`Couldn't save: ${e?.message ?? e}`);
    } finally {
      setSaving(false);
    }
  }

  async function deletePreset(id: string) {
    // Optimistic — restore on failure
    const snapshot = presets;
    setPresets((prev) => prev.filter((p) => p.id !== id));
    try {
      const res = await fetch(`/api/presets/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
    } catch {
      setPresets(snapshot);
    }
  }

  const canSave = useMemo(
    () => business.trim().length >= 10 && icp.trim().length >= 5 && signalTypes.length > 0,
    [business, icp, signalTypes],
  );

  const canSubmit = useMemo(
    () => business.trim().length >= 10 && icp.trim().length >= 5 && signalTypes.length > 0,
    [business, icp, signalTypes],
  );

  function toggleSignal(t: SignalType) {
    setSignalTypes((prev) => (prev.includes(t) ? prev.filter((s) => s !== t) : [...prev, t]));
  }

  function addItem(draft: string, list: string[], setList: (l: string[]) => void, setDraft: (s: string) => void) {
    const parts = draft.split(/[,\n]/g).map((s) => s.trim().replace(/^\/?r\//i, "")).filter(Boolean);
    if (!parts.length) return;
    setList(Array.from(new Set([...list, ...parts])).slice(0, 20));
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
          antiSignals: antiSignals.length ? antiSignals : undefined,
          timeWindow,
          maxResults,
          sources: ["reddit"],
          campaignKey: campaignKey.trim() || undefined,
          voice: voice.trim() || undefined,
          includeComments,
          enrichAuthors,
          draftReplies,
          hubspotToken: hubspotToken.trim() || undefined,
          hubspotOwnerId: hubspotOwnerId.trim() || undefined,
          hubspotPushThreshold: hubspotToken.trim() ? hubspotPushThreshold : undefined,
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
    <div className="max-w-3xl mx-auto px-6 pt-10 pb-24">
      {/* Saved setups picker */}
      <div className="mb-6 flex items-center gap-2 flex-wrap">
        <div className="relative">
          <button
            type="button"
            onClick={() => setPresetsOpen((v) => !v)}
            className="text-[11px] font-mono uppercase tracking-[0.18em] px-3 py-1.5 rounded-md border border-[var(--line)] hover:border-[var(--line-strong)] bg-[var(--bg-elev)] flex items-center gap-2"
          >
            <Bookmark size={12} />
            Saved setups
            {presets.length > 0 && (
              <span className="text-[var(--text-faint)]">({presets.length})</span>
            )}
            <ChevronDown size={12} className={`transition-transform ${presetsOpen ? "rotate-180" : ""}`} />
          </button>
          {presetsOpen && (
            <div className="absolute left-0 top-full mt-1 w-[420px] max-w-[90vw] max-h-[420px] overflow-y-auto z-20 rounded-md border border-[var(--line-strong)] bg-[var(--bg-elev-2)] shadow-2xl">
              {presets.length === 0 ? (
                <div className="p-4 text-xs text-[var(--text-faint)] text-center">
                  No saved setups yet. Fill out the form and click <span className="font-mono">Save setup</span> below.
                </div>
              ) : (
                <ul className="divide-y divide-[var(--line)]">
                  {presets.map((p) => (
                    <li key={p.id} className="group">
                      <div className="flex items-stretch">
                        <button
                          type="button"
                          onClick={() => loadPreset(p.id)}
                          className="flex-1 text-left p-3 hover:bg-[var(--bg-elev)] transition-colors min-w-0"
                        >
                          <div className="font-medium text-[13px] truncate">{p.name}</div>
                          <div className="text-[11px] text-[var(--text-faint)] mt-0.5 truncate">
                            {p.preview.businessSnippet || <em className="opacity-60">no description</em>}
                          </div>
                          <div className="text-[10px] font-mono text-[var(--text-faint)] mt-1 flex gap-3 flex-wrap">
                            <span>{p.preview.timeWindow}</span>
                            <span>{p.preview.keywordCount} kw</span>
                            <span>{p.preview.subredditCount} subs</span>
                            {p.preview.campaignKey && <span>· {p.preview.campaignKey}</span>}
                          </div>
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (confirm(`Delete saved setup "${p.name}"?`)) deletePreset(p.id);
                          }}
                          className="px-3 text-[var(--text-faint)] hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100"
                          aria-label="Delete"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        {savedFlash && (
          <span className="text-[11px] font-mono text-[var(--amber)] flex items-center gap-1 animate-fade-up">
            <Check size={12} /> Saved
          </span>
        )}
      </div>

      {/* Hero */}
      <div className="mb-14 animate-fade-up">
        <div className="text-[11px] font-mono uppercase tracking-[0.22em] text-[var(--text-faint)] mb-4">
          Reddit&nbsp;·&nbsp;v0.2
        </div>
        <h1 className="font-display text-5xl sm:text-6xl tracking-tightest leading-[1.02]">
          Listen for the
          <br />
          <span className="italic text-[var(--amber)]">moments worth replying to.</span>
        </h1>
        <p className="mt-5 text-[var(--text-dim)] max-w-xl text-[15px] leading-relaxed">
          Tell Pulse what you do and who you sell to. It surfaces Reddit posts <em>and comments</em> matching
          your ICP — author-checked, intent-scored, with a draft reply in your voice.
        </p>
      </div>

      <div className="space-y-10">
        <Section number="01" title="What does your business do?">
          <textarea className="textarea" placeholder="e.g. We sell AI-powered SDR infrastructure for B2B teams in APAC…" value={business} onChange={(e) => setBusiness(e.target.value)} rows={4} maxLength={1500} />
          <p className="text-xs text-[var(--text-faint)] mt-2 font-mono">{business.length}/1500 · specificity matters</p>
        </Section>

        <Section number="02" title="Who is your ideal customer?">
          <textarea className="textarea" placeholder="e.g. B2B SaaS, 50–500 employees, APAC, founders or VPs…" value={icp} onChange={(e) => setIcp(e.target.value)} rows={3} maxLength={1000} />
          <p className="text-xs text-[var(--text-faint)] mt-2 font-mono">{icp.length}/1000</p>
        </Section>

        <Section number="03" title="What signals matter?">
          <div className="grid sm:grid-cols-2 gap-2">
            {SIGNAL_OPTIONS.map((s) => {
              const on = signalTypes.includes(s.id);
              return (
                <button key={s.id} type="button" onClick={() => toggleSignal(s.id)}
                  className={`text-left p-3.5 rounded-md border transition-all ${on ? "border-[var(--amber)] bg-[var(--amber)]/[0.06]" : "border-[var(--line)] hover:border-[var(--line-strong)] bg-[var(--bg-elev)]"}`}
                  aria-pressed={on}>
                  <div className="flex items-start gap-2.5">
                    <div className={`w-3.5 h-3.5 rounded-sm mt-0.5 flex items-center justify-center flex-shrink-0 border ${on ? "bg-[var(--amber)] border-[var(--amber)]" : "border-[var(--line-strong)]"}`}>
                      {on && <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M1.5 5L4 7.5L8.5 2.5" stroke="#0c0b08" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>}
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

        <Section number="04" title="Refine (optional)" subtitle="Leave blank and Pulse generates these for you.">
          <div className="space-y-5">
            <ChipInput label="Keywords" hint="Phrases people would actually type. Comma or Enter to add."
              placeholder="e.g. need a CRM, hate hubspot, looking for SDR tool"
              draft={kwDraft} setDraft={setKwDraft} items={keywords} setItems={setKeywords}
              onAdd={() => addItem(kwDraft, keywords, setKeywords, setKwDraft)} />
            <ChipInput label="Subreddits" hint="Where your ICP actually hangs out. Names only, no r/."
              placeholder="e.g. sales, sweatystartup, b2bmarketing"
              draft={srDraft} setDraft={setSrDraft} items={subreddits} setItems={setSubreddits}
              onAdd={() => addItem(srDraft, subreddits, setSubreddits, setSrDraft)} prefix="r/" />
          </div>
        </Section>

        <Section number="05" title="How far back & how many?">
          <div className="space-y-5">
            <div>
              <div className="text-[11px] font-mono uppercase tracking-[0.18em] text-[var(--text-faint)] mb-2.5">Post age</div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {TIME_OPTIONS.map((opt) => (
                  <button key={opt.id} type="button" onClick={() => setTimeWindow(opt.id)}
                    className={`p-3 rounded-md border text-left transition-all ${timeWindow === opt.id ? "border-[var(--amber)] bg-[var(--amber)]/[0.06]" : "border-[var(--line)] hover:border-[var(--line-strong)] bg-[var(--bg-elev)]"}`}>
                    <div className="text-sm font-medium">{opt.label}</div>
                    <div className="text-[11px] text-[var(--text-faint)] mt-0.5 font-mono">{opt.sub}</div>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="text-[11px] font-mono uppercase tracking-[0.18em] text-[var(--text-faint)] mb-2.5">Max signals</div>
              <div className="grid grid-cols-4 gap-2">
                {COUNT_OPTIONS.map((n) => (
                  <button key={n} type="button" onClick={() => setMaxResults(n)}
                    className={`p-3 rounded-md border font-mono transition-all ${maxResults === n ? "border-[var(--amber)] bg-[var(--amber)]/[0.06] text-[var(--text)]" : "border-[var(--line)] hover:border-[var(--line-strong)] bg-[var(--bg-elev)] text-[var(--text-dim)]"}`}>
                    {n}
                  </button>
                ))}
              </div>
              <p className="text-xs text-[var(--text-faint)] mt-2">
                Pulse fetches up to 200 raw posts from Reddit, ranks them, and returns the top {maxResults} signals scoring ≥ 20. Bounds worst-case Apify cost at ~$0.60/scan.
              </p>
            </div>
          </div>
        </Section>

        {/* Advanced */}
        <section className="animate-fade-up">
          <button type="button" onClick={() => setAdvOpen((x) => !x)}
            className="w-full flex items-center justify-between text-left py-3 border-b hairline hover:border-[var(--line-strong)] transition-colors">
            <div className="flex items-baseline gap-3">
              <span className="font-mono text-[11px] tracking-[0.2em] text-[var(--text-faint)]">06</span>
              <h2 className="font-display text-[26px] tracking-tightest leading-none">Advanced</h2>
            </div>
            <ChevronDown size={18} className={`text-[var(--text-faint)] transition-transform ${advOpen ? "rotate-180" : ""}`} />
          </button>
          {advOpen && (
            <div className="pt-6 space-y-6 animate-fade-up">
              {/* Anti-signals */}
              <ChipInput label="Anti-signals" hint="Terms that LOOK relevant but pull noise. Scoring downweights these."
                placeholder="e.g. accountant, bookkeeping, start a business"
                draft={asDraft} setDraft={setAsDraft} items={antiSignals} setItems={setAntiSignals}
                onAdd={() => addItem(asDraft, antiSignals, setAntiSignals, setAsDraft)} />

              {/* Campaign key */}
              <div>
                <div className="text-[11px] font-mono uppercase tracking-[0.18em] text-[var(--text-faint)] mb-2">
                  Campaign name <span className="text-[var(--text-faint)] normal-case tracking-normal text-[11px]">— for cross-scan dedup</span>
                </div>
                <input className="input" placeholder="e.g. osome-singapore"
                  value={campaignKey} onChange={(e) => setCampaignKey(e.target.value)} />
                <p className="text-xs text-[var(--text-faint)] mt-1.5">
                  Scans sharing this name skip signals seen in earlier runs. Leave blank for one-off scans.
                </p>
              </div>

              {/* Voice */}
              <div>
                <div className="text-[11px] font-mono uppercase tracking-[0.18em] text-[var(--text-faint)] mb-2">Brand voice</div>
                <textarea className="textarea" rows={4} maxLength={2000} placeholder="e.g. Conversational, peer-to-peer, never salesy. Use 'we' not 'I'. Short sentences. Mention pricing if directly asked. Tone references: like a senior engineer at the company casually answering on Reddit on their personal account."
                  value={voice} onChange={(e) => setVoice(e.target.value)} />
                <p className="text-xs text-[var(--text-faint)] mt-1.5">Used by the reply drafter. Default tone is low-key peer-to-peer.</p>
              </div>

              {/* Toggles */}
              <div className="space-y-2.5">
                <Toggle on={includeComments} setOn={setIncludeComments} label="Include comments" hint="Pull top 3 comments per engaged post and score them too. Where most real signal lives." />
                <Toggle on={enrichAuthors} setOn={setEnrichAuthors} label="Enrich authors" hint="Check each author's recent subreddits; downscore obvious non-ICP." />
                <Toggle on={draftReplies} setOn={setDraftReplies} label="Draft replies" hint="Generate a draft reply for each signal scoring ≥ 60." />
              </div>

              {/* HubSpot */}
              <div className="space-y-3 pt-4 border-t hairline">
                <div className="text-[11px] font-mono uppercase tracking-[0.18em] text-[var(--text-faint)]">HubSpot push (optional)</div>
                <input className="input" placeholder="HubSpot Private App token (pat-…)"
                  value={hubspotToken} onChange={(e) => setHubspotToken(e.target.value)} type="password" />
                {hubspotToken.trim() && (
                  <>
                    <input className="input" placeholder="HubSpot owner ID (optional — assigns the task)"
                      value={hubspotOwnerId} onChange={(e) => setHubspotOwnerId(e.target.value)} />
                    <div>
                      <div className="flex justify-between text-[10px] font-mono uppercase tracking-[0.18em] text-[var(--text-faint)] mb-1.5">
                        <span>Push threshold</span>
                        <span className="text-[var(--amber)]">{hubspotPushThreshold}+</span>
                      </div>
                      <input type="range" min={50} max={95} step={5}
                        value={hubspotPushThreshold} onChange={(e) => setHubspotPushThreshold(Number(e.target.value))}
                        className="w-full accent-[var(--amber)]" />
                    </div>
                    <p className="text-xs text-[var(--text-faint)]">Creates one HubSpot Task per signal at or above threshold. Subject = post title + score. Body = reasoning, action, reply draft, link.</p>
                  </>
                )}
              </div>
            </div>
          )}
        </section>

        {/* Submit */}
        <div className="pt-4 border-t hairline">
          {error && <div className="mb-4 text-sm text-[var(--ember)] font-mono">{error}</div>}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
            <div className="text-xs text-[var(--text-faint)] font-mono">
              Reddit API · Claude Sonnet 4.6 · ~60–120s per scan
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setSaveDialogOpen(true)}
                disabled={!canSave}
                className="btn px-4 py-3"
                title={canSave ? "Save current form as a reusable setup" : "Fill out business + ICP first"}
              >
                <Bookmark size={14} /> Save setup
              </button>
              <button type="button" onClick={submit} disabled={!canSubmit || submitting} className="btn btn-primary px-6 py-3">
                {submitting ? (<><Loader2 size={16} className="animate-spin" /> Starting scan…</>) : (<><Sparkles size={16} /> Run scan <ArrowRight size={16} /></>)}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Save dialog */}
      {saveDialogOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => !saving && setSaveDialogOpen(false)}
        >
          <div
            className="bg-[var(--bg-elev-2)] border border-[var(--line-strong)] rounded-lg p-6 w-full max-w-md shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-display text-xl mb-1">Save scan setup</h3>
            <p className="text-xs text-[var(--text-faint)] mb-4">
              Give this setup a name so you can reload it later. The full form (business, ICP, keywords, subs, advanced
              options) will be saved.
            </p>
            <input
              autoFocus
              className="input w-full mb-3"
              placeholder="e.g. Osome SG, Veloka PM, Material Daily"
              maxLength={80}
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && saveName.trim()) savePreset();
                if (e.key === "Escape") setSaveDialogOpen(false);
              }}
            />
            <div className="flex justify-end gap-2 mt-4">
              <button
                type="button"
                onClick={() => setSaveDialogOpen(false)}
                disabled={saving}
                className="btn px-4 py-2"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={savePreset}
                disabled={!saveName.trim() || saving}
                className="btn btn-primary px-4 py-2"
              >
                {saving ? <><Loader2 size={14} className="animate-spin" /> Saving</> : <><Check size={14} /> Save</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ number, title, subtitle, children }: { number: string; title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="animate-fade-up">
      <div className="flex items-baseline gap-3 mb-3.5">
        <span className="font-mono text-[11px] tracking-[0.2em] text-[var(--text-faint)]">{number}</span>
        <h2 className="font-display text-[26px] tracking-tightest leading-none">{title}</h2>
      </div>
      {subtitle && <p className="text-[13px] text-[var(--text-faint)] mb-3 -mt-1">{subtitle}</p>}
      {children}
    </section>
  );
}

function ChipInput({ label, hint, placeholder, draft, setDraft, items, setItems, onAdd, prefix }: {
  label: string; hint: string; placeholder: string;
  draft: string; setDraft: (s: string) => void; items: string[]; setItems: (l: string[]) => void;
  onAdd: () => void; prefix?: string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-[11px] font-mono uppercase tracking-[0.18em] text-[var(--text-faint)]">{label}</div>
        <div className="text-[11px] text-[var(--text-faint)] font-mono">{items.length}/20</div>
      </div>
      <div className="text-xs text-[var(--text-faint)] mb-2">{hint}</div>
      <div className="flex gap-2">
        <input className="input flex-1" placeholder={placeholder} value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); onAdd(); } }} />
        <button type="button" onClick={onAdd} className="btn" disabled={!draft.trim()}><Plus size={14} /> Add</button>
      </div>
      {items.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {items.map((item) => (
            <span key={item} className="chip chip-removable">
              {prefix && <span className="text-[var(--text-faint)]">{prefix}</span>}
              {item}
              <button type="button" aria-label="remove" onClick={() => setItems(items.filter((x) => x !== item))}><X size={12} /></button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Toggle({ on, setOn, label, hint }: { on: boolean; setOn: (v: boolean) => void; label: string; hint: string }) {
  return (
    <button type="button" onClick={() => setOn(!on)}
      className={`w-full text-left p-3 rounded-md border transition-all flex items-start gap-3 ${on ? "border-[var(--amber)]/40 bg-[var(--amber)]/[0.04]" : "border-[var(--line)] bg-[var(--bg-elev)] hover:border-[var(--line-strong)]"}`}
      aria-pressed={on}>
      <div className={`w-9 h-5 rounded-full mt-0.5 flex-shrink-0 transition-colors relative ${on ? "bg-[var(--amber)]" : "bg-[var(--bg-elev-2)] border hairline-strong"}`}>
        <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-[var(--bg)] transition-transform ${on ? "translate-x-[18px]" : "translate-x-0.5"}`} />
      </div>
      <div className="flex-1">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-[var(--text-faint)] mt-0.5">{hint}</div>
      </div>
    </button>
  );
}
