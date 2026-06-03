/**
 * Per-preset endpoints.
 *
 * GET    /api/presets/[id] → full preset (including full ScanInput)
 * PUT    /api/presets/[id] → rename or update input
 * DELETE /api/presets/[id] → remove
 *
 * Idempotent: deleting a missing preset returns 200 (matches scan delete
 * behavior — prevents UI race conditions where two tabs both click delete).
 */

import { NextRequest, NextResponse } from "next/server";
import { storage } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const preset = await storage.getPreset(params.id);
    if (!preset) return NextResponse.json({ error: "Preset not found" }, { status: 404 });
    return NextResponse.json({ preset });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Failed to load preset" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const existing = await storage.getPreset(params.id);
    if (!existing) return NextResponse.json({ error: "Preset not found" }, { status: 404 });

    const body = await req.json();
    const name = typeof body?.name === "string" ? body.name.trim() : existing.name;
    const input = body?.input && typeof body.input === "object" ? body.input : existing.input;

    if (!name) return NextResponse.json({ error: "Name required" }, { status: 400 });
    if (name.length > 80) return NextResponse.json({ error: "Name too long" }, { status: 400 });

    const updated = {
      ...existing,
      name,
      input,
      updatedAt: new Date().toISOString(),
    };
    await storage.putPreset(updated);
    return NextResponse.json({ preset: updated });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Failed to update preset" }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await storage.deletePreset(params.id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Failed to delete preset" }, { status: 500 });
  }
}
