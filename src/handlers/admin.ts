// Admin routes: token already checked by adminOnly on /api/admin/*.
import { Hono } from "hono";
import { requestCalendarRead } from "../agent/reads";
import { currentAcademicYear, isAcademicYear } from "../core/dates";
import { ToolError } from "../core/errors";
import { MAX_MONITORS } from "../core/limits";
import {
  MONITOR_PAGES,
  MONITOR_PURPOSE,
  MONITOR_SCHEDULE_CRON,
  monitorPages,
  upsertMonitor,
} from "../db/monitors";
import { setToolStatus, type ToolHealth } from "../db/toolStatus";
import type { Env } from "../env";
import { buildProgramMap, runCanaries } from "../health/run";
import { createMonitor } from "../tinyfish/monitor";
import { TOOLS } from "../tools/registry";
import type { ToolContext, ToolName } from "../tools/types";

export const adminRouter = new Hono<{ Bindings: Env }>();

function adminContext(c: { env: Env; executionCtx: unknown }): ToolContext {
  return {
    env: c.env,
    ctx: c.executionCtx as ExecutionContext,
    callerKey: "admin",
    now: new Date(),
  };
}

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));
const HEALTH: ReadonlySet<string> = new Set(["ok", "degraded", "broken"]);

adminRouter.post("/health-run", async (c) => {
  return c.json(await runCanaries(c.env, c.executionCtx as ExecutionContext, "manual"));
});

adminRouter.post("/program-map", async (c) => {
  return c.json(await buildProgramMap(c.env, c.executionCtx as ExecutionContext, new Date()));
});

adminRouter.post("/calendar-read", async (c) => {
  let body: { academic_year?: unknown } = {};
  try {
    body = (await c.req.json()) as { academic_year?: unknown };
  } catch {
    body = {};
  }
  const t = adminContext(c);
  const given = typeof body.academic_year === "string" ? body.academic_year.trim() : "";
  const year = given || currentAcademicYear(t.now);
  if (!isAcademicYear(year)) {
    return c.json({ error: "invalid_academic_year" }, 400);
  }
  try {
    return c.json(await requestCalendarRead(t, year, { force: true }));
  } catch (err) {
    if (err instanceof ToolError) return c.json(err.toBody(), 409);
    throw err;
  }
});

adminRouter.post("/tool-status", async (c) => {
  let body: { tool?: unknown; status?: unknown; detail?: unknown };
  try {
    body = (await c.req.json()) as { tool?: unknown; status?: unknown; detail?: unknown };
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (typeof body.tool !== "string" || !TOOL_NAMES.has(body.tool as ToolName)) {
    return c.json({ error: "unknown_tool" }, 400);
  }
  if (typeof body.status !== "string" || !HEALTH.has(body.status)) {
    return c.json({ error: "invalid_status" }, 400);
  }
  const detail = typeof body.detail === "string" ? body.detail : null;
  await setToolStatus(c.env.DB, body.tool, body.status as ToolHealth, detail, new Date());
  return c.json({ ok: true, tool: body.tool, status: body.status, detail });
});

// Makes the Monitor of each page that has none stored. A page that already has one is left alone, so a
// second run after a failure makes only what is missing and never a second Monitor for one page (the
// first would keep running at TinyFish, billed, with its reports ignored). A page whose Monitor cannot
// be made does not stop the others; the answer names it and is 502.
adminRouter.post("/monitors-init", async (c) => {
  const have = await monitorPages(c.env.DB);
  const missing = MONITOR_PAGES.filter((spec) => !have.has(spec.page));
  if (missing.length === 0 || have.size >= MAX_MONITORS) {
    return c.json({ error: "monitors already exist" });
  }
  const webhookUrl = `${c.env.PUBLIC_BASE_URL}/api/webhooks/monitor/${c.env.WEBHOOK_SECRET}`;
  const created: { page: string; monitor_id: string }[] = [];
  const failed: string[] = [];
  for (const spec of missing) {
    try {
      const out = await createMonitor(c.env, {
        url: spec.url,
        name: `falaj-${spec.page}`,
        scheduleCron: MONITOR_SCHEDULE_CRON,
        purpose: MONITOR_PURPOSE,
        webhookUrl,
      });
      await upsertMonitor(c.env.DB, { page: spec.page, monitor_id: out.monitorId, url: spec.url });
      created.push({ page: spec.page, monitor_id: out.monitorId });
    } catch {
      failed.push(spec.page);
    }
  }
  if (failed.length > 0) return c.json({ monitors: created, failed }, 502);
  return c.json({ monitors: created });
});
