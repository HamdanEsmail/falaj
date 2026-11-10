// Global daily counters (Falaj's Fetch URL cap and Agent read cap), kept in
// the `rate` table as key_hash = "global:<key>", bucket = "d:<YYYY-MM-DD>" (UTC).

export type CounterKey = "fetch_urls" | "agent_reads";

/** The UTC day of `now` as `YYYY-MM-DD`. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Adds `n` to today's count for `key` and returns the new count. */
export async function bump(db: D1Database, key: CounterKey, n: number, day: string): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO rate (key_hash, bucket, count) VALUES (?, ?, ?)
       ON CONFLICT (key_hash, bucket) DO UPDATE SET count = count + excluded.count
       RETURNING count`,
    )
    .bind(`global:${key}`, `d:${day}`, n)
    .first<{ count: number }>();
  return row?.count ?? n;
}

/** Today's count for `key` (0 when nothing was counted). */
export async function today(db: D1Database, key: CounterKey, day: string): Promise<number> {
  const row = await db
    .prepare("SELECT count FROM rate WHERE key_hash = ? AND bucket = ?")
    .bind(`global:${key}`, `d:${day}`)
    .first<{ count: number }>();
  return row?.count ?? 0;
}
