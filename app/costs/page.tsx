"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Loader2, TrendingUp, AlertCircle } from "lucide-react";
import type { CostBreakdown } from "@/lib/types";

interface ScanLite {
  id: string;
  createdAt: string;
  status: string;
  businessDescription: string;
  campaignKey?: string;
  signalCount: number;
  costUsd?: number;
  costs?: CostBreakdown;
  durationMs?: number;
}

const PHASE_COLORS: Record<keyof CostBreakdown, string> = {
  expansion: "var(--moss)",
  scoring: "var(--amber)",
  drafting: "var(--ember)",
  authorSummary: "#7a8db0",
  apify: "#b07a8d",
  total: "transparent",
};

const PHASE_LABELS: Record<keyof CostBreakdown, string> = {
  expansion: "Expansion",
  scoring: "Scoring",
  drafting: "Drafts",
  authorSummary: "Author summaries",
  apify: "Apify (data)",
  total: "Total",
};

export default function CostsPage() {
  const [scans, setScans] = useState<ScanLite[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/scans")
      .then((r) => r.json())
      .then((d) => setScans(d.scans ?? []))
      .catch((e) => setError(e?.message ?? "Couldn't load"));
  }, []);

  const stats = useMemo(() => {
    if (!scans) return null;
    const withCost = scans.filter((s) => typeof s.costUsd === "number" && (s.costUsd ?? 0) > 0);
    const totals: CostBreakdown = {
      expansion: 0, scoring: 0, drafting: 0, authorSummary: 0, apify: 0, total: 0,
    };
    for (const s of withCost) {
      if (s.costs) {
        totals.expansion += s.costs.expansion;
        totals.scoring += s.costs.scoring;
        totals.drafting += s.costs.drafting;
        totals.authorSummary += s.costs.authorSummary;
        totals.apify += s.costs.apify;
      }
      totals.total += s.costUsd ?? 0;
    }
    // Last 7 days
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const last7 = withCost.filter((s) => new Date(s.createdAt).getTime() >= sevenDaysAgo);
    const last7Total = last7.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
    // By day, last 14 days
    const days: { day: string; cost: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const day = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const dayStr = day.toISOString().slice(0, 10);
      const cost = withCost
        .filter((s) => s.createdAt.startsWith(dayStr))
        .reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
      days.push({ day: dayStr, cost });
    }
    // By campaign
    const byCampaign = new Map<string, number>();
    for (const s of withCost) {
      const k = s.campaignKey ?? "(no campaign)";
      byCampaign.set(k, (byCampaign.get(k) ?? 0) + (s.costUsd ?? 0));
    }
    const topCampaigns = Array.from(byCampaign.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);

    return {
      totals,
      scanCount: scans.length,
      withCostCount: withCost.length,
      avgPerScan: withCost.length ? totals.total / withCost.length : 0,
      last7Total,
      last7Count: last7.length,
      days,
      topCampaigns,
    };
  }, [scans]);

  if (error) {
    return (
      <div className="max-w-4xl mx-auto px-6 pt-20 text-center">
        <AlertCircle className="mx-auto mb-3 text-[var(--ember)]" />
        <p className="text-[var(--text-dim)]">{error}</p>
      </div>
    );
  }
  if (!scans || !stats) {
    return (
      <div className="max-w-4xl mx-auto px-6 pt-32 text-center text-[var(--text-faint)]">
        <Loader2 className="mx-auto mb-3 animate-spin" />
        Loading…
      </div>
    );
  }
  if (stats.withCostCount === 0) {
    return (
      <div className="max-w-4xl mx-auto px-6 pt-20">
        <h1 className="font-display text-5xl tracking-tightest mb-2">Costs</h1>
        <p className="text-[var(--text-dim)] mb-10">Per-scan spend across all providers.</p>
        <div className="card p-10 text-center">
          <TrendingUp className="mx-auto mb-3 text-[var(--text-faint)]" />
          <p className="text-[var(--text-dim)] mb-5">No completed scans with tracked cost yet.</p>
          <Link href="/" className="btn btn-primary">Run a scan</Link>
        </div>
      </div>
    );
  }

  const maxDay = Math.max(...stats.days.map((d) => d.cost), 0.0001);
  const maxCampaign = Math.max(...stats.topCampaigns.map((c) => c[1]), 0.0001);

  // Phases for breakdown rendering — exclude `total`
  const phaseKeys: (keyof CostBreakdown)[] = ["scoring", "drafting", "authorSummary", "expansion", "apify"];

  return (
    <div className="max-w-5xl mx-auto px-6 pt-16 pb-20">
      <h1 className="font-display text-5xl tracking-tightest mb-2">Costs</h1>
      <p className="text-[var(--text-dim)] mb-10">Per-scan spend across all providers.</p>

      {/* Top stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-10">
        <StatCard label="Total spend" value={fmt(stats.totals.total)} sub={`${stats.withCostCount} scans`} />
        <StatCard label="Last 7 days" value={fmt(stats.last7Total)} sub={`${stats.last7Count} scans`} />
        <StatCard label="Avg per scan" value={fmt(stats.avgPerScan)} sub="across tracked" />
        <StatCard label="All scans" value={String(stats.scanCount)} sub={`${stats.scanCount - stats.withCostCount} pre-tracking`} />
      </div>

      {/* Breakdown by phase */}
      <section className="card p-5 mb-6">
        <div className="text-[11px] font-mono uppercase tracking-[0.18em] text-[var(--text-faint)] mb-4">
          Spend by phase
        </div>
        <div className="space-y-2">
          {phaseKeys.map((k) => {
            const v = stats.totals[k];
            const pct = stats.totals.total > 0 ? (v / stats.totals.total) * 100 : 0;
            return (
              <div key={k} className="flex items-center gap-3 text-sm">
                <div className="w-32 text-[var(--text-dim)] text-[13px]">{PHASE_LABELS[k]}</div>
                <div className="flex-1 h-2 bg-[var(--bg-elev-2)] rounded overflow-hidden">
                  <div
                    className="h-full transition-all duration-500"
                    style={{ width: `${pct}%`, backgroundColor: PHASE_COLORS[k] }}
                  />
                </div>
                <div className="w-20 text-right font-mono text-[12px] text-[var(--text-dim)]">{fmt(v)}</div>
                <div className="w-12 text-right font-mono text-[11px] text-[var(--text-faint)]">{pct.toFixed(0)}%</div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Last 14 days bar chart */}
      <section className="card p-5 mb-6">
        <div className="text-[11px] font-mono uppercase tracking-[0.18em] text-[var(--text-faint)] mb-4">
          Daily spend (last 14 days)
        </div>
        <div className="flex items-end gap-1 h-32">
          {stats.days.map((d) => {
            const h = maxDay > 0 ? (d.cost / maxDay) * 100 : 0;
            const isToday = d.day === new Date().toISOString().slice(0, 10);
            return (
              <div key={d.day} className="flex-1 flex flex-col items-center gap-1 group relative">
                <div
                  className="w-full bg-[var(--amber)] rounded-t transition-all"
                  style={{ height: `${h}%`, opacity: d.cost > 0 ? (isToday ? 1 : 0.7) : 0.15 }}
                  title={`${d.day}: ${fmt(d.cost)}`}
                />
                {d.cost > 0 && (
                  <div className="absolute -top-6 opacity-0 group-hover:opacity-100 transition-opacity text-[10px] font-mono text-[var(--text)] bg-[var(--bg-elev)] px-1.5 py-0.5 rounded border hairline whitespace-nowrap pointer-events-none">
                    {fmt(d.cost)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="flex justify-between mt-2 text-[10px] font-mono text-[var(--text-faint)]">
          <span>{stats.days[0].day.slice(5)}</span>
          <span>{stats.days[stats.days.length - 1].day.slice(5)}</span>
        </div>
      </section>

      {/* Top campaigns */}
      {stats.topCampaigns.length > 0 && (
        <section className="card p-5 mb-6">
          <div className="text-[11px] font-mono uppercase tracking-[0.18em] text-[var(--text-faint)] mb-4">
            Spend by campaign
          </div>
          <div className="space-y-2">
            {stats.topCampaigns.map(([name, cost]) => {
              const pct = (cost / maxCampaign) * 100;
              return (
                <div key={name} className="flex items-center gap-3 text-sm">
                  <div className="w-48 truncate text-[var(--text-dim)] text-[13px] font-mono">{name}</div>
                  <div className="flex-1 h-2 bg-[var(--bg-elev-2)] rounded overflow-hidden">
                    <div
                      className="h-full bg-[var(--amber)] transition-all duration-500"
                      style={{ width: `${pct}%`, opacity: 0.7 }}
                    />
                  </div>
                  <div className="w-20 text-right font-mono text-[12px] text-[var(--text-dim)]">{fmt(cost)}</div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Per-scan table */}
      <section className="card p-5">
        <div className="text-[11px] font-mono uppercase tracking-[0.18em] text-[var(--text-faint)] mb-4">
          Per scan
        </div>
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-[12px] font-mono">
            <thead>
              <tr className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-faint)] border-b hairline">
                <th className="text-left py-2 px-2 font-normal">When</th>
                <th className="text-left px-2 font-normal">Campaign</th>
                <th className="text-right px-2 font-normal">Signals</th>
                <th className="text-right px-2 font-normal">Scoring</th>
                <th className="text-right px-2 font-normal">Drafts</th>
                <th className="text-right px-2 font-normal">Author</th>
                <th className="text-right px-2 font-normal">Expand</th>
                <th className="text-right px-2 font-normal">Apify</th>
                <th className="text-right px-2 font-normal text-[var(--amber)]">Total</th>
              </tr>
            </thead>
            <tbody>
              {scans
                .filter((s) => (s.costUsd ?? 0) > 0)
                .slice(0, 50)
                .map((s) => (
                  <tr key={s.id} className="border-b hairline last:border-0 hover:bg-[var(--bg-elev-2)]/50 transition-colors">
                    <td className="py-2 px-2 text-[var(--text-dim)] whitespace-nowrap">
                      <Link href={`/scan/${s.id}`} className="hover:text-[var(--amber)] transition-colors">
                        {s.createdAt.slice(5, 16).replace("T", " ")}
                      </Link>
                    </td>
                    <td className="px-2 text-[var(--text-dim)] truncate max-w-[160px]">
                      {s.campaignKey ?? <span className="text-[var(--text-faint)]">—</span>}
                    </td>
                    <td className="text-right px-2 text-[var(--text-dim)]">{s.signalCount}</td>
                    <td className="text-right px-2 text-[var(--text-faint)]">{fmt(s.costs?.scoring)}</td>
                    <td className="text-right px-2 text-[var(--text-faint)]">{fmt(s.costs?.drafting)}</td>
                    <td className="text-right px-2 text-[var(--text-faint)]">{fmt(s.costs?.authorSummary)}</td>
                    <td className="text-right px-2 text-[var(--text-faint)]">{fmt(s.costs?.expansion)}</td>
                    <td className="text-right px-2 text-[var(--text-faint)]">{fmt(s.costs?.apify)}</td>
                    <td className="text-right px-2 text-[var(--amber)] font-medium">{fmt(s.costUsd)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          {scans.filter((s) => (s.costUsd ?? 0) > 0).length > 50 && (
            <div className="text-[11px] font-mono text-[var(--text-faint)] mt-2 text-center">
              Showing latest 50 of {scans.filter((s) => (s.costUsd ?? 0) > 0).length} costed scans
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card p-4">
      <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-[var(--text-faint)] mb-1.5">{label}</div>
      <div className="font-display text-3xl tracking-tightest text-[var(--text)]">{value}</div>
      {sub && <div className="text-[11px] font-mono text-[var(--text-faint)] mt-1">{sub}</div>}
    </div>
  );
}

function fmt(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}
