import { NextRequest, NextResponse } from "next/server";
import { storage } from "@/lib/storage";
import { createScan, runScan } from "@/lib/orchestrator";
import type { ScanInput, SignalType } from "@/lib/types";
import { SIGNAL_TYPES } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function validate(body: any): ScanInput | { error: string } {
  if (!body || typeof body !== "object") return { error: "Body required" };
  const businessDescription = String(body.businessDescription ?? "").trim();
  const icp = String(body.icp ?? "").trim();
  if (businessDescription.length < 10) {
    return { error: "Tell us what your business does (at least 10 characters)" };
  }
  if (icp.length < 5) {
    return { error: "Describe your ideal customer" };
  }
  const signalTypes: SignalType[] = Array.isArray(body.signalTypes)
    ? body.signalTypes.filter((t: any) => SIGNAL_TYPES.includes(t))
    : [];
  if (signalTypes.length === 0) {
    return { error: "Select at least one signal type" };
  }
  const timeWindow = ["hour", "day", "week", "month"].includes(body.timeWindow)
    ? body.timeWindow
    : "week";
  const maxResults = [10, 25, 50, 100].includes(Number(body.maxResults))
    ? Number(body.maxResults)
    : 25;
  const sources = Array.isArray(body.sources) && body.sources.length > 0
    ? body.sources.filter((s: any) => ["reddit", "twitter", "news", "instagram"].includes(s))
    : ["reddit"];

  const keywords = Array.isArray(body.keywords)
    ? body.keywords.map((k: any) => String(k).trim()).filter(Boolean).slice(0, 20)
    : undefined;
  const subreddits = Array.isArray(body.subreddits)
    ? body.subreddits.map((s: any) => String(s).trim().replace(/^\/?r\//i, "")).filter(Boolean).slice(0, 20)
    : undefined;

  return {
    businessDescription,
    icp,
    signalTypes,
    keywords,
    subreddits,
    timeWindow,
    maxResults,
    sources,
  };
}

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const v = validate(body);
  if ("error" in v) return NextResponse.json({ error: v.error }, { status: 400 });

  const scan = createScan(v);
  await storage.put(scan);

  // Fire-and-forget. The client will poll /api/scans/:id for progress.
  runScan(scan.id).catch((err) => {
    console.error("Scan failed", scan.id, err);
  });

  return NextResponse.json({ id: scan.id }, { status: 201 });
}

export async function GET() {
  const scans = await storage.list();
  // Strip large signal arrays from list view for speed.
  const lite = scans.map((s) => ({
    id: s.id,
    createdAt: s.createdAt,
    status: s.progress.status,
    message: s.progress.message,
    businessDescription: s.input.businessDescription.slice(0, 120),
    timeWindow: s.input.timeWindow,
    signalCount: s.signals.length,
  }));
  return NextResponse.json({ scans: lite });
}
