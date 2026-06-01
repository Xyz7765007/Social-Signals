/**
 * GET /api/setup — Verify storage connection and bootstrap Airtable schema.
 *
 * Safe to hit anytime. Returns:
 *   { storage: "airtable" | "file" | "memory", ok: true }       — all good
 *   { storage: "airtable", ok: false, error: "..." }            — fix needed
 *
 * The schema sync runs lazily on first use, so calling this endpoint forces
 * the bootstrap to happen now (instead of on the first scan). Useful for
 * verifying setup during deployment.
 */

import { NextResponse } from "next/server";
import { storage } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const useAirtable = Boolean(process.env.AIRTABLE_API_KEY && process.env.AIRTABLE_BASE_ID);
  const storageType = useAirtable
    ? "airtable"
    : process.env.VERCEL === "1" || process.env.NODE_ENV === "production"
    ? "memory"
    : "file";

  try {
    // Trigger a no-op operation that forces schema init for Airtable
    await storage.list();
    return NextResponse.json({
      storage: storageType,
      ok: true,
      ...(storageType === "airtable" && {
        base: process.env.AIRTABLE_BASE_ID,
        scansTable: process.env.AIRTABLE_TABLE_NAME ?? "Scans",
        seenTable: process.env.AIRTABLE_SEEN_TABLE_NAME ?? "Seen Signals",
      }),
      ...(storageType === "memory" && {
        warning: "Memory storage — scans vanish on cold start. Set AIRTABLE_API_KEY + AIRTABLE_BASE_ID for persistence.",
      }),
    });
  } catch (e: any) {
    return NextResponse.json({
      storage: storageType,
      ok: false,
      error: e?.message ?? String(e),
    }, { status: 500 });
  }
}
