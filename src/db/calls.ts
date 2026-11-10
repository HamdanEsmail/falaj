// One row per MCP tool call. Arguments are abbreviated and email local parts
// are masked; the caller key and any client-sent session id are stored hashed.

import { abbrev, hashKey, maskEmails } from "../core/text";

export type CallStatus = "ok" | "error";

export type LogCall = {
  tool: string;
  args: unknown;
  ms: number;
  status: CallStatus;
  error_code: string | null;
  callerKey: string;
  sessionId: string | null | undefined;
};

export async function logCall(db: D1Database, p: LogCall): Promise<void> {
  const args_abbrev = abbrev(maskEmails(JSON.stringify(p.args ?? {})));
  const key_hash = await hashKey(p.callerKey);
  const session_hash = p.sessionId ? await hashKey(p.sessionId) : null;
  await db
    .prepare(
      "INSERT INTO calls (id, tool, args_abbrev, ms, status, error_code, key_hash, session_hash, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      crypto.randomUUID(),
      p.tool,
      args_abbrev,
      p.ms,
      p.status,
      p.error_code,
      key_hash,
      session_hash,
      new Date().toISOString(),
    )
    .run();
}

/** Recent calls for the read API: no key_hash or session_hash. */
export async function recentCalls(
  db: D1Database,
  limit: number,
): Promise<{ id: string; tool: string; args_abbrev: string | null; ms: number | null; status: string; error_code: string | null; at: string }[]> {
  const { results } = await db
    .prepare(
      "SELECT id, tool, args_abbrev, ms, status, error_code, at FROM calls ORDER BY at DESC LIMIT ?",
    )
    .bind(limit)
    .all<{
      id: string;
      tool: string;
      args_abbrev: string | null;
      ms: number | null;
      status: string;
      error_code: string | null;
      at: string;
    }>();
  return results;
}
