// Per-tool canary verdict. A broken tool is refused at the gate with SITE_CHANGED
// and no TinyFish call; ok and degraded stay callable.

import type { ToolName } from "../tools/types";

export type ToolHealth = "ok" | "degraded" | "broken";

export type ToolStatusRow = {
  tool: string;
  status: ToolHealth;
  detail: string | null;
  last_ok_at: string | null;
  last_checked_at: string | null;
};

export async function getToolStatus(db: D1Database, tool: string): Promise<ToolStatusRow | null> {
  const row = await db
    .prepare("SELECT tool, status, detail, last_ok_at, last_checked_at FROM tool_status WHERE tool = ?")
    .bind(tool)
    .first<ToolStatusRow>();
  return row ?? null;
}

export async function allToolStatus(db: D1Database): Promise<Map<string, ToolStatusRow>> {
  const { results } = await db
    .prepare("SELECT tool, status, detail, last_ok_at, last_checked_at FROM tool_status")
    .all<ToolStatusRow>();
  const out = new Map<string, ToolStatusRow>();
  for (const r of results) out.set(r.tool, r);
  return out;
}

/** Writes a canary (or admin) verdict. last_ok_at moves only when the tool is still serving. */
export async function setToolStatus(
  db: D1Database,
  tool: ToolName | string,
  status: ToolHealth,
  detail: string | null,
  at: Date,
): Promise<void> {
  const ts = at.toISOString();
  const lastOk = status === "broken" ? null : ts;
  await db
    .prepare(
      `INSERT INTO tool_status (tool, status, detail, last_ok_at, last_checked_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (tool) DO UPDATE SET
         status = excluded.status,
         detail = excluded.detail,
         last_checked_at = excluded.last_checked_at,
         last_ok_at = CASE
           WHEN excluded.status = 'broken' THEN tool_status.last_ok_at
           ELSE excluded.last_ok_at
         END`,
    )
    .bind(tool, status, detail, lastOk, ts)
    .run();
}
