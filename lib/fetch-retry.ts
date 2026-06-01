/**
 * fetch wrapper with retry + timeout + Retry-After awareness.
 *
 * Why centralize: every external call (Reddit, Apify, Airtable, HubSpot) was
 * failing on the first transient 429/5xx with no recovery. This wraps fetch
 * uniformly so a flaky network or rate limit produces a brief pause, not a
 * dead scan.
 *
 * Defaults are tuned for our APIs:
 *   - 2 retries (3 total attempts)
 *   - 30s default timeout (override for long-running like Apify run-sync)
 *   - Retries on 408, 425, 429, 500, 502, 503, 504, and network-level errors
 *   - Honors Retry-After header (seconds or HTTP-date); cap at 30s to bound waits
 *   - Exponential backoff with jitter: 500ms → 1s → 2s
 *
 * What it does NOT do:
 *   - Retry on 4xx auth errors (401, 403) — those are caller config issues
 *   - Retry POST/PUT/PATCH that aren't idempotent unless explicitly opted in
 *     via `retryNonIdempotent: true`. For our use, every external write IS
 *     idempotent in practice (Airtable upserts, HubSpot tasks are best-effort,
 *     Apify run-sync is fine to repeat) so we default to true.
 */

export interface FetchRetryOptions {
  retries?: number;
  retryOn?: number[];
  backoffMs?: number;
  timeoutMs?: number;
  label?: string;
  /** If false, won't retry non-GET requests. Default true. */
  retryNonIdempotent?: boolean;
}

const DEFAULT_RETRY_STATUS = [408, 425, 429, 500, 502, 503, 504];

export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  opts: FetchRetryOptions = {},
): Promise<Response> {
  const retries = opts.retries ?? 2;
  const retryOn = opts.retryOn ?? DEFAULT_RETRY_STATUS;
  const backoffMs = opts.backoffMs ?? 500;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const label = opts.label ?? `${init.method ?? "GET"} ${shortenUrl(url)}`;
  const allowRetryWrites = opts.retryNonIdempotent ?? true;
  const method = (init.method ?? "GET").toUpperCase();
  const isWrite = method !== "GET" && method !== "HEAD";

  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    // If caller passed their own signal, link it
    if (init.signal) {
      const upstream = init.signal as AbortSignal;
      upstream.addEventListener("abort", () => controller.abort(), { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response | undefined;
    try {
      res = await fetch(url, { ...init, signal: controller.signal });
    } catch (err: any) {
      clearTimeout(timer);
      const isTimeout = err?.name === "AbortError";
      lastError = isTimeout
        ? new Error(`${label} timed out after ${timeoutMs}ms`)
        : new Error(`${label} network error: ${err?.message ?? String(err)}`);
      if (attempt === retries) throw lastError;
      if (isWrite && !allowRetryWrites) throw lastError;
      await sleep(jitter(backoffMs * 2 ** attempt));
      continue;
    }
    clearTimeout(timer);

    if (!retryOn.includes(res.status) || attempt === retries) return res;
    if (isWrite && !allowRetryWrites) return res;

    const retryAfter = res.headers.get("Retry-After");
    const wait = parseRetryAfter(retryAfter) ?? jitter(backoffMs * 2 ** attempt);
    // Drain the body so connection can be reused
    res.body?.cancel?.().catch(() => {});
    await sleep(Math.min(wait, 30_000));
  }
  throw lastError ?? new Error(`${label} failed after ${retries + 1} attempts`);
}

function parseRetryAfter(h: string | null): number | null {
  if (!h) return null;
  const asInt = parseInt(h, 10);
  if (Number.isFinite(asInt)) return asInt * 1000;
  const asDate = Date.parse(h);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

function jitter(ms: number): number { return ms * (0.7 + Math.random() * 0.6); }
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
function shortenUrl(u: string): string {
  try { const url = new URL(u); return `${url.host}${url.pathname}`; } catch { return u.slice(0, 60); }
}
