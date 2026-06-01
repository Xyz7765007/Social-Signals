/**
 * HubSpot integration — push high-scoring signals as Tasks.
 *
 * Why Tasks (not Contacts or Deals): a Reddit username isn't a verified contact
 * identity. Tasks give the SDR a queue of "go reply to this" without polluting
 * the contact db. The signal's Reddit URL + reply draft live in the task body.
 *
 * Endpoint: POST /crm/v3/objects/tasks
 * Auth: Bearer token from a Private App (token starts "pat-").
 * Token scopes required: crm.objects.tasks.write
 */

import type { Signal } from "../types";

const HUBSPOT_API = "https://api.hubapi.com";

export interface HubspotPushResult {
  created: number;
  failed: number;
  taskIds: Record<string, string>; // signal externalId → task ID
  errors: string[];
}

export async function pushSignalsToHubspot(
  signals: Signal[],
  token: string,
  ownerId?: string,
): Promise<HubspotPushResult> {
  const result: HubspotPushResult = { created: 0, failed: 0, taskIds: {}, errors: [] };

  // Sequential, not parallel — keeps HubSpot rate happy and gives us cleaner
  // error reporting per signal.
  for (const sig of signals) {
    try {
      const id = await createTask(sig, token, ownerId);
      result.created++;
      result.taskIds[sig.externalId] = id;
    } catch (e: any) {
      result.failed++;
      result.errors.push(`${sig.externalId}: ${e?.message ?? "unknown"}`);
    }
  }
  return result;
}

async function createTask(sig: Signal, token: string, ownerId?: string): Promise<string> {
  // HubSpot timestamp is epoch ms.
  // Task type values: TODO | CALL | EMAIL  — TODO is the right one for "go reply on Reddit".
  // Priority: HIGH for score ≥ 85, MEDIUM otherwise.
  const priority = sig.score >= 85 ? "HIGH" : "MEDIUM";

  const subject = `Reddit reply: ${truncate(sig.title ?? sig.content, 80)}  [${sig.score}/100]`;
  const body = buildTaskBody(sig);

  const properties: Record<string, any> = {
    hs_task_subject: subject,
    hs_task_body: body,
    hs_task_status: "NOT_STARTED",
    hs_task_priority: priority,
    hs_task_type: "TODO",
    // Due in 24 hours — Reddit relevance decays fast.
    hs_timestamp: Date.now() + 24 * 60 * 60 * 1000,
  };
  if (ownerId) properties.hubspot_owner_id = ownerId;

  const res = await fetch(`${HUBSPOT_API}/crm/v3/objects/tasks`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ properties }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HubSpot task create failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const data: any = await res.json();
  return String(data.id);
}

function buildTaskBody(sig: Signal): string {
  // HubSpot task body accepts HTML — escape ALL user-controlled strings.
  // Reddit restricts usernames to [A-Za-z0-9_-] in practice, but defensive
  // escaping protects us from any third-party data that ends up here.
  const lines: string[] = [];
  const subreddit = escape(String(sig.metadata.subreddit ?? ""));
  lines.push(`<p><strong>Score:</strong> ${sig.score}/100 · <strong>Type:</strong> ${escape(sig.signalType)} · <strong>Subreddit:</strong> r/${subreddit}</p>`);
  if (sig.isComment && sig.metadata.parentTitle) {
    lines.push(`<p><em>Comment under:</em> ${escape(String(sig.metadata.parentTitle))}</p>`);
  } else if (sig.title) {
    lines.push(`<p><strong>${escape(sig.title)}</strong></p>`);
  }
  if (sig.content) {
    lines.push(`<blockquote>${escape(truncate(sig.content, 600))}</blockquote>`);
  }
  lines.push(`<p><strong>Why surfaced:</strong> ${escape(sig.reasoning)}</p>`);
  lines.push(`<p><strong>Suggested action:</strong> ${escape(sig.suggestedAction)}</p>`);
  if (sig.replyDraft && !sig.replyDraft.startsWith("[SKIP]")) {
    lines.push(`<p><strong>Reply draft:</strong></p><blockquote>${escape(sig.replyDraft).replace(/\n/g, "<br>")}</blockquote>`);
  }
  lines.push(`<p><strong>Author:</strong> u/${escape(sig.author)}${sig.authorContext?.summary ? ` — ${escape(sig.authorContext.summary)}` : ""}</p>`);
  lines.push(`<p><a href="${escape(sig.url)}">Open on Reddit</a></p>`);
  return lines.join("\n");
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length <= n ? s : s.slice(0, n).trimEnd() + "…";
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
