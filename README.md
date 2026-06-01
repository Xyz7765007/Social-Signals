# Pulse

Signal intelligence for B2B outbound. Customer describes their business + ICP; Pulse surfaces real Reddit posts **and comments** matching that intent — author-checked, intent-scored, with reply drafts in the customer's voice and optional HubSpot push.

Built with extensibility from day one — Twitter/X, news, and Instagram drop in behind the same `Source` interface.

---

## Pipeline (per scan)

```
expanding         AI generates keywords + subreddits from business + ICP
fetching          Reddit search across keyword × subreddit × time-window
fetching_comments Top comments pulled for engaged posts (toggle)
dedup_seen        Skip externalIds already seen on this campaign
enriching         Author profile fetch + Claude read of recent subreddits (toggle)
scoring           Claude scores each item with anti-signals + author adjustments
drafting          Reply drafts in client's voice for signals ≥ 60 (toggle)
pushing           HubSpot Tasks for signals ≥ threshold (when token set)
complete          Done — UI shows ranked, filterable signals
```

## Why these Reddit providers

Pulse supports **two Reddit providers**, picks automatically by env vars, switchable via `REDDIT_PROVIDER`.

| Provider | Setup | Cost | When |
| --- | --- | --- | --- |
| **Reddit OAuth** | Reddit app + client_credentials | Free (100 req/min) | Default when you can create a Reddit app |
| **Apify** (`trudax/reddit-scraper-lite`) | Drop `APIFY_TOKEN` | ~$3.40 per 1k results | When Reddit app creation is blocked |

Both implement the same `Source` interface — UI, scoring, dedup, drafts, HubSpot push all work unchanged.

---

## What's new in v0.2

| Feature | Where | Why |
| --- | --- | --- |
| **Comments scanning** | `lib/sources/reddit-{oauth,apify}.ts` → `fetchComments` | Most real intent lives in comments, not posts |
| **Anti-signals** | `lib/scoring/index.ts` | Client-specific noise terms actively downweighted in scoring |
| **Campaign-level dedup** | `lib/storage/*.ts` → `getSeen`/`addSeen` | Weekly scans don't resurface last week's signals |
| **Author enrichment** | `lib/sources/*.ts` → `fetchAuthorContext` + scoring | Catches "this author is clearly a journalist not a buyer" |
| **Reply drafter** | `lib/scoring/index.ts` → `draftReply` | One AI-drafted reply per high-score signal, in client's voice |
| **HubSpot push** | `lib/integrations/hubspot.ts` | Auto-creates Tasks for signals ≥ threshold |

All controlled per-scan via the **Advanced** section of the form (or via API).

---

## Setup

### 1. Pick your Reddit provider

**Option A — Reddit OAuth (free):**
1. <https://www.reddit.com/prefs/apps> → "create another app" → type: `script`
2. Redirect URI: `http://localhost:8080`. Reddit needs it but client_credentials doesn't use it.
3. Copy client ID (~14 chars) and secret (~27 chars).
4. ⚠️ If "create app" silently fails → verify your email at <https://www.reddit.com/settings/account>, disable extensions, try incognito. If still blocked, use Option B.

**Option B — Apify (no Reddit setup):**
Drop your existing `APIFY_TOKEN` into `.env.local`. Done.

### 2. Anthropic key

<https://console.anthropic.com>

### 3. Install

```bash
cp .env.example .env.local   # fill in keys
npm install
npm run dev
```

<http://localhost:3000>

---

## API surface

### `POST /api/scans`

```jsonc
{
  // required
  "businessDescription": "We sell …",
  "icp": "B2B SaaS …",
  "signalTypes": ["pain_point", "buying_intent", "recommendation_request"],

  // optional
  "keywords": ["..."],            // AI generates if omitted
  "subreddits": ["..."],          // AI suggests if omitted
  "antiSignals": ["bookkeeping"], // actively downweighted by scoring
  "timeWindow": "week",           // hour | day | week | month
  "maxResults": 25,               // 10 | 25 | 50 | 100
  "sources": ["reddit"],

  // phase-2 toggles (all default true)
  "includeComments": true,
  "enrichAuthors": true,
  "draftReplies": true,

  // dedup across runs
  "campaignKey": "osome-singapore",

  // voice for reply drafter
  "voice": "Conversational, peer-to-peer, never salesy …",

  // HubSpot push (optional)
  "hubspotToken": "pat-...",
  "hubspotOwnerId": "12345",
  "hubspotPushThreshold": 70
}
```

Returns `{ id }`. Poll `GET /api/scans/{id}` for progress.

