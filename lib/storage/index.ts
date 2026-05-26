/**
 * Storage abstraction.
 *
 * Default: file-based at .data/scans.json (works locally; ephemeral on Vercel).
 * For production on Vercel, swap to KV/Postgres/Airtable by implementing the
 * `Storage` interface and exporting an instance from this file.
 *
 * Why file-based as default: zero setup for `npm run dev`. Swap is one file edit.
 */

import { promises as fs } from "fs";
import path from "path";
import type { Scan } from "../types";

export interface Storage {
  list(): Promise<Scan[]>;
  get(id: string): Promise<Scan | null>;
  put(scan: Scan): Promise<void>;
  delete(id: string): Promise<void>;
}

const DATA_DIR = path.join(process.cwd(), ".data");
const SCANS_FILE = path.join(DATA_DIR, "scans.json");

async function ensure(): Promise<void> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.access(SCANS_FILE);
  } catch {
    await fs.writeFile(SCANS_FILE, "[]", "utf8");
  }
}

async function readAll(): Promise<Scan[]> {
  await ensure();
  const raw = await fs.readFile(SCANS_FILE, "utf8");
  try {
    return JSON.parse(raw) as Scan[];
  } catch {
    return [];
  }
}

async function writeAll(scans: Scan[]): Promise<void> {
  await ensure();
  await fs.writeFile(SCANS_FILE, JSON.stringify(scans, null, 2), "utf8");
}

class FileStorage implements Storage {
  async list(): Promise<Scan[]> {
    const all = await readAll();
    return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async get(id: string): Promise<Scan | null> {
    const all = await readAll();
    return all.find((s) => s.id === id) ?? null;
  }
  async put(scan: Scan): Promise<void> {
    const all = await readAll();
    const idx = all.findIndex((s) => s.id === scan.id);
    if (idx === -1) all.push(scan);
    else all[idx] = scan;
    await writeAll(all);
  }
  async delete(id: string): Promise<void> {
    const all = await readAll();
    await writeAll(all.filter((s) => s.id !== id));
  }
}

// In-memory shim for serverless cold starts — same process keeps state warm.
// On Vercel/serverless this only persists for the function lifetime; production
// should switch to KV/Postgres/Airtable adapter.
class MemoryStorage implements Storage {
  private store = new Map<string, Scan>();
  async list() {
    return Array.from(this.store.values()).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    );
  }
  async get(id: string) {
    return this.store.get(id) ?? null;
  }
  async put(scan: Scan) {
    this.store.set(scan.id, scan);
  }
  async delete(id: string) {
    this.store.delete(id);
  }
}

const useMemory = process.env.VERCEL === "1" || process.env.NODE_ENV === "production";

// Avoid re-instantiating across hot reloads.
const g = globalThis as any;
export const storage: Storage =
  g.__pulseStorage ?? (g.__pulseStorage = useMemory ? new MemoryStorage() : new FileStorage());
