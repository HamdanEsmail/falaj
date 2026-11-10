// Nightly / monitor / manual canary pass. Rebuilds the programme map first,
// then runs each canary through runTool with the broken-tool gate off so a
// broken tool can recover. Canaries never start a first Agent read.
import { readProgramIndex } from "../catalogue/read";
import { currentAcademicYear } from "../core/dates";
import { BUDGET_PAUSE_USD, CANARY_SLOW_MS, FETCH_BATCH_MAX } from "../core/limits";
import { totalSpend } from "../core/spend";
import { slugToName } from "../core/text";
import { getCached, latestProfile } from "../db/agentCache";
import { insertCanaryRun, type CanaryTrigger } from "../db/canaryRuns";
import { pruneProgramMap, upsertProgramMap } from "../db/programMap";
import { setToolStatus, type ToolHealth } from "../db/toolStatus";
import type { Env } from "../env";
import { CALENDAR_URL } from "../parsers/calendar";
import { parseProgramPage, programKind } from "../parsers/program";
import { countFetch, fetchPages } from "../tinyfish/fetch";
import { runTool } from "../mcp/server";
import { toolByName } from "../tools/registry";
import type { ToolContext } from "../tools/types";
import { CANARIES, canaryByTool, type CanaryLevel } from "./canaries";

/** Injectable clock so a slow-canary test can jump past CANARY_SLOW_MS. */
export const canaryClock = { now: (): number => Date.now() };

export type CanaryItemResult = {
  tool: string;
  level: CanaryLevel | "skipped" | "blocked";
  detail: string;
  ms: number;
};

export type CanaryRunResult = {
  id: string;
  at: string;
  trigger: CanaryTrigger;
  results: CanaryItemResult[];
  duration_ms: number;
};

function canaryContext(env: Env, ctx: ExecutionContext, now: Date): ToolContext {
  return { env, ctx, callerKey: "canary", now, allowAgentStart: false };
}

/**
 * Index + each programme page in batches of FETCH_BATCH_MAX. Rows are keyed by
 * the URL asked for (never TinyFish's final_url). Pages no longer on the index
 * are dropped from the map.
 */
export async function buildProgramMap(
  env: Env,
  ctx: ExecutionContext,
  now = new Date(),
): Promise<{ programs: number; built_at: string }> {
  const t = canaryContext(env, ctx, now);
  const index = await readProgramIndex(t);
  const rows: { url: string; name: string; college: string | null; kind: ReturnType<typeof programKind> }[] = [];
  for (let i = 0; i < index.urls.length; i += FETCH_BATCH_MAX) {
    const batch = index.urls.slice(i, i + FETCH_BATCH_MAX);
    await countFetch(t, batch.length);
    const fetched = await fetchPages(env, batch, { links: false });
    for (let j = 0; j < batch.length; j++) {
      const url = batch[j]!;
      const page = fetched[j];
      if (!page || !page.ok) continue;
      const parsed = parseProgramPage(page.text);
      const slug = /\/([^/]+)\.shtml$/.exec(url)?.[1] ?? url;
      const name = parsed.name || slugToName(slug);
      rows.push({ url, name, college: parsed.college, kind: programKind(name) });
    }
  }
  await upsertProgramMap(env.DB, rows, now);
  await pruneProgramMap(env.DB, index.urls);
  return { programs: rows.length, built_at: now.toISOString() };
}

const BLOCKED = new Set(["BUDGET_PAUSED", "RATE_LIMITED", "UPSTREAM_TIMEOUT"]);

export async function runCanaries(
  env: Env,
  ctx: ExecutionContext,
  trigger: CanaryTrigger,
): Promise<CanaryRunResult> {
  const started = canaryClock.now();
  const now = new Date();
  const t = canaryContext(env, ctx, now);
  try {
    await buildProgramMap(env, ctx, now);
  } catch {
    // Canaries still run against whatever map is already stored.
  }

  const spend = await totalSpend(env.DB);
  const results: CanaryItemResult[] = [];

  for (const canary of CANARIES) {
    if (canary.tool === "get_faculty_profile") {
      const latest = await latestProfile(env.DB);
      if (latest === null) {
        results.push({ tool: canary.tool, level: "skipped", detail: "no cached profile yet", ms: 0 });
        continue;
      }
      await runOne(canary.tool, { profile_url: latest.url }, t, now, results);
      continue;
    }
    if (canary.tool === "get_academic_calendar") {
      const year = currentAcademicYear(now);
      const row = await getCached(env.DB, `${CALENDAR_URL}#${year}`);
      if (row === null || row.data === null) {
        const detail =
          spend >= BUDGET_PAUSE_USD
            ? "BUDGET_PAUSED: new Agent reads are refused"
            : "no cached data yet";
        results.push({ tool: canary.tool, level: "skipped", detail, ms: 0 });
        continue;
      }
    }
    await runOne(canary.tool, canary.args, t, now, results);
  }

  const duration_ms = canaryClock.now() - started;
  const id = crypto.randomUUID();
  const at = now.toISOString();
  await insertCanaryRun(env.DB, { id, at, trigger, results, duration_ms });
  return { id, at, trigger, results, duration_ms };
}

async function runOne(
  tool: string,
  args: unknown,
  t: ToolContext,
  now: Date,
  results: CanaryItemResult[],
): Promise<void> {
  const def = toolByName(tool);
  const canary = canaryByTool(tool);
  if (!def || !canary) return;
  const t0 = canaryClock.now();
  const result = await runTool(def, args, t, { gate: false });
  const ms = canaryClock.now() - t0;

  if (result.isError) {
    const text = (result.content[0] as { text?: string } | undefined)?.text ?? "{}";
    let body: { code?: string; message?: string } = {};
    try {
      body = JSON.parse(text) as { code?: string; message?: string };
    } catch {
      body = { message: text };
    }
    const code = typeof body.code === "string" ? body.code : "error";
    const detail = `${code}: ${body.message ?? ""}`.trim();
    if (BLOCKED.has(code)) {
      results.push({ tool, level: "blocked", detail, ms });
      return;
    }
    await setToolStatus(t.env.DB, tool, "broken", detail, now);
    results.push({ tool, level: "broken", detail, ms });
    return;
  }

  const checked = canary.check(result.structuredContent);
  let level: CanaryLevel = checked.level;
  let detail = checked.detail;
  if (level === "ok" && ms > CANARY_SLOW_MS) {
    level = "degraded";
    detail = `${detail} (slower than ${CANARY_SLOW_MS}ms)`;
  }
  await setToolStatus(t.env.DB, tool, level as ToolHealth, detail, now);
  results.push({ tool, level, detail, ms });
}
