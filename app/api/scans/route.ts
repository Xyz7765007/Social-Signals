import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { storage } from "@/lib/storage";
import { createScan, runScan } from "@/lib/orchestrator";
import type { ScanInput, SignalType } from "@/lib/types";
import { SIGNAL_TYPES } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // Allow long-running scans on Vercel

function validate(body: any): ScanInput | { error: string } {
  if (!body || typeof body !== "object") return { error: "Body required" };
  const businessDescription = String(body.businessDescription ?? "").trim();
  const icp = String(body.icp ?? "").trim();
  if (businessDescription.length < 10) return { error: "Tell us what your business does (at least 10 characters)" };
  if (icp.length < 5) return { error: "Describe your ideal customer" };
  const signalTypes: SignalType[] = Array.isArray(body.signalTypes)
    ? body.signalTypes.filter((t: any) => SIGNAL_TYPES.includes(t)) : [];
  if (signalTypes.length === 0) return { error: "Select at least one signal type" };
  const timeWindow = ["hour", "day", "week", "month"].includes(body.timeWindow) ? body.timeWindow : "week";
  const maxResults = [10, 25, 50, 100].includes(Number(body.maxResults)) ? Number(body.maxResults) : 25;
  const sources = Array.isArray(body.sources) && body.sources.length > 0
    ? body.sources.filter((s: any) => ["reddit", "twitter", "news", "instagram"].includes(s))
    : ["reddit"];

  const keywords = Array.isArray(body.keywords)
    ? body.keywords.map((k: any) => String(k).trim()).filter(Boolean).slice(0, 30) : undefined;
  const subreddits = Array.isArray(body.subreddits)
    ? body.subreddits.map((s: any) => String(s).trim().replace(/^\/?r\//i, "")).filter(Boolean).slice(0, 30) : undefined;
  const antiSignals = Array.isArray(body.antiSignals)
    ? body.antiSignals.map((s: any) => String(s).trim()).filter(Boolean).slice(0, 20) : undefined;

  const campaignKey = body.campaignKey ? String(body.campaignKey).trim().slice(0, 120) || undefined : undefined;
  const voice = body.voice ? String(body.voice).trim().slice(0, 2000) || undefined : undefined;
  const draftReplies = typeof body.draftReplies === "boolean" ? body.draftReplies : true;
  const includeComments = typeof body.includeComments === "boolean" ? body.includeComments : true;
  const enrichAuthors = typeof body.enrichAuthors === "boolean" ? body.enrichAuthors : true;

  const hubspotToken = body.hubspotToken ? String(body.hubspotToken).trim() || undefined : undefined;
  const hubspotOwnerId = body.hubspotOwnerId ? String(body.hubspotOwnerId).trim() || undefined : undefined;
  const hubspotPushThreshold = typeof body.hubspotPushThreshold === "number"
    ? Math.max(0, Math.min(100, body.hubspotPushThreshold)) : undefined;

  return {
    businessDescription, icp, signalTypes,
    keywords, subreddits, antiSignals,
    timeWindow, maxResults, sources,
    campaignKey, voice,
    draftReplies, includeComments, enrichAuthors,
    hubspotToken, hubspotOwnerId, hubspotPushThreshold,
  };
}

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const v = validate(body);
  if ("error" in v) return NextResponse.json({ error: v.error }, { status: 400 });

  try {
    const scan = createScan(v);
    await storage.put(scan);
    // CRITICAL: on Vercel, returning the response kills the function. Without
    // waitUntil(), the runScan() promise gets orphaned and the scan stays in
    // "queued" forever. waitUntil tells Vercel to keep the function alive
    // (up to maxDuration=300) until the scan finishes, while still responding
    // to the client immediately. No-op outside Vercel — local dev relies on
    // the Node process staying alive between requests, which it does.
    const task = runScan(scan.id).catch((err) => console.error("Scan failed", scan.id, err));
    waitUntil(task);
    return NextResponse.json({ id: scan.id }, { status: 201 });
  } catch (e: any) {
    console.error("POST /api/scans failed:", e);
    return NextResponse.json(
      { error: `Could not create scan: ${e?.message ?? "unknown"}` },
      { status: 500 },
    );
  }
}

export async function GET() {
  try {
    const scans = await storage.list();
    const lite = scans.map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      status: s.progress.status,
      message: s.progress.message,
      businessDescription: s.input.businessDescription.slice(0, 120),
      campaignKey: s.input.campaignKey,
      timeWindow: s.input.timeWindow,
      signalCount: s.signals.length,
    }));
    return NextResponse.json({ scans: lite });
  } catch (e: any) {
    console.error("GET /api/scans failed:", e);
    return NextResponse.json(
      { error: `Storage error: ${e?.message ?? "unknown"}` },
      { status: 500 },
    );
  }
}
