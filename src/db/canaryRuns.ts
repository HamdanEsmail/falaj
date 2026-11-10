// One row per canary pass (nightly, monitor, or manual).

export type CanaryTrigger = "nightly" | "monitor" | "manual";

export type CanaryRunRow = {
  id: string;
  at: string;
  trigger: CanaryTrigger;
  results: unknown;
  duration_ms: number;
};

export async function insertCanaryRun(db: D1Database, row: CanaryRunRow): Promise<void> {
  await db
    .prepare("INSERT INTO canary_runs (id, at, trigger, results, duration_ms) VALUES (?, ?, ?, ?, ?)")
    .bind(row.id, row.at, row.trigger, JSON.stringify(row.results), row.duration_ms)
    .run();
}
