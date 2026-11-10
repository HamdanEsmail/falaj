import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bump, today, utcDay } from "../src/db/counters";
import { runTool } from "../src/mcp/server";
import { searchCourses } from "../src/tools/search-courses";
import type { ToolContext } from "../src/tools/types";
import { callWorker } from "./helpers/app";
import catalogueFixture from "./fixtures/uaeu/catalogue-index.json";
import { hashKey } from "../src/core/text";
import { fetchMock } from "./helpers/fetch-mock";
import { callTool, rpc } from "./helpers/mcp";
import searchFaculty from "./fixtures/tinyfish/search-faculty.json";

const SEARCH_API = /^https:\/\/api\.search\.tinyfish\.ai\/\?/;

function errorBody(r: any): any {
  expect(r.isError).toBe(true);
  return JSON.parse(r.content[0].text);
}

beforeEach(async () => {
  fetchMock.activate();
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  fetchMock.intercept({
    url: SEARCH_API,
    times: Infinity,
    reply: { json: searchFaculty },
  });
});
afterEach(() => fetchMock.reset());

describe("call log", () => {
  it("every tool call writes a log row with masked, abbreviated args and no raw caller key", async () => {
    await callTool("find_faculty", { query: "a.example@uaeu.ac.ae" });
    const row = (await env.DB.prepare("SELECT * FROM calls").all()).results[0] as {
      args_abbrev: string;
      key_hash: string;
      tool: string;
      status: string;
    };
    expect(row.tool).toBe("find_faculty");
    expect(row.status).toBe("ok");
    expect(row.args_abbrev).toContain("***@uaeu.ac.ae");
    expect(row.args_abbrev).not.toContain("a.example@");
    expect(row.key_hash).toHaveLength(16);
    expect(JSON.stringify(row)).not.toContain("anon");
  });
});

describe("caller rate limits", () => {
  it("the 121st call in a minute from one caller is 429 RATE_LIMITED scope caller", async () => {
    const ip = "203.0.113.10";
    const minute = `m:${new Date().toISOString().slice(0, 16)}`;
    await env.DB.prepare("INSERT INTO rate (key_hash, bucket, count) VALUES (?, ?, 120)")
      .bind(await hashKey(ip), minute)
      .run();
    const r = await rpc("tools/call", { name: "health_check", arguments: {} }, 1, {
      "cf-connecting-ip": ip,
    });
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ code: "RATE_LIMITED", scope: "caller" });
    expect(r.body.jsonrpc).toBeUndefined();
  });

  it("the caller key is the IP alone; a client-sent Mcp-Session-Id is only logged", async () => {
    const ip = "203.0.113.11";
    await callTool("find_faculty", { query: "example" }, { "cf-connecting-ip": ip, "mcp-session-id": "sess-a" });
    await callTool("find_faculty", { query: "example" }, { "cf-connecting-ip": ip, "mcp-session-id": "sess-b" });
    const hashed = await hashKey(ip);
    const rates = (
      await env.DB.prepare("SELECT bucket, count FROM rate WHERE key_hash = ?").bind(hashed).all<{
        bucket: string;
        count: number;
      }>()
    ).results;
    expect(rates.some((row) => row.bucket.startsWith("m:") && row.count === 2)).toBe(true);
    expect(rates.some((row) => row.bucket.startsWith("d:") && row.count === 2)).toBe(true);
    const logs = (
      await env.DB.prepare("SELECT session_hash, key_hash FROM calls ORDER BY at").all<{
        session_hash: string;
        key_hash: string;
      }>()
    ).results;
    expect(logs).toHaveLength(2);
    expect(logs[0]!.key_hash).toBe(hashed);
    expect(logs[1]!.key_hash).toBe(hashed);
    expect(logs[0]!.session_hash).toHaveLength(16);
    expect(logs[1]!.session_hash).toHaveLength(16);
    expect(logs[0]!.session_hash).not.toBe(logs[1]!.session_hash);
  });
});

describe("one message per request", () => {
  const batch = (n: number, name: string, args: Record<string, unknown>) =>
    Array.from({ length: n }, (_, i) => ({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params: { name, arguments: args } }));
  const post = (body: unknown, ip: string) =>
    callWorker("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "cf-connecting-ip": ip },
      body: JSON.stringify(body),
    });

  it("a batch of calls in one POST is refused whole: no tool runs and nothing is logged", async () => {
    const res = await post(batch(100, "health_check", {}), "203.0.113.20");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_INPUT", message: expect.stringMatching(/one .*message per request/i) });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM calls").first<{ n: number }>())!.n).toBe(0);
  });

  it("a batch of one is refused too, and a single message still works", async () => {
    expect((await post(batch(1, "health_check", {}), "203.0.113.21")).status).toBe(400);
    const one = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "health_check", arguments: {} } }, "203.0.113.21");
    expect(one.status).toBe(200);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM calls WHERE tool = 'health_check'").first<{ n: number }>())!.n).toBe(1);
  });

  it("a body that is not JSON is refused without running anything", async () => {
    const res = await callWorker("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "cf-connecting-ip": "203.0.113.22" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM calls").first<{ n: number }>())!.n).toBe(0);
  });
});

describe("Fetch cap", () => {
  it("holds when many calls arrive at once: with one URL left, one page is read and the count ends at the cap", async () => {
    const day = utcDay(new Date());
    await bump(env.DB, "fetch_urls", 399, day);
    const cat = catalogueFixture.results[0]!;
    const page = "https://www.uaeu.ac.ae/en/catalog/courses/";
    fetchMock.intercept({
      url: "https://api.fetch.tinyfish.ai",
      times: Infinity,
      reply: { json: { results: [{ url: page, final_url: page, text: cat.text, links: cat.links }], errors: [] } },
    });
    const ctx = (): ToolContext => ({
      env,
      ctx: { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
      callerKey: "203.0.113.30",
      now: new Date(),
    });
    const results = await Promise.all(Array.from({ length: 20 }, () => runTool(searchCourses, { query: "ECON" }, ctx())));
    expect(fetchMock.calls.filter((c) => c.url.startsWith("https://api.fetch.tinyfish.ai"))).toHaveLength(1);
    expect(results.filter((r) => !r.isError)).toHaveLength(1);
    // A refused call gives back what it counted, so the day's count is the URLs really sent.
    expect(await today(env.DB, "fetch_urls", day)).toBe(400);
  });

  it("the 401st Fetch URL of the day is RATE_LIMITED scope global and makes no TinyFish call", async () => {
    await bump(env.DB, "fetch_urls", 400, utcDay(new Date()));
    const r = await callTool("get_course", { code: "HSR140" });
    expect(errorBody(r)).toMatchObject({ code: "RATE_LIMITED", scope: "global" });
    expect(fetchMock.calls.filter((c) => c.url.includes("api.fetch.tinyfish.ai"))).toHaveLength(0);
  });
});
