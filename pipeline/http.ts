import { fetch } from "undici";
import { USER_AGENT } from "./paths.js";

/**
 * Polite HTTP for the public APIs this pipeline leans on.
 *
 * All of these (Kartverket, Overpass) are free services run for the common good, and
 * Overpass in particular is donated capacity. So: one request at a time per host, a hard
 * minimum gap between requests, and backoff that actually waits rather than retrying in
 * a tight loop. Being slow is free; being rude gets the project blocked.
 */

export interface HostPolicy {
  /** Minimum milliseconds between the start of two requests to this host. */
  minIntervalMs: number;
  /** How many times to retry a failed request before giving up. */
  retries: number;
}

const DEFAULT_POLICY: HostPolicy = { minIntervalMs: 250, retries: 3 };

const POLICIES: Record<string, HostPolicy> = {
  // Overpass is donated infrastructure and rate limits aggressively. One request per
  // second, and we batch many venues into each one.
  // Overpass hands out a small number of concurrent slots and answers 429 when they are
  // busy. Our queries are heavy (a whole kommune bbox), so a 1 s gap just burns retries.
  // This run happens once and is then cached forever, so patience costs us nothing.
  "overpass-api.de": { minIntervalMs: 4_000, retries: 6 },
  "overpass.kumi.systems": { minIntervalMs: 4_000, retries: 6 },
  "ws.geonorge.no": { minIntervalMs: 200, retries: 3 },
};

/** Per-host serialization: the next request chains onto the previous one's gap. */
const hostQueues = new Map<string, Promise<void>>();

function policyFor(host: string): HostPolicy {
  return POLICIES[host] ?? DEFAULT_POLICY;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Serializes work per host and enforces the minimum gap between requests. */
async function throttled<T>(host: string, work: () => Promise<T>): Promise<T> {
  const policy = policyFor(host);
  const previous = hostQueues.get(host) ?? Promise.resolve();

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  hostQueues.set(
    host,
    previous.then(() => gate),
  );

  await previous;
  try {
    return await work();
  } finally {
    // Hold the queue open for the full interval so the *next* caller waits it out.
    void sleep(policy.minIntervalMs).then(release);
  }
}

export interface RequestOptions {
  /** Extra headers merged on top of the defaults. */
  headers?: Record<string, string>;
  /** Request body; presence switches the method to POST. */
  body?: string;
  timeoutMs?: number;
  /** Called before each retry, for progress reporting. */
  onRetry?: (attempt: number, reason: string, waitMs: number) => void;
}

function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

/**
 * A single request with throttling and backoff. Retries on network errors, 429 and 5xx;
 * a 4xx other than 429 is a bug on our side and is thrown immediately.
 */
export async function politeFetch(
  url: string,
  options: RequestOptions = {},
): Promise<string> {
  const host = new URL(url).host;
  const policy = policyFor(host);
  const timeoutMs = options.timeoutMs ?? 90_000;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= policy.retries; attempt += 1) {
    if (attempt > 0) {
      // Exponential backoff, capped. Overpass asks for patience when it is loaded.
      const wait = Math.min(60_000, 2_000 * 2 ** (attempt - 1));
      options.onRetry?.(attempt, lastError?.message ?? "ukjent", wait);
      await sleep(wait);
    }

    try {
      return await throttled(host, async () => {
        const response = await fetch(url, {
          method: options.body === undefined ? "GET" : "POST",
          headers: {
            "user-agent": USER_AGENT,
            accept: "application/json",
            ...options.headers,
          },
          body: options.body,
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (response.status === 429 || response.status >= 500) {
          const wait = retryAfterMs(response.headers.get("retry-after"));
          if (wait !== null) await sleep(Math.min(wait, 120_000));
          throw new Error(`HTTP ${response.status}`);
        }
        if (!response.ok) {
          throw new HttpClientError(response.status, `HTTP ${response.status} for ${url}`);
        }

        return await response.text();
      });
    } catch (error) {
      if (error instanceof HttpClientError) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw new Error(`Ga opp mot ${host} etter ${policy.retries + 1} forsok: ${lastError?.message}`);
}

/** A 4xx that is our fault; retrying it would just be noise. */
export class HttpClientError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpClientError";
  }
}

export async function politeFetchJson<T>(
  url: string,
  options: RequestOptions = {},
): Promise<T> {
  const text = await politeFetch(url, options);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Ugyldig JSON fra ${url} (${text.length} tegn).`);
  }
}
