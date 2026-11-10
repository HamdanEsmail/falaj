// TinyFetch: pages as markdown (and, when asked, their links). Free (within 1,000 URLs a day),
// but each request still appends one $0 spend row. Falaj's own daily cap (FETCH_URLS_PER_DAY)
// is counted here via countFetch, before the request is sent.
import { ToolError } from "../core/errors";
import { FETCH_BATCH_MAX, FETCH_TTL_SECONDS, FETCH_URLS_PER_DAY } from "../core/limits";
import { PRICES } from "../core/spend";
import { bump, utcDay } from "../db/counters";
import type { Env } from "../env";
import type { ToolContext } from "../tools/types";
import { tinyfishFetch } from "./client";

const FETCH_API = "https://api.fetch.tinyfish.ai";
const PER_URL_TIMEOUT_MS = 45_000;

function secondsToUtcMidnight(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

/**
 * Counts `n` TinyFetch URLs against the daily cap before the request is sent. The count is taken
 * first, in one statement that returns the new total, so calls arriving together cannot all read
 * the same "still under the cap" and pass. A call that takes the total over FETCH_URLS_PER_DAY
 * gives its `n` back, answers RATE_LIMITED scope global and makes no TinyFish call.
 */
export async function countFetch(t: ToolContext, n: number): Promise<void> {
  const day = utcDay(t.now);
  const used = await bump(t.env.DB, "fetch_urls", n, day);
  if (used > FETCH_URLS_PER_DAY) {
    await bump(t.env.DB, "fetch_urls", -n, day);
    throw new ToolError("RATE_LIMITED", "Falaj's daily Fetch URL cap is reached", {
      scope: "global",
      retry_after_seconds: secondsToUtcMidnight(t.now),
    });
  }
}

export type FetchPageResult =
  | {
      ok: true;
      /** The URL that was asked for. */
      url: string;
      /** Where TinyFish ended up after redirects. */
      finalUrl: string;
      title: string | null;
      text: string;
      links: string[];
      /**
       * Whether TinyFish served this page from its own cache. The 2026-11-03 probe (the same
       * page twice with ttl 3600) found no cache indicator in the response fields or headers,
       * so this is always null for now (see docs/build-log.md).
       */
      upstream_cached: boolean | null;
    }
  | { ok: false; url: string; error: string; status?: number };

type RawResult = { url?: unknown; final_url?: unknown; title?: unknown; text?: unknown; links?: unknown };
type RawError = { url?: unknown; error?: unknown };
type FetchBody = { results?: unknown; errors?: unknown };

function asList<T>(v: unknown): T[] {
  return Array.isArray(v) ? v.filter((x): x is T => x !== null && typeof x === "object") : [];
}

function errorText(entry: RawError | undefined): string {
  const e = entry?.error;
  if (typeof e === "string" && e !== "") return e;
  if (e !== null && typeof e === "object") {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && code !== "") return code;
  }
  return "fetch_error";
}

/**
 * Fetches up to FETCH_BATCH_MAX pages in one request and returns one result per requested
 * URL, in the order asked. TinyFish may answer in another order or with a different final URL
 * after a redirect, so results are matched on `url`, then on `final_url`. A URL with no usable
 * result becomes `{ ok: false }`. A failed request (non-2xx) throws a TinyFishError.
 */
export async function fetchPages(
  env: Env,
  urls: string[],
  opts: { links?: boolean; ttl?: number },
): Promise<FetchPageResult[]> {
  if (urls.length > FETCH_BATCH_MAX) {
    throw new Error(`fetchPages takes at most ${FETCH_BATCH_MAX} urls per request, got ${urls.length}`);
  }
  if (urls.length === 0) return [];

  const res = await tinyfishFetch(env, FETCH_API, {
    method: "POST",
    body: JSON.stringify({
      urls,
      format: "markdown",
      ttl: opts.ttl ?? FETCH_TTL_SECONDS,
      links: opts.links ?? false,
      per_url_timeout_ms: PER_URL_TIMEOUT_MS,
    }),
    spend: {
      kind: "fetch",
      amountUsd: PRICES.fetch,
      ref: urls.length === 1 ? urls[0]! : `${urls[0]} +${urls.length - 1} more`,
    },
  });
  const body = (await res.json()) as FetchBody;
  const results = asList<RawResult>(body.results);
  const errors = asList<RawError>(body.errors);
  // An error entry with no url cannot be matched; those are handed out in order to the
  // requested urls that got no result.
  const anonymousErrors = errors.filter((e) => typeof e.url !== "string");

  return urls.map((url): FetchPageResult => {
    const hit = results.find((r) => r.url === url) ?? results.find((r) => r.final_url === url);
    if (hit && typeof hit.text === "string") {
      return {
        ok: true,
        url,
        finalUrl: typeof hit.final_url === "string" && hit.final_url !== "" ? hit.final_url : url,
        title: typeof hit.title === "string" ? hit.title : null,
        text: hit.text,
        links: Array.isArray(hit.links) ? hit.links.filter((l): l is string => typeof l === "string") : [],
        upstream_cached: null,
      };
    }
    const named = errors.find((e) => e.url === url);
    if (named) return { ok: false, url, error: errorText(named) };
    if (!hit) {
      const next = anonymousErrors.shift();
      if (next) return { ok: false, url, error: errorText(next) };
    }
    return { ok: false, url, error: "no_result" };
  });
}

/** One page: the first of `fetchPages` for a single url. */
export async function fetchPage(
  env: Env,
  url: string,
  opts: { links?: boolean; ttl?: number } = {},
): Promise<FetchPageResult> {
  const [first] = await fetchPages(env, [url], opts);
  return first!;
}
