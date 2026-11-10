// Agent-backed reads: at most one run in flight, and a retry never starts a second paid run.
// A pending row older than AGENT_PENDING_TIMEOUT_MS is read back from TinyFish and settled, or
// becomes failed when it has no run to read (either frees the slot). Every finished run's steps
// are booked once, usable result or not, and a key whose run failed gets no new run for
// AGENT_FAILED_RETRY_HOURS. Last-good cache data is served whenever it exists.

import { ToolError } from "../core/errors";
import { TinyFishError } from "../tinyfish/client";
import {
  AGENT_ETA_SECONDS,
  AGENT_FAILED_RETRY_HOURS,
  AGENT_MAX_STEPS,
  AGENT_PENDING_GIVE_UP_MS,
  AGENT_PENDING_TIMEOUT_MS,
  AGENT_READS_PER_DAY,
  AGENT_SLOTS,
  BUDGET_PAUSE_USD,
} from "../core/limits";
import { recordSpendOnce, totalSpend } from "../core/spend";
import type { Env } from "../env";
import {
  expirePending,
  expireRun,
  getByRunId,
  getCached,
  insertPending,
  markFailed,
  markOk,
  pendingCount,
  setRunId,
  stalePendingRuns,
} from "../db/agentCache";
import { bump, today, utcDay } from "../db/counters";
import {
  CALENDAR_GOAL,
  CALENDAR_SCHEMA,
  CALENDAR_URL,
  normalizeCalendar,
  normalizeProfile,
  PROFILE_GOAL,
  PROFILE_SCHEMA,
} from "../parsers/calendar";
import { getRun, isTerminal, startRun, stepsCost, type AgentRun } from "../tinyfish/agent";
import type { ToolContext } from "../tools/types";

const POLL_AFTER_MS = 60_000;
/** Tries at storing a started run's id before the row is left pending without one. */
const SET_RUN_ID_ATTEMPTS = 3;

export type ReadOk = { status: "ok"; data: unknown; read_at: string };
export type ReadReading = { status: "reading"; eta_seconds: number };
export type ReadResult = ReadOk | ReadReading;

export type ReadParams = {
  url: string;
  kind: "profile" | "calendar";
  goal: string;
  schema: object;
  /** Cache key; defaults to `url`. Calendar uses `${CALENDAR_URL}#${year}`. */
  key?: string;
};

