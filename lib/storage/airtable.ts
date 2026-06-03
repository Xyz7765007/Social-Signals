/**
 * Airtable Storage adapter — self-bootstrapping schema.
 *
 * Activates when AIRTABLE_API_KEY + AIRTABLE_BASE_ID are set.
 *
 * On first use, the adapter:
 *   1. Reads the base's current schema via the Metadata API
 *   2. Creates any missing tables (with all required fields)
 *   3. Adds any missing fields to existing tables
 *   4. Patches single-select fields to add any missing options
 *   5. Never deletes or modifies existing fields/data
 *
 * PAT scopes required (https://airtable.com/create/tokens):
 *   data.records:read
 *   data.records:write
 *   schema.bases:read     ← to detect what exists
 *   schema.bases:write    ← to create/extend tables (only used on first init)
 *
 * If schema.bases:write is missing but the tables already exist with the right
 * fields, everything still works — write scope is only needed for bootstrap.
 *
 * Schema sync runs at most once per process via a cached Promise. If it fails,
 * the cache is cleared so the next call retries (e.g. user grants the scope
 * and tries again without restarting).
 */

import type { Scan, ScanPreset } from "../types";
import type { Storage } from "./index";
import { fetchWithRetry } from "../fetch-retry";

const API_BASE = "https://api.airtable.com/v0";

// ─── Schema definition ──────────────────────────────────────────────────────
// These must stay in sync with the actual write paths below.

const STATUS_VALUES = [
  "queued", "expanding", "fetching", "fetching_comments",
  "enriching", "scoring", "drafting", "pushing", "complete", "failed",
];
const TIME_WINDOWS = ["hour", "day", "week", "month"];

interface FieldSpec {
  name: string;
  type: string;
  options?: Record<string, any>;
}

type WhichTable = "scans" | "seen" | "presets";

const SCHEMA: Record<WhichTable, { fields: FieldSpec[] }> = {
  scans: {
    fields: [
      { name: "Scan ID", type: "singleLineText" },
      {
        name: "Created At",
        type: "dateTime",
        options: {
          dateFormat: { name: "iso" },
          timeFormat: { name: "24hour" },
          timeZone: "utc",
        },
      },
      {
        name: "Status",
        type: "singleSelect",
        options: { choices: STATUS_VALUES.map((name) => ({ name })) },
      },
      { name: "Business", type: "multilineText" },
      {
        name: "Time Window",
        type: "singleSelect",
        options: { choices: TIME_WINDOWS.map((name) => ({ name })) },
      },
      { name: "Signal Count", type: "number", options: { precision: 0 } },
      { name: "Cost USD", type: "number", options: { precision: 4 } },
      { name: "Duration s", type: "number", options: { precision: 1 } },
      { name: "Scan JSON", type: "multilineText" },
    ],
  },
  seen: {
    fields: [
      { name: "Campaign Key", type: "singleLineText" },
      { name: "Seen IDs JSON", type: "multilineText" },
      {
        name: "Updated At",
        type: "dateTime",
        options: {
          dateFormat: { name: "iso" },
          timeFormat: { name: "24hour" },
          timeZone: "utc",
        },
      },
    ],
  },
  presets: {
    fields: [
      { name: "Preset ID", type: "singleLineText" },
      { name: "Name", type: "singleLineText" },
      {
        name: "Created At",
        type: "dateTime",
        options: {
          dateFormat: { name: "iso" },
          timeFormat: { name: "24hour" },
          timeZone: "utc",
        },
      },
      {
        name: "Updated At",
        type: "dateTime",
        options: {
          dateFormat: { name: "iso" },
          timeFormat: { name: "24hour" },
          timeZone: "utc",
        },
      },
      { name: "Input JSON", type: "multilineText" },
    ],
  },
};

// ─── Metadata API types ────────────────────────────────────────────────────

interface ATRecord { id: string; fields: Record<string, any>; }
interface MetaField { id: string; name: string; type: string; options?: any; }
interface MetaTable { id: string; name: string; fields: MetaField[]; primaryFieldId: string; }

// ─── Storage class ─────────────────────────────────────────────────────────

class AirtableStorage implements Storage {
  private schemaReady: Promise<void> | null = null;
  private tableIds: Record<WhichTable, string | null> = { scans: null, seen: null, presets: null };

  constructor(
    private readonly apiKey: string,
    private readonly baseId: string,
    private readonly scansTable: string,
    private readonly seenTable: string,
    private readonly presetsTable: string,
  ) {}

