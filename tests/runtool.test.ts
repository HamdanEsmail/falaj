import { applyD1Migrations, createExecutionContext, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolError } from "../src/core/errors";
import { recordSpend } from "../src/core/spend";
import { bump, today, utcDay } from "../src/db/counters";
import { runTool, toolJsonSchemas } from "../src/mcp/server";
import { TinyFishError } from "../src/tinyfish/client";
import { ENVELOPE, stamp } from "../src/tools/envelope";
import { defineTool, type ToolContext } from "../src/tools/types";
import { callWorker } from "./helpers/app";
import { callTool } from "./helpers/mcp";

function context(): ToolContext {
  return { env, ctx: createExecutionContext(), callerKey: "test", now: new Date("2026-11-03T10:00:00Z") };
}

// A stand-in tool whose run does whatever the test needs.
function fakeTool(run: () => Promise<any>) {
  return defineTool({
    name: "get_course",
    title: "Fake",
    description: "Test tool. Example: get_course({code: \"HSR140\"})",
    input: { code: z.string().regex(/^[A-Z]{2,5}\d{3,4}$/) },
    output: { code: z.string(), ...ENVELOPE },
    run,
  });
}

describe("health_check over MCP", () => {
  it("answers structuredContent carrying the status envelope", async () => {
    const result = await callTool("health_check", {});
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      monitors: [],
      source_url: "https://falaj.test/api/health",
      method: "status",
      cached: false,
    });
    expect(Object.keys(result.structuredContent.tools)).toHaveLength(10);
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  });
});

describe("runTool", () => {
  const ok = fakeTool(async () => stamp({ code: "HSR140" }, { source_url: "https://www.uaeu.ac.ae/x", method: "fetch", cached: false }));

  it("returns INVALID_INPUT as a JSON error body when zod rejects the arguments", async () => {
    const result = await runTool(ok, { code: "not a code" }, context());
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.code).toBe("INVALID_INPUT");
    expect(body.message).toContain("code");
  });

  it("returns a ToolError's body with only its defined fields", async () => {
    const tool = fakeTool(async () => {
      throw new ToolError("NOT_FOUND", "No course XYZ100", { near_matches: ["XYZ101"] });
    });
    const result = await runTool(tool, { code: "XYZ100" }, context());
    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
      code: "NOT_FOUND",
      message: "No course XYZ100",
      near_matches: ["XYZ101"],
    });
  });

  it("maps a timeout to UPSTREAM_TIMEOUT with retry_after_seconds 30", async () => {
    const tool = fakeTool(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    const result = await runTool(tool, { code: "HSR140" }, context());
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      code: "UPSTREAM_TIMEOUT",
      retry_after_seconds: 30,
    });
  });

  it("maps a TinyFishError, thrown directly or as a cause, to UPSTREAM_TIMEOUT with retry_after_seconds 30", async () => {
    const direct = fakeTool(async () => {
      throw new TinyFishError(500, "http_500", "TinyFish HTTP 500 http_500");
    });
    const wrapped = fakeTool(async () => {
      throw new Error("read failed", { cause: new TinyFishError(429, "http_429", "TinyFish HTTP 429 http_429") });
    });
    for (const tool of [direct, wrapped]) {
      const result = await runTool(tool, { code: "HSR140" }, context());
      expect(result.isError).toBe(true);
      expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
        code: "UPSTREAM_TIMEOUT",
        message: "TinyFish did not answer in time while reading uaeu.ac.ae",
        retry_after_seconds: 30,
      });
    }
  });

  it("returns the parsed output: keys the output shape does not name are stripped from both bodies", async () => {
    const tool = fakeTool(async () => ({
      ...stamp({ code: "HSR140" }, { source_url: "https://www.uaeu.ac.ae/x", method: "fetch", cached: false }),
      leaked: "not in the shape",
    }));
    const result = await runTool(tool, { code: "HSR140" }, context());
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).not.toHaveProperty("leaked");
    expect(result.structuredContent).toMatchObject({ code: "HSR140", method: "fetch", cached: false });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(result.structuredContent);
  });

  it("rethrows an output that does not match its shape (a bug, not a tool error)", async () => {
    const tool = fakeTool(async () => ({ code: 140, source_url: "x", read_at: "x", method: "fetch", cached: false }));
    await expect(runTool(tool, { code: "HSR140" }, context())).rejects.toThrow(z.ZodError);
  });

  it("rethrows any other error", async () => {
    const tool = fakeTool(async () => {
      throw new Error("bug");
    });
    await expect(runTool(tool, { code: "HSR140" }, context())).rejects.toThrow("bug");
  });

  it("schemas from toolJsonSchemas are JSON Schema objects", () => {
    const { inputSchema, outputSchema } = toolJsonSchemas(ok);
    expect(inputSchema).toMatchObject({ type: "object", required: ["code"] });
    expect(outputSchema.type).toBe("object");
    expect(Object.keys(outputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(["code", "source_url", "read_at", "method", "cached"]),
    );
  });
});

describe("counters and /api/stats", () => {
  it("bump returns the new count, today reads it, and /api/stats reports today's counts and spend", async () => {
    await reset();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const day = utcDay(new Date());
    expect(await today(env.DB, "fetch_urls", day)).toBe(0);
    expect(await bump(env.DB, "fetch_urls", 2, day)).toBe(2);
    expect(await bump(env.DB, "fetch_urls", 3, day)).toBe(5);
    expect(await bump(env.DB, "agent_reads", 1, day)).toBe(1);
    expect(await today(env.DB, "fetch_urls", "2000-01-01")).toBe(0);
    await recordSpend(env.DB, "agent_step", 0.016, "run-1");

    const stats = await (await callWorker("/api/stats")).json();
    expect(stats).toEqual({
      calls: 0,
      spend_usd: 0.016,
      budget_share_usd: 3.5,
      budget_pause_usd: 3,
      fetch_urls_today: 5,
      agent_reads_today: 1,
      monitors: [],
    });
  });
});
