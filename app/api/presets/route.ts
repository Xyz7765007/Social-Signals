/**
 * Preset CRUD endpoints (list + create).
 *
 * GET  /api/presets       → list all saved scan setups
 * POST /api/presets       → save a new setup
 *
 * Body for POST:
 *   { name: string, input: ScanInput }
 *
 * Input validation is intentionally light here: presets are templates, not
 * runs. We accept whatever the form sends as `input` and validate at scan
 * submission time. This means a saved preset can have an incomplete config
 * (e.g. missing keywords) — user fills in the gaps when they load it.
 */

import { NextRequest, NextResponse } from "next/server";
import { storage } from "@/lib/storage";
import type { ScanPreset } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function newId(): string {
  // Same pattern as scan IDs — uuid-like but doesn't require a dependency
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 6)
  );
}

export async function GET() {
  try {
    const list = await storage.listPresets();
    // Return lite payload — full input only on getPreset(id)
    const lite = list.map((p) => ({
      id: p.id,
      name: p.name,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      // Send a preview to render in the dropdown without a second roundtrip
      preview: {
        businessSnippet: (p.input.businessDescription ?? "").slice(0, 90),
        keywordCount: p.input.keywords?.length ?? 0,
        subredditCount: p.input.subreddits?.length ?? 0,
        campaignKey: p.input.campaignKey ?? null,
        timeWindow: p.input.timeWindow,
      },
    }));
    return NextResponse.json({ presets: lite });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Failed to list presets" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const name = String(body?.name ?? "").trim();
    const input = body?.input;
    if (!name) return NextResponse.json({ error: "Name required" }, { status: 400 });
    if (name.length > 80) return NextResponse.json({ error: "Name too long (80 char max)" }, { status: 400 });
    if (!input || typeof input !== "object") {
      return NextResponse.json({ error: "Input config required" }, { status: 400 });
    }

    const now = new Date().toISOString();
    const preset: ScanPreset = {
      id: newId(),
      name,
      createdAt: now,
      updatedAt: now,
      input,
    };
    await storage.putPreset(preset);
    return NextResponse.json({ preset }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Failed to save preset" }, { status: 500 });
  }
}
