/**
 * Airtable Storage adapter.
 *
 * Activates when AIRTABLE_API_KEY + AIRTABLE_BASE_ID are set.
 *
 * Schemas expected:
 *
 *   Table "Scans"  (default name; override via AIRTABLE_TABLE_NAME)
 *     Scan ID         single line text (primary)
 *     Created At      date (with time)
 *     Status          single select
 *     Business        long text
 *     Time Window     single select
 *     Signal Count    number
 *     Cost USD        number
 *     Duration s      number
 *     Scan JSON       long text   ← source of truth
 *
 *   Table "Seen Signals"  (default name; override via AIRTABLE_SEEN_TABLE_NAME)
 *     Campaign Key    single line text (primary)
 *     Seen IDs JSON   long text   ← JSON array of externalIds, capped at 5000
 *     Updated At      date (with time)
 */

import type { Scan } from "../types";
import type { Storage } from "./index";

const API_BASE = "https://api.airtable.com/v0";

interface ATRecord { id: string; fields: Record<string, any>; }

class AirtableStorage implements Storage {
  constructor(
    private readonly apiKey: string,
    private readonly baseId: string,
    private readonly scansTable: string,
    private readonly seenTable: string,
  ) {}

  private url(table: string, suffix = ""): string {
    return `${API_BASE}/${this.baseId}/${encodeURIComponent(table)}${suffix}`;
  }
  private headers(): HeadersInit {
    return { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" };
  }

  private async find(table: string, formula: string): Promise<ATRecord | null> {
    const url = `${this.url(table)}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`Airtable lookup failed: ${res.status} ${await res.text()}`);
    const data: any = await res.json();
    return data.records?.[0] ?? null;
  }

  // ─── Scans ────────────────────────────────────────────────────────────────

  private toScanFields(scan: Scan) {
    return {
      "Scan ID": scan.id,
      "Created At": scan.createdAt,
      Status: scan.progress.status,
      Business: scan.input.businessDescription.slice(0, 500),
      "Time Window": scan.input.timeWindow,
      "Signal Count": scan.signals.length,
      "Cost USD": scan.stats?.costUsd ?? 0,
      "Duration s": scan.stats ? Math.round(scan.stats.durationMs / 100) / 10 : 0,
      "Scan JSON": JSON.stringify(scan),
    };
  }
  private fromScanRecord(r: ATRecord): Scan | null {
    try { return JSON.parse(r.fields["Scan JSON"]) as Scan; } catch { return null; }
  }

  async list() {
    const url = `${this.url(this.scansTable)}?pageSize=100&sort%5B0%5D%5Bfield%5D=Created+At&sort%5B0%5D%5Bdirection%5D=desc`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`Airtable list failed: ${res.status} ${await res.text()}`);
    const data: any = await res.json();
    return (data.records ?? []).map((r: ATRecord) => this.fromScanRecord(r)).filter((s: any): s is Scan => s !== null);
  }
  async get(id: string) {
    const r = await this.find(this.scansTable, `{Scan ID}='${id.replace(/'/g, "\\'")}'`);
    return r ? this.fromScanRecord(r) : null;
  }
  async put(scan: Scan) {
    const fields = this.toScanFields(scan);
    if ((fields["Scan JSON"] as string).length > 95_000) {
      throw new Error(`Scan JSON too large for Airtable cell (${(fields["Scan JSON"] as string).length}). Split signals to a linked table.`);
    }
    const existing = await this.find(this.scansTable, `{Scan ID}='${scan.id.replace(/'/g, "\\'")}'`);
    if (existing) {
      const res = await fetch(this.url(this.scansTable, `/${existing.id}`), {
        method: "PATCH", headers: this.headers(), body: JSON.stringify({ fields }),
      });
      if (!res.ok) throw new Error(`Airtable update failed: ${res.status} ${await res.text()}`);
    } else {
      const res = await fetch(this.url(this.scansTable), {
        method: "POST", headers: this.headers(), body: JSON.stringify({ records: [{ fields }] }),
      });
      if (!res.ok) throw new Error(`Airtable create failed: ${res.status} ${await res.text()}`);
    }
  }
  async delete(id: string) {
    const r = await this.find(this.scansTable, `{Scan ID}='${id.replace(/'/g, "\\'")}'`);
    if (!r) return;
    const res = await fetch(this.url(this.scansTable, `/${r.id}`), { method: "DELETE", headers: this.headers() });
    if (!res.ok) throw new Error(`Airtable delete failed: ${res.status} ${await res.text()}`);
  }

  // ─── Seen Signals (campaign dedup) ────────────────────────────────────────

  async getSeen(campaignKey: string) {
    const r = await this.find(this.seenTable, `{Campaign Key}='${campaignKey.replace(/'/g, "\\'")}'`);
    if (!r) return new Set<string>();
    try { return new Set(JSON.parse(r.fields["Seen IDs JSON"] ?? "[]") as string[]); }
    catch { return new Set<string>(); }
  }
  async addSeen(campaignKey: string, ids: string[]) {
    const existing = await this.find(this.seenTable, `{Campaign Key}='${campaignKey.replace(/'/g, "\\'")}'`);
    const cur = new Set<string>();
    if (existing) {
      try { for (const id of JSON.parse(existing.fields["Seen IDs JSON"] ?? "[]") as string[]) cur.add(id); } catch {}
    }
    for (const id of ids) cur.add(id);
    const arr = Array.from(cur).slice(-5000);
    const fields = {
      "Campaign Key": campaignKey,
      "Seen IDs JSON": JSON.stringify(arr),
      "Updated At": new Date().toISOString(),
    };
    if (existing) {
      const res = await fetch(this.url(this.seenTable, `/${existing.id}`), {
        method: "PATCH", headers: this.headers(), body: JSON.stringify({ fields }),
      });
      if (!res.ok) throw new Error(`Airtable seen update failed: ${res.status} ${await res.text()}`);
    } else {
      const res = await fetch(this.url(this.seenTable), {
        method: "POST", headers: this.headers(), body: JSON.stringify({ records: [{ fields }] }),
      });
      if (!res.ok) throw new Error(`Airtable seen create failed: ${res.status} ${await res.text()}`);
    }
  }
}

export function maybeAirtable(): Storage | null {
  const apiKey = process.env.AIRTABLE_API_KEY;
  const baseId = process.env.AIRTABLE_BASE_ID;
  const scansTable = process.env.AIRTABLE_TABLE_NAME ?? "Scans";
  const seenTable = process.env.AIRTABLE_SEEN_TABLE_NAME ?? "Seen Signals";
  if (!apiKey || !baseId) return null;
  return new AirtableStorage(apiKey, baseId, scansTable, seenTable);
}