  private nameOf(which: WhichTable): string {
    if (which === "scans") return this.scansTable;
    if (which === "seen") return this.seenTable;
    return this.presetsTable;
  }

  private url(table: string, suffix = ""): string {
    return `${API_BASE}/${this.baseId}/${encodeURIComponent(table)}${suffix}`;
  }
  private headers(): HeadersInit {
    return { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" };
  }

  // ─── Schema bootstrap ─────────────────────────────────────────────────────

  private async ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = this.initSchema().catch((err) => {
        this.schemaReady = null; // allow retry on next call
        throw err;
      });
    }
    return this.schemaReady;
  }

  private async initSchema(): Promise<void> {
    const metaUrl = `${API_BASE}/meta/bases/${this.baseId}/tables`;
    const res = await fetchWithRetry(metaUrl, { headers: this.headers() });

    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 300);
      if (res.status === 401) {
        throw new Error(`Airtable auth failed (401). Check AIRTABLE_API_KEY is valid. ${text}`);
      }
      if (res.status === 403) {
        throw new Error(
          `Airtable forbidden (403) reading base schema. Your PAT is missing the 'schema.bases:read' scope. ` +
          `Fix at https://airtable.com/create/tokens — required scopes: data.records:read, data.records:write, schema.bases:read, schema.bases:write.`
        );
      }
      if (res.status === 404) {
        throw new Error(`Airtable base "${this.baseId}" not found or token has no access. Check AIRTABLE_BASE_ID.`);
      }
      throw new Error(`Airtable meta fetch failed (${res.status}): ${text}`);
    }

    const data: any = await res.json();
    const existingByName = new Map<string, MetaTable>();
    for (const t of (data.tables ?? []) as MetaTable[]) existingByName.set(t.name, t);

    for (const which of ["scans", "seen", "presets"] as const) {
      const name = this.nameOf(which);
      const existing = existingByName.get(name);
      if (!existing) {
        const id = await this.createTable(name, SCHEMA[which].fields);
        this.tableIds[which] = id;
      } else {
        this.tableIds[which] = existing.id;
        await this.syncTableFields(existing, SCHEMA[which].fields);
      }
    }
  }

  private async createTable(name: string, fields: FieldSpec[]): Promise<string> {
    const url = `${API_BASE}/meta/bases/${this.baseId}/tables`;
    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        name,
        fields: fields.map((f) => ({ name: f.name, type: f.type, options: f.options })),
      }),
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 400);
      if (res.status === 403) {
        throw new Error(
          `Airtable can't create table "${name}" (403). PAT needs 'schema.bases:write' scope. ` +
          `Either grant it at https://airtable.com/create/tokens, or create the table manually with these fields:\n` +
          fields.map((f) => `  • ${f.name} (${humanType(f)})`).join("\n")
        );
      }
      throw new Error(`Airtable create table "${name}" failed (${res.status}): ${text}`);
    }
    const data: any = await res.json();
    return String(data.id);
  }

  private async syncTableFields(table: MetaTable, required: FieldSpec[]): Promise<void> {
    const existingByName = new Map<string, MetaField>();
    for (const f of table.fields ?? []) existingByName.set(f.name, f);

    for (const spec of required) {
      const existing = existingByName.get(spec.name);

      if (!existing) {
        await this.addField(table.id, table.name, spec);
        continue;
      }

      // Single-select: ensure all required choices exist on the field
      if (spec.type === "singleSelect" && spec.options?.choices) {
        const haveNames = new Set<string>((existing.options?.choices ?? []).map((c: any) => c.name));
        const wantNames = (spec.options.choices as { name: string }[]).map((c) => c.name);
        const missing = wantNames.filter((n) => !haveNames.has(n));
        if (missing.length > 0) {
          await this.addSelectChoices(
            table.id, table.name, existing,
            existing.options?.choices ?? [],
            missing.map((name) => ({ name })),
          );
        }
      }
      // Note: we intentionally do NOT alter existing field types — that could
      // destroy data. If types mismatch, downstream writes will fail with a
      // clearer Airtable error that surfaces to the user.
    }
  }

  private async addField(tableId: string, tableName: string, field: FieldSpec): Promise<void> {
    const url = `${API_BASE}/meta/bases/${this.baseId}/tables/${tableId}/fields`;
    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ name: field.name, type: field.type, options: field.options }),
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 400);
      if (res.status === 403) {
        throw new Error(
          `Airtable can't add field "${field.name}" to "${tableName}" (403). PAT needs 'schema.bases:write' scope. ` +
          `Or add manually: ${field.name} (${humanType(field)}).`
        );
      }
      throw new Error(`Airtable add field "${field.name}" failed (${res.status}): ${text}`);
    }
  }

  private async addSelectChoices(
    tableId: string, tableName: string, field: MetaField,
    existingChoices: any[], newChoices: { name: string }[],
  ): Promise<void> {
    const url = `${API_BASE}/meta/bases/${this.baseId}/tables/${tableId}/fields/${field.id}`;
    // PATCH with the UNION so we never drop an option a user added manually.
    const all = [
      ...existingChoices.map((c: any) => ({ id: c.id, name: c.name, color: c.color })),
      ...newChoices,
    ];
    const res = await fetchWithRetry(url, {
      method: "PATCH",
      headers: this.headers(),
      body: JSON.stringify({ options: { choices: all } }),
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 400);
      // Non-fatal: log and continue — writes that need the new option will fail
      // with a clear Airtable error, but writes using existing options still work.
      console.warn(`Airtable: couldn't add options to "${field.name}" on "${tableName}" (${res.status}): ${text}`);
    }
  }

  // ─── Lookup helpers (shared) ──────────────────────────────────────────────

  private async find(table: string, formula: string): Promise<ATRecord | null> {
    const url = `${this.url(table)}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;
    const res = await fetchWithRetry(url, { headers: this.headers() });
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
    await this.ensureSchema();
    const url = `${this.url(this.scansTable)}?pageSize=100&sort%5B0%5D%5Bfield%5D=Created+At&sort%5B0%5D%5Bdirection%5D=desc`;
    const res = await fetchWithRetry(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`Airtable list failed: ${res.status} ${await res.text()}`);
    const data: any = await res.json();
    return (data.records ?? []).map((r: ATRecord) => this.fromScanRecord(r)).filter((s: any): s is Scan => s !== null);
  }
  async get(id: string) {
    await this.ensureSchema();
    const r = await this.find(this.scansTable, `{Scan ID}='${id.replace(/'/g, "\\'")}'`);
    return r ? this.fromScanRecord(r) : null;
  }
  async put(scan: Scan) {
    await this.ensureSchema();
    const fields = this.toScanFields(scan);
    if ((fields["Scan JSON"] as string).length > 95_000) {
      throw new Error(
        `Scan JSON too large for Airtable cell (${(fields["Scan JSON"] as string).length} chars; cap ~100k). ` +
        `Reduce maxResults or disable comment/draft features for this scan.`
      );
    }
    const existing = await this.find(this.scansTable, `{Scan ID}='${scan.id.replace(/'/g, "\\'")}'`);
    if (existing) {
      const res = await fetchWithRetry(this.url(this.scansTable, `/${existing.id}`), {
        method: "PATCH", headers: this.headers(), body: JSON.stringify({ fields }),
      });
      if (!res.ok) throw new Error(`Airtable update failed: ${res.status} ${await res.text()}`);
    } else {
      const res = await fetchWithRetry(this.url(this.scansTable), {
        method: "POST", headers: this.headers(), body: JSON.stringify({ records: [{ fields }] }),
      });
      if (!res.ok) throw new Error(`Airtable create failed: ${res.status} ${await res.text()}`);
    }
  }
  async delete(id: string) {
    await this.ensureSchema();
    const r = await this.find(this.scansTable, `{Scan ID}='${id.replace(/'/g, "\\'")}'`);
    if (!r) return;
    const res = await fetchWithRetry(this.url(this.scansTable, `/${r.id}`), { method: "DELETE", headers: this.headers() });
    if (!res.ok) throw new Error(`Airtable delete failed: ${res.status} ${await res.text()}`);
  }

  // ─── Seen Signals ─────────────────────────────────────────────────────────

  async getSeen(campaignKey: string) {
    await this.ensureSchema();
    const r = await this.find(this.seenTable, `{Campaign Key}='${campaignKey.replace(/'/g, "\\'")}'`);
    if (!r) return new Set<string>();
    try { return new Set(JSON.parse(r.fields["Seen IDs JSON"] ?? "[]") as string[]); }
    catch { return new Set<string>(); }
  }
  async addSeen(campaignKey: string, ids: string[]) {
    await this.ensureSchema();
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
      const res = await fetchWithRetry(this.url(this.seenTable, `/${existing.id}`), {
        method: "PATCH", headers: this.headers(), body: JSON.stringify({ fields }),
      });
      if (!res.ok) throw new Error(`Airtable seen update failed: ${res.status} ${await res.text()}`);
    } else {
      const res = await fetchWithRetry(this.url(this.seenTable), {
        method: "POST", headers: this.headers(), body: JSON.stringify({ records: [{ fields }] }),
      });
      if (!res.ok) throw new Error(`Airtable seen create failed: ${res.status} ${await res.text()}`);
    }
  }

  // ─── Presets ──────────────────────────────────────────────────────────────

  private toPresetFields(p: ScanPreset) {
    return {
      "Preset ID": p.id,
      Name: p.name,
      "Created At": p.createdAt,
      "Updated At": p.updatedAt,
      "Input JSON": JSON.stringify(p.input),
    };
  }
  private fromPresetRecord(r: ATRecord): ScanPreset | null {
    try {
      const input = JSON.parse(r.fields["Input JSON"] ?? "null");
      if (!input) return null;
      return {
        id: String(r.fields["Preset ID"] ?? ""),
        name: String(r.fields["Name"] ?? ""),
        createdAt: String(r.fields["Created At"] ?? new Date().toISOString()),
        updatedAt: String(r.fields["Updated At"] ?? new Date().toISOString()),
        input,
      };
    } catch { return null; }
  }

  async listPresets() {
    await this.ensureSchema();
    const url = `${this.url(this.presetsTable)}?pageSize=100&sort%5B0%5D%5Bfield%5D=Updated+At&sort%5B0%5D%5Bdirection%5D=desc`;
    const res = await fetchWithRetry(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`Airtable presets list failed: ${res.status} ${await res.text()}`);
    const data: any = await res.json();
    return (data.records ?? []).map((r: ATRecord) => this.fromPresetRecord(r)).filter((p: any): p is ScanPreset => p !== null);
  }
  async getPreset(id: string) {
    await this.ensureSchema();
    const r = await this.find(this.presetsTable, `{Preset ID}='${id.replace(/'/g, "\\'")}'`);
    return r ? this.fromPresetRecord(r) : null;
  }
  async putPreset(preset: ScanPreset) {
    await this.ensureSchema();
    const fields = this.toPresetFields(preset);
    if ((fields["Input JSON"] as string).length > 95_000) {
      throw new Error(
        `Preset Input JSON too large for Airtable cell (${(fields["Input JSON"] as string).length} chars).`,
      );
    }
    const existing = await this.find(this.presetsTable, `{Preset ID}='${preset.id.replace(/'/g, "\\'")}'`);
    if (existing) {
      const res = await fetchWithRetry(this.url(this.presetsTable, `/${existing.id}`), {
        method: "PATCH", headers: this.headers(), body: JSON.stringify({ fields }),
      });
      if (!res.ok) throw new Error(`Airtable preset update failed: ${res.status} ${await res.text()}`);
    } else {
      const res = await fetchWithRetry(this.url(this.presetsTable), {
        method: "POST", headers: this.headers(), body: JSON.stringify({ records: [{ fields }] }),
      });
      if (!res.ok) throw new Error(`Airtable preset create failed: ${res.status} ${await res.text()}`);
    }
  }
  async deletePreset(id: string) {
    await this.ensureSchema();
    const r = await this.find(this.presetsTable, `{Preset ID}='${id.replace(/'/g, "\\'")}'`);
    if (!r) return;
    const res = await fetchWithRetry(this.url(this.presetsTable, `/${r.id}`), { method: "DELETE", headers: this.headers() });
    if (!res.ok) throw new Error(`Airtable preset delete failed: ${res.status} ${await res.text()}`);
  }
}

function humanType(f: FieldSpec): string {
  if (f.type === "singleSelect") {
    const choices = (f.options?.choices as { name: string }[] | undefined)?.map((c) => c.name).join(", ");
    return `single select: ${choices ?? "?"}`;
  }
  if (f.type === "dateTime") return "date with time";
  if (f.type === "multilineText") return "long text";
  if (f.type === "singleLineText") return "single line text";
  if (f.type === "number") return `number (precision ${f.options?.precision ?? 0})`;
  return f.type;
}

export function maybeAirtable(): Storage | null {
  const apiKey = process.env.AIRTABLE_API_KEY;
  const baseId = process.env.AIRTABLE_BASE_ID;
  const scansTable = process.env.AIRTABLE_TABLE_NAME ?? "Scans";
  const seenTable = process.env.AIRTABLE_SEEN_TABLE_NAME ?? "Seen Signals";
  const presetsTable = process.env.AIRTABLE_PRESETS_TABLE_NAME ?? "Scan Presets";
  if (!apiKey || !baseId) return null;
  return new AirtableStorage(apiKey, baseId, scansTable, seenTable, presetsTable);
}
