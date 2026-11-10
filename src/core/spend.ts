// The spend ledger. Every TinyFish charge appends one row; the totals feed the
// budget pause (BUDGET_PAUSE_USD) and the public /api/stats.

export type SpendKind = "agent_step" | "monitor_check" | "fetch" | "search";

/** US dollars per unit of each kind. Fetch and Search are free inside the caps. */
export const PRICES: Record<SpendKind, number> = {
  agent_step: 0.016,
  monitor_check: 0.005,
  fetch: 0,
  search: 0,
};

/** Appends one row to the ledger. `ref` says what the money was spent on (a run id, a monitor id). */
export async function recordSpend(
  db: D1Database,
  kind: SpendKind,
  amountUsd: number,
  ref: string,
): Promise<void> {
  await db
    .prepare("INSERT INTO spend (id, kind, amount_usd, ref, at) VALUES (?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), kind, amountUsd, ref, new Date().toISOString())
    .run();
}

/**
 * Appends one row unless the ledger already holds a row of this kind for `ref`; true when it was
 * appended. It is one statement, so two callers booking the same `ref` cannot both append.
 */
export async function recordSpendOnce(
  db: D1Database,
  kind: SpendKind,
  amountUsd: number,
  ref: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO spend (id, kind, amount_usd, ref, at)
       SELECT ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM spend WHERE kind = ? AND ref = ?)
       RETURNING id`,
    )
    .bind(crypto.randomUUID(), kind, amountUsd, ref, new Date().toISOString(), kind, ref)
    .first<{ id: string }>();
  return row !== null;
}

/** Falaj's total spend so far, in US dollars. */
export async function totalSpend(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COALESCE(SUM(amount_usd), 0) AS total FROM spend")
    .first<{ total: number }>();
  return row?.total ?? 0;
}

/** Spend so far per kind, in US dollars; every kind is present (0 when nothing was spent on it). */
export async function spendByKind(db: D1Database): Promise<Record<SpendKind, number>> {
  const totals: Record<SpendKind, number> = { agent_step: 0, monitor_check: 0, fetch: 0, search: 0 };
  const { results } = await db
    .prepare("SELECT kind, SUM(amount_usd) AS total FROM spend GROUP BY kind")
    .all<{ kind: string; total: number }>();
  for (const row of results) {
    if (row.kind in totals) totals[row.kind as SpendKind] = row.total;
  }
  return totals;
}
