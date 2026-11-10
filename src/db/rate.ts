// Per-caller limits on POST /mcp. The rate key is the hashed caller IP; a
// client-sent Mcp-Session-Id is never a rate key.

import { CALLER_PER_DAY, CALLER_PER_MINUTE, TRY_PER_DAY, TRY_PER_MINUTE } from "../core/limits";
import { hashKey } from "../core/text";
import { utcDay } from "./counters";

export type CallerCheck = { ok: true } | { ok: false; retry_after_seconds: number };

async function bumpBucket(db: D1Database, keyHash: string, bucket: string): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO rate (key_hash, bucket, count) VALUES (?, ?, 1)
       ON CONFLICT (key_hash, bucket) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(keyHash, bucket)
    .first<{ count: number }>();
  return row?.count ?? 1;
}

function secondsToNextMinute(now: Date): number {
  return Math.max(1, 60 - now.getUTCSeconds());
}

function secondsToUtcMidnight(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

export async function checkCaller(db: D1Database, callerKey: string, now: Date): Promise<CallerCheck> {
  const keyHash = await hashKey(callerKey);
  const minute = `m:${now.toISOString().slice(0, 16)}`;
  const day = `d:${utcDay(now)}`;
  const minuteCount = await bumpBucket(db, keyHash, minute);
  const dayCount = await bumpBucket(db, keyHash, day);
  if (minuteCount > CALLER_PER_MINUTE) return { ok: false, retry_after_seconds: secondsToNextMinute(now) };
  if (dayCount > CALLER_PER_DAY) return { ok: false, retry_after_seconds: secondsToUtcMidnight(now) };
  return { ok: true };
}

/**
 * The same kind of limit for the page's own form, counted apart from POST /mcp so a visitor trying
 * the page does not use up what their assistant may call.
 */
export async function checkTry(db: D1Database, callerKey: string, now: Date): Promise<CallerCheck> {
  const keyHash = await hashKey(callerKey);
  const minuteCount = await bumpBucket(db, keyHash, `tm:${now.toISOString().slice(0, 16)}`);
  const dayCount = await bumpBucket(db, keyHash, `td:${utcDay(now)}`);
  if (minuteCount > TRY_PER_MINUTE) return { ok: false, retry_after_seconds: secondsToNextMinute(now) };
  if (dayCount > TRY_PER_DAY) return { ok: false, retry_after_seconds: secondsToUtcMidnight(now) };
  return { ok: true };
}
