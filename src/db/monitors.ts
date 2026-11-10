// Falaj's two catalogue Page monitors. A Monitor is created, read or deleted
// only when its id is stored here. The account's other Monitors are never listed,
// paused, edited, resumed or deleted.
import { CATALOGUE_URL, PROGRAM_INDEX_URL } from "../catalogue/read";

export const MONITOR_PAGES = [
  { page: "catalogue", url: CATALOGUE_URL },
  { page: "programs", url: PROGRAM_INDEX_URL },
] as const;

export const MONITOR_SCHEDULE_CRON = "0 */12 * * *";
export const MONITOR_PURPOSE = "The page structure changed or the list of courses or programmes changed.";

export type MonitorRow = {
  page: string;
  monitor_id: string | null;
  url: string | null;
  last_check_at: string | null;
  last_outcome: string | null;
  site_changed_at: string | null;
  /** Set when the Monitor reported a change and the health pass that answers it has not run yet. */
  canaries_due_at: string | null;
};

export async function countMonitors(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM monitors").first<{ n: number }>();
  return row?.n ?? 0;
}

/** The pages that have a Monitor stored. */
export async function monitorPages(db: D1Database): Promise<Set<string>> {
  const { results } = await db.prepare("SELECT page FROM monitors WHERE monitor_id IS NOT NULL").all<{ page: string }>();
  return new Set(results.map((r) => r.page));
}

export async function getByMonitorId(db: D1Database, monitorId: string): Promise<MonitorRow | null> {
  return (
    (await db.prepare("SELECT * FROM monitors WHERE monitor_id = ?").bind(monitorId).first<MonitorRow>()) ?? null
  );
}

export async function upsertMonitor(
  db: D1Database,
  row: { page: string; monitor_id: string; url: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO monitors (page, monitor_id, url, last_check_at, last_outcome, site_changed_at)
       VALUES (?, ?, ?, NULL, NULL, NULL)
       ON CONFLICT (page) DO UPDATE SET monitor_id = excluded.monitor_id, url = excluded.url`,
    )
    .bind(row.page, row.monitor_id, row.url)
    .run();
}

export async function recordMonitorCheck(
  db: D1Database,
  monitorId: string,
  outcome: string,
  at: Date,
  siteChanged: boolean,
): Promise<void> {
  const ts = at.toISOString();
  if (siteChanged) {
    await db
      .prepare(
        "UPDATE monitors SET last_check_at = ?, last_outcome = ?, site_changed_at = ?, canaries_due_at = ? WHERE monitor_id = ?",
      )
      .bind(ts, outcome, ts, ts, monitorId)
      .run();
    return;
  }
  await db
    .prepare("UPDATE monitors SET last_check_at = ?, last_outcome = ? WHERE monitor_id = ?")
    .bind(ts, outcome, monitorId)
    .run();
}

/** True when a Monitor change is waiting for its health pass. */
export async function canariesDue(db: D1Database): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS due FROM monitors WHERE canaries_due_at IS NOT NULL LIMIT 1").first<{ due: number }>();
  return row !== null;
}

/**
 * Clears the mark of every change that was waiting when the pass started. A change marked after
 * `passStarted` stays due, so the next quarter hour answers it.
 */
export async function clearCanariesDue(db: D1Database, passStarted: Date): Promise<void> {
  await db.prepare("UPDATE monitors SET canaries_due_at = NULL WHERE canaries_due_at <= ?").bind(passStarted.toISOString()).run();
}

export async function monitorCheckRecorded(db: D1Database, payloadId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT id FROM spend WHERE kind = 'monitor_check' AND ref = ?")
    .bind(payloadId)
    .first<{ id: string }>();
  return row !== null;
}
