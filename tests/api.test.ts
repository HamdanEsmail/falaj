import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { bump, utcDay } from "../src/db/counters";
import { ARGS_ABBREV_CHARS } from "../src/core/limits";
import { recordSpend } from "../src/core/spend";
import { callWorker } from "./helpers/app";
import { callTool, listTools } from "./helpers/mcp";

function expectPublicGet(res: Response) {
  expect(res.headers.get("cache-control")).toBe("public, max-age=30");
  expect(res.headers.get("access-control-allow-origin")).toBe("*");
}

describe("read API", () => {
  it("GET /api/tools lists ten tools whose names and schemas match tools/list", async () => {
    const res = await callWorker("/api/tools");
    expect(res.status).toBe(200);
    expectPublicGet(res);
    const api = (await res.json()) as any[];
    const list = await listTools();
    expect(api.map((t: any) => t.name).sort()).toEqual(list.map((t: any) => t.name).sort());
    expect(api).toHaveLength(10);
    for (const tool of api) {
      const mcp = list.find((t: any) => t.name === tool.name);
      expect(mcp).toBeDefined();
      expect(tool.title).toBe(mcp.title);
      expect(tool.description).toBe(mcp.description);
      expect(tool.inputSchema).toEqual(mcp.inputSchema);
      expect(tool.outputSchema).toEqual(mcp.outputSchema);
      expect(tool.annotations).toEqual(mcp.annotations);
    }
  });

  it("GET /api/log never includes key_hash and abbreviates args", async () => {
    await reset();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await callTool("health_check", {
      note: `a.example@uaeu.ac.ae ${"z".repeat(120)}`,
    });
    const res = await callWorker("/api/log");
    expect(res.status).toBe(200);
    expectPublicGet(res);
    const rows = (await res.json()) as any[];
    expect(rows).toHaveLength(1);
    const body = JSON.stringify(rows);
    expect(body).not.toContain("key_hash");
    expect(body).not.toContain("session_hash");
    expect(body).not.toMatch(/203\.\d+\.\d+\.\d+/);
    expect(rows[0].tool).toBe("health_check");
    expect(rows[0].args_abbrev).toContain("***@uaeu.ac.ae");
    expect(rows[0].args_abbrev).not.toContain("a.example");
    expect(rows[0].args_abbrev.length).toBeLessThanOrEqual(ARGS_ABBREV_CHARS);
    const capped = await callWorker("/api/log?limit=999");
    expect(((await capped.json()) as any[]).length).toBeLessThanOrEqual(200);
  });

  it("GET /api/health mirrors health_check", async () => {
    const res = await callWorker("/api/health");
    expect(res.status).toBe(200);
    expectPublicGet(res);
    const api = (await res.json()) as any;
    const mcp = (await callTool("health_check", {})).structuredContent;
    expect(Object.keys(api).sort()).toEqual(Object.keys(mcp).sort());
    expect(Object.keys(api.tools).sort()).toEqual(Object.keys(mcp.tools).sort());
    expect(api.method).toBe("status");
    expect(api.source_url).toBe(mcp.source_url);
    expect(api.cached).toBe(false);
    expect(api.monitors).toEqual(mcp.monitors);
    expect(api.spend).toEqual(mcp.spend);
    expect(api.site_changed_at).toBe(mcp.site_changed_at);
    for (const name of Object.keys(api.tools)) {
      expect(api.tools[name].status).toBe(mcp.tools[name].status);
    }
  });

  it("GET /api/stats carries today's counters", async () => {
    await reset();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const day = utcDay(new Date());
    await bump(env.DB, "fetch_urls", 4, day);
    await bump(env.DB, "agent_reads", 2, day);
    await recordSpend(env.DB, "agent_step", 0.016, "run-stats");
    await env.DB.prepare(
      "INSERT INTO monitors (page, monitor_id, url, last_check_at, last_outcome, site_changed_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind("catalogue", "mon-test-1", "https://www.uaeu.ac.ae/en/catalog/courses/", "2026-11-09T00:00:00Z", "unchanged", null)
      .run();

    const res = await callWorker("/api/stats");
    expect(res.status).toBe(200);
    expectPublicGet(res);
    expect(await res.json()).toEqual({
      calls: 0,
      spend_usd: 0.016,
      budget_share_usd: 3.5,
      budget_pause_usd: 3,
      fetch_urls_today: 4,
      agent_reads_today: 2,
      monitors: [{ page: "catalogue", last_check_at: "2026-11-09T00:00:00Z", last_outcome: "unchanged" }],
    });
  });
});
