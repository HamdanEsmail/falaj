// agent_cache rows: one per profile URL or calendar year-tab key. A row keeps
// data and read_at from its last good read through pending and failed states;
// served data is row.data whenever it is non-null.

import { AGENT_SLOTS } from "../core/limits";

export type AgentKind = "profile" | "calendar";
export type AgentCacheStatus = "pending" | "ok" | "failed";

export type AgentCacheRow = {
  url: string;
  kind: string;
  status: string;
  data: string | null;
  read_at: string | null;
  run_id: string | null;
  started_at: string | null;
  error: string | null;
  spend_usd: number | null;
  failed_at: string | null;
};

export async function getCached(db: D1Database, url: string): Promise<AgentCacheRow | null> {
  return (await db.prepare("SELECT * FROM agent_cache WHERE url = ?").bind(url).first<AgentCacheRow>()) ?? null;
}

export async function getByRunId(db: D1Database, runId: string): Promise<AgentCacheRow | null> {
  return (await db.prepare("SELECT * FROM agent_cache WHERE run_id = ?").bind(runId).first<AgentCacheRow>()) ?? null;
}

/**
 * Claims the single Agent slot for `url` only while pending rows < AGENT_SLOTS.
 * The claim is one conditional INSERT/UPSERT: two callers cannot both succeed.
 * On conflict, last-good data and read_at are left as they were.
 */
export async function insertPending(
  db: D1Database,
  p: { url: string; kind: AgentKind; run_id: string | null; started_at: string },
): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO agent_cache (url, kind, status, started_at, run_id)
       SELECT ?, ?, 'pending', ?, ?
       WHERE (SELECT COUNT(*) FROM agent_cache WHERE status = 'pending') < ?
       ON CONFLICT(url) DO UPDATE SET
         kind = excluded.kind,
         status = 'pending',
         started_at = excluded.started_at,
         run_id = excluded.run_id,
         error = NULL
       WHERE agent_cache.status <> 'pending'
         AND (SELECT COUNT(*) FROM agent_cache WHERE status = 'pending') < ?
       RETURNING url`,
    )
    .bind(p.url, p.kind, p.started_at, p.run_id, AGENT_SLOTS, AGENT_SLOTS)
    .first<{ url: string }>();
  return row !== null;
}

export async function setRunId(db: D1Database, url: string, runId: string): Promise<void> {
  await db.prepare("UPDATE agent_cache SET run_id = ? WHERE url = ?").bind(runId, url).run();
}

export async function markOk(
  db: D1Database,
  url: string,
  data: string,
  read_at: string,
  run_id: string,
  spend_usd: number,
): Promise<void> {
  await db
    .prepare(
      "UPDATE agent_cache SET status = 'ok', data = ?, read_at = ?, run_id = ?, spend_usd = ?, error = NULL, failed_at = NULL WHERE url = ?",
    )
    .bind(data, read_at, run_id, spend_usd, url)
    .run();
}

/**
 * Marks the row failed without clearing last-good data or read_at. `failedAt` is the time a started
 * run ended without a usable result; a start that never reached TinyFish passes null, so it does not
 * hold the key back from a retry.
 */
export async function markFailed(
  db: D1Database,
  url: string,
  error: string,
  failedAt: string | null = null,
): Promise<void> {
  await db
    .prepare("UPDATE agent_cache SET status = 'failed', error = ?, failed_at = ? WHERE url = ?")
    .bind(error, failedAt, url)
    .run();
}

export async function pendingCount(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM agent_cache WHERE status = 'pending'")
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Pending rows with no run id older than `olderThan` become failed with error "timeout", which frees
 * the slot. A row that has a run id is not touched here: its run is read back first (stalePendingRuns).
 */
export async function expirePending(db: D1Database, olderThan: Date, failedAt: string): Promise<number> {
  const r = await db
    .prepare(
      `UPDATE agent_cache SET status = 'failed', error = 'timeout', failed_at = ?
       WHERE status = 'pending' AND run_id IS NULL AND started_at < ?`,
    )
    .bind(failedAt, olderThan.toISOString())
    .run();
  return r.meta.changes ?? 0;
}

/** Pending rows that have a run id and were started before `olderThan`. */
export async function stalePendingRuns(db: D1Database, olderThan: Date): Promise<AgentCacheRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM agent_cache WHERE status = 'pending' AND run_id IS NOT NULL AND started_at < ?")
    .bind(olderThan.toISOString())
    .all<AgentCacheRow>();
  return results;
}

/** Fails one pending row as "timeout", only while it still belongs to `runId`. */
export async function expireRun(db: D1Database, url: string, runId: string, failedAt: string): Promise<void> {
  await db
    .prepare(
      `UPDATE agent_cache SET status = 'failed', error = 'timeout', failed_at = ?
       WHERE url = ? AND run_id = ? AND status = 'pending'`,
    )
    .bind(failedAt, url, runId)
    .run();
}

/**
 * Attaches `runId` to the pending row that has no run id and was started before `startedBefore`; true
 * when a row took it. With one slot there is at most one such row: a run whose id could not be stored
 * when it started.
 */
export async function adoptRunId(db: D1Database, runId: string, startedBefore: Date): Promise<boolean> {
  const row = await db
    .prepare(
      `UPDATE agent_cache SET run_id = ?
       WHERE status = 'pending' AND run_id IS NULL AND started_at < ?
       RETURNING url`,
    )
    .bind(runId, startedBefore.toISOString())
    .first<{ url: string }>();
  return row !== null;
}

/** The most recently cached faculty profile, or null when none has been read. */
export async function latestProfile(db: D1Database): Promise<AgentCacheRow | null> {
  return (
    (await db
      .prepare(
        "SELECT * FROM agent_cache WHERE kind = 'profile' AND data IS NOT NULL ORDER BY read_at DESC LIMIT 1",
      )
      .first<AgentCacheRow>()) ?? null
  );
}

export async function calendarRows(db: D1Database): Promise<AgentCacheRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM agent_cache WHERE kind = 'calendar'")
    .all<AgentCacheRow>();
  return results;
}
