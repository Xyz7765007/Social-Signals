/**
 * Storage abstraction.
 *
 * Default: file-based at .data/{scans.json,seen.json} for local dev.
 * Memory: ephemeral in-process for serverless without external store.
 * Airtable: see ./airtable.ts (drop-in when env vars are set).
 *
 * Scan storage holds full Scan records.
 * Seen storage holds Set<externalId> per campaignKey for cross-scan dedup.
 */

import { promises as fs } from "fs";
import path from "path";
import type { Scan, ScanPreset } from "../types";

export interface Storage {
  list(): Promise<Scan[]>;
  get(id: string): Promise<Scan | null>;
  put(scan: Scan): Promise<void>;
  delete(id: string): Promise<void>;

  // Campaign-level cross-scan dedup
  getSeen(campaignKey: string): Promise<Set<string>>;
  addSeen(campaignKey: string, ids: string[]): Promise<void>;

  // Saved scan setups (templates that can be loaded into the form)
  listPresets(): Promise<ScanPreset[]>;
  getPreset(id: string): Promise<ScanPreset | null>;
  putPreset(preset: ScanPreset): Promise<void>;
  deletePreset(id: string): Promise<void>;
}

const DATA_DIR = path.join(process.cwd(), ".data");
const SCANS_FILE = path.join(DATA_DIR, "scans.json");
const SEEN_FILE = path.join(DATA_DIR, "seen.json");
const PRESETS_FILE = path.join(DATA_DIR, "presets.json");

async function ensureDir(): Promise<void> {
  try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch {}
}
async function readJson<T>(file: string, fallback: T): Promise<T> {
  await ensureDir();
  try { return JSON.parse(await fs.readFile(file, "utf8")) as T; } catch { return fallback; }
}
async function writeJson(file: string, data: unknown): Promise<void> {
  await ensureDir();
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

class FileStorage implements Storage {
  async list() {
    const all = await readJson<Scan[]>(SCANS_FILE, []);
    return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async get(id: string) {
    const all = await readJson<Scan[]>(SCANS_FILE, []);
    return all.find((s) => s.id === id) ?? null;
  }
  async put(scan: Scan) {
    const all = await readJson<Scan[]>(SCANS_FILE, []);
    const idx = all.findIndex((s) => s.id === scan.id);
    if (idx === -1) all.push(scan); else all[idx] = scan;
    await writeJson(SCANS_FILE, all);
  }
  async delete(id: string) {
    const all = await readJson<Scan[]>(SCANS_FILE, []);
    await writeJson(SCANS_FILE, all.filter((s) => s.id !== id));
  }
  async getSeen(campaignKey: string) {
    const seen = await readJson<Record<string, string[]>>(SEEN_FILE, {});
    return new Set(seen[campaignKey] ?? []);
  }
  async addSeen(campaignKey: string, ids: string[]) {
    const seen = await readJson<Record<string, string[]>>(SEEN_FILE, {});
    const set = new Set(seen[campaignKey] ?? []);
    for (const id of ids) set.add(id);
    // Cap at 5000 IDs per campaign to bound file size — drop oldest if exceeded
    const arr = Array.from(set);
    seen[campaignKey] = arr.slice(-5000);
    await writeJson(SEEN_FILE, seen);
  }
  async listPresets() {
    const all = await readJson<ScanPreset[]>(PRESETS_FILE, []);
    return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async getPreset(id: string) {
    const all = await readJson<ScanPreset[]>(PRESETS_FILE, []);
    return all.find((p) => p.id === id) ?? null;
  }
  async putPreset(preset: ScanPreset) {
    const all = await readJson<ScanPreset[]>(PRESETS_FILE, []);
    const idx = all.findIndex((p) => p.id === preset.id);
    if (idx === -1) all.push(preset); else all[idx] = preset;
    await writeJson(PRESETS_FILE, all);
  }
  async deletePreset(id: string) {
    const all = await readJson<ScanPreset[]>(PRESETS_FILE, []);
    await writeJson(PRESETS_FILE, all.filter((p) => p.id !== id));
  }
}

class MemoryStorage implements Storage {
  private store = new Map<string, Scan>();
  private seen = new Map<string, Set<string>>();
  private presets = new Map<string, ScanPreset>();
  async list() { return Array.from(this.store.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  async get(id: string) { return this.store.get(id) ?? null; }
  async put(scan: Scan) { this.store.set(scan.id, scan); }
  async delete(id: string) { this.store.delete(id); }
  async getSeen(campaignKey: string) { return new Set(this.seen.get(campaignKey) ?? []); }
  async addSeen(campaignKey: string, ids: string[]) {
    const cur = this.seen.get(campaignKey) ?? new Set<string>();
    for (const id of ids) cur.add(id);
    this.seen.set(campaignKey, cur);
  }
  async listPresets() {
    return Array.from(this.presets.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async getPreset(id: string) { return this.presets.get(id) ?? null; }
  async putPreset(preset: ScanPreset) { this.presets.set(preset.id, preset); }
  async deletePreset(id: string) { this.presets.delete(id); }
}

const useMemory = process.env.VERCEL === "1" || process.env.NODE_ENV === "production";
const g = globalThis as any;

function selectStorage(): Storage {
  const { maybeAirtable } = require("./airtable") as typeof import("./airtable");
  const airtable = maybeAirtable();
  if (airtable) return airtable;
  return useMemory ? new MemoryStorage() : new FileStorage();
}

export const storage: Storage = g.__pulseStorage ?? (g.__pulseStorage = selectStorage());

export { FileStorage, MemoryStorage };
