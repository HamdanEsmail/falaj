#!/usr/bin/env node
// Smoke the MCP endpoint: initialize, tools/list (ten names), health_check, search_courses.
// Usage: node scripts/mcp-smoke.mjs <base-url>
// Exit 1 on any failed step. Does not print secrets.
const NAMES = [
  "search_courses",
  "get_course",
  "list_programs",
  "get_program",
  "list_events",
  "academic_deadlines",
  "find_faculty",
  "get_faculty_profile",
  "get_academic_calendar",
  "health_check",
];

const base = (process.argv[2] ?? "http://localhost:8787").replace(/\/$/, "");
const mcp = `${base}/mcp`;
const headers = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

let failed = false;

async function step(name, method, params) {
  const started = Date.now();
  let status = 0;
  let body = null;
  try {
    const res = await fetch(mcp, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    status = res.status;
    const text = await res.text();
    body = text === "" ? null : JSON.parse(text);
  } catch (err) {
    status = 0;
    body = { error: { message: err instanceof Error ? err.message : "request failed" } };
  }
  const ms = Date.now() - started;
  console.log(`${name} ${status} ${ms}ms`);
  return { status, body };
}

function fail(message) {
  console.error(message);
  failed = true;
}

const init = await step("initialize", "initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "falaj-smoke", version: "0" },
});
if (init.status !== 200 || init.body?.error || !init.body?.result) fail("initialize failed");

const list = await step("tools/list", "tools/list", {});
const listed = (list.body?.result?.tools ?? []).map((t) => t.name).sort();
const expected = [...NAMES].sort();
if (list.status !== 200 || list.body?.error || listed.join() !== expected.join()) {
  fail(`tools/list expected 10 names ${expected.join(", ")}; got ${listed.join(", ") || "none"}`);
}

const health = await step("health_check", "tools/call", { name: "health_check", arguments: {} });
if (health.status !== 200 || health.body?.error || health.body?.result?.isError) fail("health_check failed");

const search = await step("search_courses", "tools/call", {
  name: "search_courses",
  arguments: { query: "ECON" },
});
if (search.status !== 200 || search.body?.error || search.body?.result?.isError) fail("search_courses failed");

if (failed) process.exit(1);
