# Pulse

Signal intelligence for B2B outbound. Customer describes their business and ICP; Pulse surfaces real Reddit conversations matching that intent, ranked by Claude with one-line reply suggestions per signal.

Built with extensibility from day one — Twitter/X, news, and Instagram drop in behind the same `Source` interface.

---

## Why this Reddit API choice

**Official Reddit API via OAuth client credentials.** Picked over:

| Option | Verdict | Why |
| --- | --- | --- |
| **Reddit OAuth (chosen)** | ✅ | Free 100 req/min. Native time filtering (`hour`/`day`/`week`/`month`). ToS-compliant for commercial use. Structured data, no parsing risk. |
| Reddit `.json` unauthenticated | ❌ | IP-blocked at scale. ToS-grey for commercial. Unreliable. |
| Pushshift | ❌ | Effectively shut down after Reddit's 2023 API changes. |
| Apify Reddit scraper | 🔜 | Reserved for **Phase 2**: deeper historical search past Reddit's 1000-result depth cap. Pay-per-use ($1.50/1k). |
| Bright Data / ScraperAPI | ❌ | Expensive ($500+/mo entry). Overkill until we hit Reddit's free-tier ceiling. |

The free tier comfortably covers >1,000 scans/day for a small customer base. When we hit limits, the architecture allows adding Apify in parallel without changing the consumer-facing flow.

---

## Architecture

```
app/                   Next.js app router
  page.tsx             Scan creation form (the customer's input)
  scan/[id]/page.tsx   Live progress + results
  history/page.tsx     Past scans
  api/scans/           Create / list / fetch scans
lib/
  types.ts             Source-agnostic domain types
  orchestrator.ts      Runs expansion → fetch → score
  scoring/index.ts     Claude expansion + scoring (rubric-based)
  storage/index.ts     Persistence (file-based default; swap for prod)
  sources/
    reddit.ts          Reddit OAuth + parallel search
    twitter.ts         STUB — same Source interface
    news.ts            STUB
    instagram.ts       STUB
    index.ts           Registry
components/
  ScanForm.tsx         The 5-section input flow
  SignalCard.tsx       Result card
```

### The `Source` interface

Adding a channel means implementing one interface:

```ts
interface Source {
  id: SourceId;
  name: string;
  available: boolean;
  fetch(params: {
    keywords: string[];
    subreddits?: string[];
    timeWindow: TimeWindow;
    limit: number;
  }): Promise<RawPost[]>;
}
```

Twitter, news, and Instagram already have stub files. To ship X:

1. Open `lib/sources/twitter.ts`.
2. Implement `fetch()` against X API v2 or Apify tweet scraper, returning `RawPost[]`.
3. Flip `available: true`.
4. Add `"twitter"` checkbox in `ScanForm.tsx`'s sources block.

That's it. The orchestrator, scoring rubric, UI, and history all work unchanged.

### Two-stage accuracy

1. **Source pre-filter** — Reddit's own keyword × subreddit × time filtering narrows aggressively before we spend any AI tokens.
2. **Claude scoring** — every post graded 0–100 against the customer's business + ICP + chosen signal types, with reasoning and a suggested action. Strict rubric in `lib/scoring/index.ts`.

Default cutoff is score ≥ 20 returned to the UI, with a slider for the customer to raise it.

---

## Setup

### 1. Reddit credentials

1. Go to <https://www.reddit.com/prefs/apps>
2. Click **"are you a developer? create an app..."**
3. Type: **script**. Name it `Pulse`. Redirect URI: `http://localhost:3000` (unused but required).
4. Copy the **client ID** (just under "personal use script") and **secret**.

### 2. Anthropic key

Get one at <https://console.anthropic.com>.

### 3. Install

```bash
cp .env.example .env.local
# fill in ANTHROPIC_API_KEY, REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET
npm install
npm run dev
```

Open <http://localhost:3000>.

---

## Production deployment (Vercel)

This is built for Kunal's stack — drop straight onto Vercel.

```bash
vercel
```

Set the env vars in Vercel dashboard (same as `.env.example`).

**One important note about storage:** the default file-based storage in `lib/storage/index.ts` falls back to in-memory on Vercel (it auto-detects `VERCEL=1`). That means scans persist for the function lifetime but won't survive restarts. For real persistence, swap to one of:

- **Vercel KV** — drop-in replacement, ~5 minutes to wire
- **Airtable** (matches Kunal's stack) — adapter stub-pattern is clear; implement the `Storage` interface against base `appXXX` table `Scans`
- **Postgres / Supabase** — standard

The `Storage` interface is 4 methods (`list`, `get`, `put`, `delete`). The swap touches one file.

---

## Cost model (per scan)

| Component | Cost |
| --- | --- |
| Reddit API | $0 (free tier) |
| Claude expansion call | ~$0.005 |
| Claude scoring (25 posts ≈ 2 batches) | ~$0.02–$0.04 |
| **Total per scan** | **~$0.025–$0.045** |

Each scan persists `stats.costUsd` for billing.

---

## What's next

- **Phase 2 — X, news, Instagram.** Stubs are in place. ~1 day each to wire.
- **Phase 2 — comment surfacing.** Reddit search doesn't index comments well. Fetch top comments from matched threads and score them too. ~2× cost, ~3× signal density.
- **Phase 2 — Apify deep historical.** For "give me everything in the past year" queries beyond Reddit's 1k cap.
- **Phase 3 — Webhooks / scheduled scans.** Re-run the same scan every Monday at 9am, deliver new signals to Slack.
- **Phase 3 — Customer accounts + per-account quotas.** Right now anyone hitting the URL can run a scan.

---

## Conventions

- All money values in USD, displayed to 3 decimals.
- All dates ISO 8601 in storage; relative-time in UI.
- Subreddits stored without `r/` prefix; rendered with it.
- Source IDs are lowercase: `reddit`, `twitter`, `news`, `instagram`.
- `signalType` enum lives in `lib/types.ts` — single source of truth.