### `GET /api/scans` — list (lite view)
### `GET /api/scans/{id}` — full scan + signals
### `DELETE /api/scans/{id}` — remove

---

## Storage

The `Storage` interface in `lib/storage/index.ts` is 6 methods now:
`list`, `get`, `put`, `delete`, **`getSeen(campaignKey)`**, **`addSeen(campaignKey, ids)`**.

Available implementations:
- `FileStorage` — local dev (`.data/scans.json` + `.data/seen.json`)
- `MemoryStorage` — ephemeral fallback for Vercel without external store
- `AirtableStorage` — production (set `AIRTABLE_API_KEY` + `AIRTABLE_BASE_ID`)

### Airtable schema (auto-created)

Pulse auto-bootstraps the schema on first use. It calls Airtable's Metadata API to:
- Create the `Scans` and `Seen Signals` tables if they don't exist
- Add any missing fields if the tables exist with an older shape
- Add any missing single-select options (e.g. when new pipeline statuses ship)
- Never delete, rename, or change the type of existing fields

PAT scopes required (`https://airtable.com/create/tokens`):
- `data.records:read`
- `data.records:write`
- `schema.bases:read` — to detect what already exists
- `schema.bases:write` — to create / extend tables (only used during first init)

To verify schema sync without running a scan, hit `GET /api/setup` after deploy. Returns `{ok: true, storage, base, scansTable, seenTable}` on success, `{ok: false, error}` with a precise fix on failure.

If you can't grant `schema.bases:write` (e.g. enterprise base where the PAT can only have read scope), the error message lists the exact schema to create manually — fields, types, and single-select options.

**Schema reference (what gets created):**

`Scans` table:

| Field | Type |
| --- | --- |
| `Scan ID` | Single line text (primary) |
| `Created At` | Date with time (UTC, ISO) |
| `Status` | Single select: queued · expanding · fetching · fetching_comments · enriching · scoring · drafting · pushing · complete · failed |
| `Business` | Long text |
| `Time Window` | Single select: hour · day · week · month |
| `Signal Count` | Number (integer) |
| `Cost USD` | Number (4 decimals) |
| `Duration s` | Number (1 decimal) |
| `Scan JSON` | Long text |

`Seen Signals` table:

| Field | Type |
| --- | --- |
| `Campaign Key` | Single line text (primary) |
| `Seen IDs JSON` | Long text |
| `Updated At` | Date with time (UTC, ISO) |

---

## HubSpot integration

When `hubspotToken` is set on a scan, signals scoring ≥ `hubspotPushThreshold` (default 70) become HubSpot **Tasks**, not Contacts. The reasoning: a Reddit username isn't a verified contact identity, but a Task on the SDR's queue is exactly the action you want.

Each task includes: score, subreddit, signal type, post excerpt, reasoning, suggested action, **the reply draft**, author summary, and the Reddit link. Priority: `HIGH` for score ≥ 85, `MEDIUM` otherwise. Due: 24 hours (Reddit signal decays fast).

Token: HubSpot Private App with scope `crm.objects.tasks.write`. Optional `hubspotOwnerId` assigns the task.

---

## Cost model (per scan, 25 signals)

| Phase | Cost |
| --- | --- |
| Reddit (OAuth) | $0 |
| Reddit (Apify, ~100 raw items) | ~$0.34 |
| Expansion (Sonnet 4.6) | ~$0.005 |
| Author summarize (Haiku 4.5) | ~$0.002 |
| Scoring (Sonnet 4.6, 4–6 batches with comments) | ~$0.05–$0.08 |
| Reply drafts (Sonnet 4.6, ~10 signals × 600 tok) | ~$0.04 |
| HubSpot tasks | $0 |
| **Total per scan** | **~$0.10 (OAuth) / ~$0.44 (Apify)** |

Each scan persists `stats.costUsd`. Switch `MODEL_DRAFT` in `lib/scoring/index.ts` to Haiku 4.5 to drop draft cost ~70%.

---

## Source extension

Adding a channel (X, news, Instagram) means implementing this interface in `lib/sources/{channel}.ts`:

```ts
interface Source {
  id: SourceId;
  name: string;
  available: boolean;
  fetch(params): Promise<RawPost[]>;
  fetchComments?(posts, maxPerPost): Promise<RawPost[]>;
  fetchAuthorContext?(usernames): Promise<Record<string, AuthorContext>>;
}
```

Then flip `available: true` and add the source to the registry in `lib/sources/index.ts`. Scoring, drafting, dedup, HubSpot — all unchanged.