function parseData(raw: string | null): unknown | null {
  if (raw === null || raw === "") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function yearFromKey(key: string): string {
  const i = key.lastIndexOf("#");
  return i >= 0 ? key.slice(i + 1) : "";
}

function remainingEta(startedAt: string | null, now: Date): number {
  const started = startedAt ? new Date(startedAt).getTime() : now.getTime();
  const elapsed = Math.max(0, Math.floor((now.getTime() - started) / 1000));
  return Math.max(1, AGENT_ETA_SECONDS - elapsed);
}

/**
 * Reads one run from TinyFish and settles its row when the run is finished. False when the run is
 * still in flight or TinyFish could not be asked: the row is then left as it is.
 */
export async function settleRun(env: Env, runId: string): Promise<boolean> {
  let run: AgentRun;
  try {
    run = await getRun(env, runId);
  } catch {
    return false;
  }
  if (!isTerminal(run.status)) return false;
  await finalizeRun(env, runId, run);
  return true;
}

/**
 * Pending rows older than AGENT_PENDING_TIMEOUT_MS. One with no run id has nothing to read and fails
 * as "timeout". One with a run id is read back first, so a finished run whose callback never arrived
 * is settled and booked; a run TinyFish still reports as running, or cannot report on, keeps the
 * slot until AGENT_PENDING_GIVE_UP_MS and then fails as "timeout".
 */
async function settleStalePending(env: Env, now: Date): Promise<void> {
  const db = env.DB;
  const stale = new Date(now.getTime() - AGENT_PENDING_TIMEOUT_MS);
  await expirePending(db, stale, now.toISOString());
  for (const row of await stalePendingRuns(db, stale)) {
    if (row.run_id === null || (await settleRun(env, row.run_id))) continue;
    const started = row.started_at ? new Date(row.started_at).getTime() : 0;
    if (now.getTime() - started > AGENT_PENDING_GIVE_UP_MS) {
      await expireRun(db, row.url, row.run_id, now.toISOString());
    }
  }
}

/**
 * Stores a started run's id. A started run is live and billed, so a failed write is tried again and
 * never fails the row: when every try fails the row stays pending without a run id, which holds the
 * slot until the run's callback attaches the id or the row times out.
 */
async function storeRunId(db: D1Database, key: string, runId: string): Promise<void> {
  for (let attempt = 0; attempt < SET_RUN_ID_ATTEMPTS; attempt++) {
    try {
      await setRunId(db, key, runId);
      return;
    } catch {
      // Tried again below.
    }
  }
  console.error("agent run id could not be stored; the row stays pending");
}

/**
 * Serve a cached Agent read, or start one if the slot, daily cap and budget allow.
 * `force` skips a fresh-enough hit so cron/admin can refresh; tools omit it and
 * serve last-good data (even when stale) without starting a run.
 */
export async function requestRead(
  t: ToolContext,
  p: ReadParams,
  opts?: { force?: boolean },
): Promise<ReadResult> {
  const key = p.key ?? p.url;
  const db = t.env.DB;
  const now = t.now;
  // Settle or expire globally before the slot check, so a finished or timed-out row cannot hold the slot.
  await settleStalePending(t.env, now);

  let row = await getCached(db, key);
  let data = parseData(row?.data ?? null);
  let hasData = data !== null && row?.read_at != null;

  // Last-good data is served without starting a run. A forced refresh (cron/admin)
  // skips this so it can claim the slot.
  if (hasData && !opts?.force) {
    return { status: "ok", data, read_at: row!.read_at! };
  }

  if (row?.status === "pending") {
    const age = now.getTime() - (row.started_at ? new Date(row.started_at).getTime() : now.getTime());
    // An older row was read back by settleStalePending just above.
    if (age > POLL_AFTER_MS && age <= AGENT_PENDING_TIMEOUT_MS && row.run_id) {
      if (await settleRun(t.env, row.run_id)) {
        row = await getCached(db, key);
        data = parseData(row?.data ?? null);
        hasData = data !== null && row?.read_at != null;
        if (row?.status === "ok" && hasData) return { status: "ok", data, read_at: row.read_at! };
      }
    }
    if (row?.status === "pending") {
      if (hasData) return { status: "ok", data, read_at: row.read_at! };
      return { status: "reading", eta_seconds: remainingEta(row.started_at, now) };
    }
  }

  if (t.allowAgentStart === false) {
    if (hasData) return { status: "ok", data, read_at: row!.read_at! };
    throw new ToolError("NOT_FOUND", "no cached data yet");
  }

  // A key whose last started run failed gets no new paid run until the wait is over.
  if (row?.status === "failed" && row.failed_at) {
    const waitMs = AGENT_FAILED_RETRY_HOURS * 3_600_000 - (now.getTime() - new Date(row.failed_at).getTime());
    if (waitMs > 0) {
      if (hasData) return { status: "ok", data, read_at: row.read_at! };
      throw new ToolError(
        "NOT_FOUND",
        `The last read of this page gave nothing usable; Falaj starts no new read of it for ${AGENT_FAILED_RETRY_HOURS} hours after that`,
        {
          retry_after_seconds: Math.ceil(waitMs / 1000),
          fix: "Check that the address or year is one the university publishes; the same request is tried again after retry_after_seconds",
        },
      );
    }
  }

  const spend = await totalSpend(db);
  if (spend >= BUDGET_PAUSE_USD) {
    if (hasData) return { status: "ok", data, read_at: row!.read_at! };
    throw new ToolError("BUDGET_PAUSED", "Falaj's TinyFish budget is paused; new Agent reads are refused", {
      fix: "Falaj's TinyFish budget is paused; cached data and Fetch/Search tools keep working",
    });
  }

  const day = utcDay(now);
  if ((await today(db, "agent_reads", day)) >= AGENT_READS_PER_DAY || (await pendingCount(db)) >= AGENT_SLOTS) {
    if (hasData) return { status: "ok", data, read_at: row!.read_at! };
    throw new ToolError("RATE_LIMITED", "Falaj's Agent read limit is reached", {
      scope: "global",
      retry_after_seconds: 120,
    });
  }

  const claimed = await insertPending(db, {
    url: key,
    kind: p.kind,
    run_id: null,
    started_at: now.toISOString(),
  });
  if (!claimed) {
    if (hasData) return { status: "ok", data, read_at: row!.read_at! };
    throw new ToolError("RATE_LIMITED", "Falaj's Agent read limit is reached", {
      scope: "global",
      retry_after_seconds: 120,
    });
  }

  // The day's count is claimed before the start and given back when the start fails. Nothing
  // after a successful start may fail the row: the run is live and billed from then on.
  let runId: string;
  try {
    await bump(db, "agent_reads", 1, day);
    try {
      const webhookUrl = `${t.env.PUBLIC_BASE_URL}/api/webhooks/agent/${t.env.WEBHOOK_SECRET}`;
      ({ runId } = await startRun(t.env, {
        url: p.url,
        goal: p.goal,
        outputSchema: p.schema,
        webhookUrl,
      }));
    } catch (err) {
      await bump(db, "agent_reads", -1, day);
      throw err;
    }
  } catch (err) {
    await markFailed(db, key, "start_failed");
    // A start TinyFish refused read nothing and cost nothing; the caller is told so, and that asking
    // again is safe. TinyFish runs two Agent reads at once for a whole account and answers 429 to a
    // third.
    if (err instanceof TinyFishError) {
      const busy = err.status === 429;
      throw new ToolError(
        busy ? "RATE_LIMITED" : "UPSTREAM_TIMEOUT",
        busy
          ? "TinyFish is busy with other reads, so this one was not started. Nothing was read and nothing was charged."
          : `TinyFish could not start this read (it answered ${err.status} ${err.code}). Nothing was read and nothing was charged.`,
        {
          ...(busy ? { scope: "global" as const } : {}),
          retry_after_seconds: 60,
          fix: "Call the tool again in a minute; the call that starts the read answers {status: \"reading\"}",
        },
      );
    }
    throw err;
  }
  await storeRunId(db, key, runId);
  return { status: "reading", eta_seconds: AGENT_ETA_SECONDS };
}

/**
 * Settles the row of a finished run; a run that is not COMPLETED, FAILED or CANCELLED changes
 * nothing. Booking and the verdict are separate steps:
 * - the run's steps are booked once per run id, usable result or not (TinyFish bills a failed run's
 *   steps too); a step count TinyFish does not report is booked at the cap, AGENT_MAX_STEPS;
 * - the row becomes `ok` when the result normalises, and `failed` when it does not.
 * Idempotent: a second call for the same run books nothing and leaves an `ok` row alone.
 */
export async function finalizeRun(env: Env, runId: string, run: AgentRun): Promise<void> {
  const db = env.DB;
  if (!isTerminal(run.status)) return;
  const row = await getByRunId(db, runId);
  if (row === null) return;

  const cost = stepsCost(run.num_of_steps ?? AGENT_MAX_STEPS);
  await recordSpendOnce(db, "agent_step", cost, runId);
  if (row.status === "ok") return;

  const usable =
    run.status !== "COMPLETED"
      ? null
      : row.kind === "calendar"
        ? normalizeCalendar(run.result, yearFromKey(row.url))
        : normalizeProfile(run.result, row.url);
  const at = new Date().toISOString();
  if (usable !== null) {
    await markOk(db, row.url, JSON.stringify(run.result), at, runId, cost);
    return;
  }
  if (row.status === "pending") await markFailed(db, row.url, run.error ?? run.status, at);
}

export function requestProfileRead(t: ToolContext, url: string, opts?: { force?: boolean }): Promise<ReadResult> {
  return requestRead(t, { url, kind: "profile", goal: PROFILE_GOAL, schema: PROFILE_SCHEMA }, opts);
}

export function requestCalendarRead(
  t: ToolContext,
  year: string,
  opts?: { force?: boolean },
): Promise<ReadResult> {
  return requestRead(
    t,
    {
      url: CALENDAR_URL,
      key: `${CALENDAR_URL}#${year}`,
      kind: "calendar",
      goal: CALENDAR_GOAL(year),
      schema: CALENDAR_SCHEMA,
    },
    opts,
  );
}
