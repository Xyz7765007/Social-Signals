import { NextRequest, NextResponse } from "next/server";
import { storage } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const scan = await storage.get(params.id);
  if (!scan) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(scan);
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  await storage.delete(params.id);
  return NextResponse.json({ ok: true });
}
