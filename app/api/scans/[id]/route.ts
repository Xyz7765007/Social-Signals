import { NextRequest, NextResponse } from "next/server";
import { storage } from "@/lib/storage";
import type { Scan } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// When a scan hasn't been written to in this long while still "in progress",
// we surface it as stalled (most likely Vercel hit its maxDuration). Frontend
// can show the user "this looks stuck" without us mutating the scan record.
const STALL_MS = 4 * 60 * 1000; // 4 min — well over normal scan time

function detectStall(scan: Scan): Scan {
  const inProgress =
    scan.progress.status !== "complete" && scan.progress.status !== "failed";
  if (!inProgress) return scan;
  const last = new Date(scan.updatedAt ?? scan.createdAt).getTime();
  const age = Date.now() - last;
  if (age < STALL_MS) return scan;
  return {
    ...scan,
    progress: {
      ...scan.progress,
      message: `${scan.progress.message} — no updates for ${Math.round(age / 1000)}s. The scan likely hit the 300s execution limit. Try again with fewer signals or simpler input.`,
    },
  };
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const scan = await storage.get(params.id);
    if (!scan) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(detectStall(scan));
  } catch (e: any) {
    console.error("GET /api/scans/[id] failed:", e);
    return NextResponse.json(
      { error: `Storage error: ${e?.message ?? "unknown"}` },
      { status: 500 },
    );
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await storage.delete(params.id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("DELETE /api/scans/[id] failed:", e);
    return NextResponse.json(
      { error: `Storage error: ${e?.message ?? "unknown"}` },
      { status: 500 },
    );
  }
}
