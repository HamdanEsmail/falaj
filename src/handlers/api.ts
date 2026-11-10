// Public JSON the site reads: health, the call log, the tool list, stats.
// GET answers are cacheable for 30 seconds and readable from any origin.
import { Hono } from "hono";
import { cors } from "hono/cors";
import { BUDGET_PAUSE_USD, BUDGET_SHARE_USD } from "../core/limits";
import { totalSpend } from "../core/spend";
import { recentCalls } from "../db/calls";
import { today, utcDay } from "../db/counters";
import type { Env } from "../env";
import { toolListing } from "../mcp/server";
import { healthCheck } from "../tools/health-check";
import { TOOLS } from "../tools/registry";

export const apiRouter = new Hono<{ Bindings: Env }>();

apiRouter.use("*", cors({ origin: "*", allowMethods: ["GET"] }));
apiRouter.use("*", async (c, next) => {
  c.header("Cache-Control", "public, max-age=30");
  await next();
});

function logLimit(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return 50;
  return Math.min(n, 200);
}

apiRouter.get("/health", async (c) => {
  const body = await healthCheck.run(
    {},
    {
      env: c.env,
      ctx: c.executionCtx as ExecutionContext,
      callerKey: c.req.header("cf-connecting-ip") ?? "anon",
      now: new Date(),
    },
  );
  return c.json(body);
});

apiRouter.get("/log", async (c) => {
  return c.json(await recentCalls(c.env.DB, logLimit(c.req.query("limit"))));
});

apiRouter.get("/tools", (c) => c.json(TOOLS.map(toolListing)));

apiRouter.get("/stats", async (c) => {
  const db = c.env.DB;
  const day = utcDay(new Date());
  const [calls, spendUsd, fetchUrlsToday, agentReadsToday, monitors] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS n FROM calls").first<{ n: number }>(),
    totalSpend(db),
    today(db, "fetch_urls", day),
    today(db, "agent_reads", day),
    db
      .prepare("SELECT page, last_check_at, last_outcome FROM monitors ORDER BY page")
      .all<{ page: string; last_check_at: string | null; last_outcome: string | null }>(),
  ]);
  return c.json({
    calls: calls?.n ?? 0,
    spend_usd: spendUsd,
    budget_share_usd: BUDGET_SHARE_USD,
    budget_pause_usd: BUDGET_PAUSE_USD,
    fetch_urls_today: fetchUrlsToday,
    agent_reads_today: agentReadsToday,
    monitors: monitors.results,
  });
});
