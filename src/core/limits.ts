// Hard caps and fixed values. Every limit in Falaj comes from here.

/** An Agent read (faculty profile, academic calendar) may take at most this many steps... */
export const AGENT_MAX_STEPS = 12;
/** ...and this long. */
export const AGENT_MAX_DURATION_SECONDS = 160;
/** Agent runs in flight at once, ever (the TinyFish account's concurrency is shared). */
export const AGENT_SLOTS = 1;
/** New Agent reads per UTC day, across all callers. */
export const AGENT_READS_PER_DAY = 10;
/** A pending Agent read older than this is marked failed and frees the slot. */
export const AGENT_PENDING_TIMEOUT_MS = 300_000;
/** A pending Agent read that TinyFish still reports as running, or cannot report on, is failed after this long. */
export const AGENT_PENDING_GIVE_UP_MS = 1_800_000;
/** After a started Agent read ends without a usable result, no new read of the same page or year starts for this long. */
export const AGENT_FAILED_RETRY_HOURS = 6;
/**
 * A callback for a run id Falaj has not stored is attached to the pending row that has no run id only
 * when that row is older than this: a start still in progress has no id yet either.
 */
export const AGENT_ADOPT_AFTER_MS = 15_000;
/** What a `{status: "reading"}` answer tells the caller to wait. */
export const AGENT_ETA_SECONDS = 90;

/** TinyFetch URLs per UTC day, across all callers. */
export const FETCH_URLS_PER_DAY = 400;
/** Fetch-backed results say they are good for this long. */
export const FETCH_TTL_SECONDS = 3600;
/** URLs per TinyFetch request. */
export const FETCH_BATCH_MAX = 10;

/** Per-caller limits on /mcp (the caller key is the client IP, or "anon"). */
export const CALLER_PER_MINUTE = 120;
export const CALLER_PER_DAY = 2000;

/** Falaj's share of the shared TinyFish wallet, in US dollars. */
export const BUDGET_SHARE_USD = 3.5;
/** At this much Falaj spend, new Agent reads are refused (BUDGET_PAUSED). */
export const BUDGET_PAUSE_USD = 3.0;

/** The academic calendar is re-read this often. */
export const CALENDAR_REFRESH_DAYS = 7;
/** A cached faculty profile is served without a re-read for this long. */
export const PROFILE_CACHE_DAYS = 7;
/** A cached Agent read older than this is marked stale. */
export const STALE_DAYS = 14;

/** TinyFish Page monitors Falaj holds at once. */
export const MAX_MONITORS = 2;

/** List tools return this many results unless the caller asks for more... */
export const RESULT_LIMIT_DEFAULT = 20;
/** ...and never more than this. */
export const RESULT_LIMIT_MAX = 50;

/** The call log keeps this many characters of a call's arguments. */
export const ARGS_ABBREV_CHARS = 80;

/** A canary slower than this passes as degraded. */
export const CANARY_SLOW_MS = 20_000;

/** Questions one visitor may ask from the page's own form, per minute and per UTC day. */
export const TRY_PER_MINUTE = 6;
export const TRY_PER_DAY = 60;
/** How many rows of an answer the page shows. */
export const TRY_ROWS = 8;
