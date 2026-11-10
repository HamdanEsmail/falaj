import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordSpend, spendByKind } from "../src/core/spend";
import { currentAcademicYear } from "../src/core/dates";
import { bump, today, utcDay } from "../src/db/counters";
import { fetchMock } from "./helpers/fetch-mock";
import { callWorker } from "./helpers/app";
import { callTool } from "./helpers/mcp";
import agentRunCalendar from "./fixtures/tinyfish/agent-run-calendar.json";
import catalogueFixture from "./fixtures/uaeu/catalogue-index.json";
import hsrFixture from "./fixtures/uaeu/course-hsr140.json";

const RUN_ASYNC_API = "https://agent.tinyfish.ai/v1/automation/run-async";
const RUNS_API = "https://agent.tinyfish.ai/v1/runs";
const FETCH_API = "https://api.fetch.tinyfish.ai";
const PROFILE_URL = "https://www.uaeu.ac.ae/en/cmhs/profile.shtml?email=a.example@uaeu.ac.ae";
const OTHER_PROFILE_URL = "https://www.uaeu.ac.ae/en/eng/profile.shtml?email=b.example@uaeu.ac.ae";
const CALENDAR_URL = "https://www.uaeu.ac.ae/en/calendar/";
const CATALOGUE_URL = "https://www.uaeu.ac.ae/en/catalog/courses/";
const HSR_URL = "https://www.uaeu.ac.ae/en/catalog/courses/course_2924.shtml?id=HSR140";

const profileResult = {
  name: "Amal Example",
  title: "Assistant Professor",
  college: "College of Medicine and Health Sciences",
  department: "Public Health",
  email: "a.example@uaeu.ac.ae",
  research_interests: ["epidemiology"],
  education: ["PhD in Public Health"],
};

const cat = catalogueFixture.results[0]!;
const hsr = hsrFixture.results[0]!;

function runAsyncCalls() {
  return fetchMock.calls.filter((c) => c.url.includes("run-async"));
}

function interceptRunAsync(runId = "r1"): void {
  fetchMock.intercept({
    method: "POST",
    url: RUN_ASYNC_API,
    times: Infinity,
    reply: { json: { run_id: runId } },
  });
}

/** What TinyFish answers when Falaj reads run `runId` back. */
function interceptGetRun(runId: string, run: Record<string, unknown>, times = 1): void {
  fetchMock.intercept({
    method: "GET",
    url: `${RUNS_API}/${runId}?screenshots=none&html=none`,
    times,
    reply: { json: { run_id: runId, ...run } },
  });
}

function getRunCalls() {
  return fetchMock.calls.filter((c) => c.method === "GET" && c.url.startsWith(RUNS_API));
}

function postAgentHook(body: unknown): Promise<Response> {
  return callWorker("/api/webhooks/agent/test-secret", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function cacheRow(url: string) {
  return env.DB.prepare("SELECT status, error, run_id, failed_at, data FROM agent_cache WHERE url = ?")
    .bind(url)
    .first<{ status: string; error: string | null; run_id: string | null; failed_at: string | null; data: string | null }>();
}

async function agentSpendRows(): Promise<{ amount_usd: number; ref: string }[]> {
  const { results } = await env.DB.prepare("SELECT amount_usd, ref FROM spend WHERE kind = 'agent_step'").all<{
    amount_usd: number;
    ref: string;
  }>();
  return results;
}

function minutesAgo(n: number): string {
  return new Date(Date.now() - n * 60 * 1000).toISOString();
}

function interceptFetchPages(): void {
  const pages: Record<string, { text: string; links?: string[] }> = {
    [CATALOGUE_URL]: { text: cat.text, links: cat.links },
    [HSR_URL]: { text: hsr.text, links: hsr.links },
  };
  fetchMock.intercept({
    url: FETCH_API,
    times: Infinity,
    reply: (_req, body) => {
      const urls = (body as { urls: string[] }).urls;
      const results: unknown[] = [];
      const errors: unknown[] = [];
      for (const url of urls) {
        const page = pages[url];
        if (!page) errors.push({ url, error: "not_recorded" });
        else results.push({ url, final_url: url, title: null, text: page.text, links: page.links ?? [] });
      }
      return Response.json({ results, errors });
    },
  });
}

function errorBody(r: any): any {
  expect(r.isError).toBe(true);
  expect(r.structuredContent).toBeUndefined();
  return JSON.parse(r.content[0].text);
}

beforeEach(async () => {
  fetchMock.activate();
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
afterEach(() => fetchMock.reset());

describe("get_faculty_profile", () => {
  it("first profile call starts one Agent run and answers reading", async () => {
    interceptRunAsync();
    const r = await callTool("get_faculty_profile", { profile_url: PROFILE_URL });
    expect(r.structuredContent).toMatchObject({ status: "reading", eta_seconds: 90 });
    expect(runAsyncCalls()).toHaveLength(1);
    expect(fetchMock.calls[0].body).toMatchObject({ browser_profile: "lite", agent_config: { max_steps: 12 } });
  });

  it("a second call while pending starts nothing", async () => {
    interceptRunAsync();
    await callTool("get_faculty_profile", { profile_url: PROFILE_URL });
    const r = await callTool("get_faculty_profile", { profile_url: PROFILE_URL });
    expect(r.structuredContent).toMatchObject({ status: "reading", eta_seconds: expect.any(Number) });
    expect(runAsyncCalls()).toHaveLength(1);
  });

  it("the Agent webhook finalizes the row, records spend, and the next call serves the cached profile", async () => {
    interceptRunAsync();
    await callTool("get_faculty_profile", { profile_url: PROFILE_URL });
    interceptGetRun("r1", { status: "COMPLETED", num_of_steps: 4, result: profileResult });
    const hook = await callWorker("/api/webhooks/agent/test-secret", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ run_id: "r1", status: "COMPLETED", num_of_steps: 4, result: profileResult }),
    });
    expect(hook.status).toBe(200);
    const r = await callTool("get_faculty_profile", { profile_url: PROFILE_URL });
    expect(r.structuredContent).toMatchObject({
      name: expect.any(String),
      method: "agent_cached",
      cached: true,
      stale: false,
    });
    expect((await spendByKind(env.DB)).agent_step).toBeCloseTo(0.064);
  });

  it("a pending row older than 5 minutes expires and frees the slot", async () => {
    const started = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    await env.DB.prepare(
      "INSERT INTO agent_cache (url, kind, status, started_at) VALUES (?, 'profile', 'pending', ?)",
    )
      .bind(OTHER_PROFILE_URL, started)
      .run();
    interceptRunAsync();
    const r = await callTool("get_faculty_profile", { profile_url: PROFILE_URL });
    expect(r.structuredContent).toMatchObject({ status: "reading" });
    expect(runAsyncCalls()).toHaveLength(1);
    const old = await env.DB.prepare("SELECT status, error FROM agent_cache WHERE url = ?")
      .bind(OTHER_PROFILE_URL)
      .first<{ status: string; error: string }>();
    expect(old).toMatchObject({ status: "failed", error: "timeout" });
  });

  it("the daily Agent cap answers RATE_LIMITED scope global", async () => {
    await bump(env.DB, "agent_reads", 10, utcDay(new Date()));
    const body = errorBody(await callTool("get_faculty_profile", { profile_url: PROFILE_URL }));
    expect(body).toMatchObject({ code: "RATE_LIMITED", scope: "global" });
    expect(runAsyncCalls()).toHaveLength(0);
  });

  it("spend at the pause answers BUDGET_PAUSED and Fetch tools still work", async () => {
    await recordSpend(env.DB, "agent_step", 3.0, "seed");
    interceptFetchPages();
    const body = errorBody(await callTool("get_faculty_profile", { profile_url: PROFILE_URL }));
    expect(body).toMatchObject({ code: "BUDGET_PAUSED" });
    expect(runAsyncCalls()).toHaveLength(0);
    const course = await callTool("get_course", { code: "HSR140" });
    expect(course.isError).toBeUndefined();
    expect(course.structuredContent).toMatchObject({ code: "HSR140", method: "fetch" });
  });

  it("get_faculty_profile on a non-UAEU url is INVALID_INPUT", async () => {
    const body = errorBody(await callTool("get_faculty_profile", { profile_url: "https://example.com/x" }));
    expect(body.code).toBe("INVALID_INPUT");
    expect(runAsyncCalls()).toHaveLength(0);
  });
});

describe("get_academic_calendar", () => {
  it("get_academic_calendar serves the weekly read with ISO dates and marks 15-day-old data stale", async () => {
    const items = (agentRunCalendar.result as { items: { date: string; title: string }[] }).items;
    const data = {
      academic_year: "2026-2027",
      semesters: [{ name: "Fall Semester", items }],
    };
    const readAt = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    await env.DB.prepare(
      "INSERT INTO agent_cache (url, kind, status, data, read_at) VALUES (?, 'calendar', 'ok', ?, ?)",
    )
      .bind(`${CALENDAR_URL}#2026-2027`, JSON.stringify(data), readAt)
      .run();
    const r = await callTool("get_academic_calendar", {});
    expect(r.structuredContent.semesters[0].items[0]).toMatchObject({
      date: "2026-08-17",
      title: "Add and drop begins",
    });
    expect(r.structuredContent.stale).toBe(true);
  });
});

describe("Agent webhook", () => {
  it("webhook with the wrong secret is 401 and an unknown run_id is 200 ignored", async () => {
    const bad = await callWorker("/api/webhooks/agent/wrong-secret", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ run_id: "r1", status: "COMPLETED", result: profileResult }),
    });
    expect(bad.status).toBe(401);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM agent_cache").first<{ n: number }>()).toMatchObject({
      n: 0,
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM spend").first<{ n: number }>()).toMatchObject({ n: 0 });

    const ignored = await callWorker("/api/webhooks/agent/test-secret", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ run_id: "nobody", status: "COMPLETED", num_of_steps: 4, result: profileResult }),
    });
    expect(ignored.status).toBe(200);
    expect(await ignored.json()).toEqual({ ignored: true });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM spend").first<{ n: number }>()).toMatchObject({ n: 0 });
  });
});

describe("a finished Agent run is booked once, usable or not", () => {
  it("a FAILED run books its steps, and the same page gets NOT_FOUND with retry_after_seconds and no new run", async () => {
    interceptRunAsync();
    await callTool("get_faculty_profile", { profile_url: PROFILE_URL });
    interceptGetRun("r1", { status: "FAILED", num_of_steps: 9, result: null, error: "page did not load" });
    expect((await postAgentHook({ run_id: "r1", status: "FAILED" })).status).toBe(200);

    const rows = await agentSpendRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ref).toBe("r1");
    expect(rows[0]!.amount_usd).toBeCloseTo(0.144);
    expect(await cacheRow(PROFILE_URL)).toMatchObject({ status: "failed", error: "page did not load" });

    const before = fetchMock.calls.length;
    const body = errorBody(await callTool("get_faculty_profile", { profile_url: PROFILE_URL }));
    expect(body.code).toBe("NOT_FOUND");
    expect(body.retry_after_seconds).toBeGreaterThan(6 * 3600 - 60);
    expect(body.retry_after_seconds).toBeLessThanOrEqual(6 * 3600);
    expect(fetchMock.calls.length).toBe(before);
    expect(runAsyncCalls()).toHaveLength(1);
  });

  it("a COMPLETED run whose result is not a profile books its steps and the row is failed", async () => {
    interceptRunAsync();
    await callTool("get_faculty_profile", { profile_url: PROFILE_URL });
    interceptGetRun("r1", { status: "COMPLETED", num_of_steps: 12, result: { name: "" } });
    await postAgentHook({ run_id: "r1", status: "COMPLETED" });

    expect((await spendByKind(env.DB)).agent_step).toBeCloseTo(0.192);
    const row = await cacheRow(PROFILE_URL);
    expect(row).toMatchObject({ status: "failed", data: null });
    expect(row!.failed_at).not.toBeNull();
    expect(errorBody(await callTool("get_faculty_profile", { profile_url: PROFILE_URL })).code).toBe("NOT_FOUND");
    expect(runAsyncCalls()).toHaveLength(1);
  });

  it("a CANCELLED run books its steps", async () => {
    interceptRunAsync();
    await callTool("get_faculty_profile", { profile_url: PROFILE_URL });
    interceptGetRun("r1", { status: "CANCELLED", num_of_steps: 3, result: null });
    await postAgentHook({ run_id: "r1", status: "CANCELLED" });
    expect((await spendByKind(env.DB)).agent_step).toBeCloseTo(0.048);
    expect(await cacheRow(PROFILE_URL)).toMatchObject({ status: "failed", error: "CANCELLED" });
  });

  it("a repeated callback books the run's steps once", async () => {
    interceptRunAsync();
    await callTool("get_faculty_profile", { profile_url: PROFILE_URL });
    interceptGetRun("r1", { status: "COMPLETED", num_of_steps: 4, result: profileResult }, 3);
    for (let i = 0; i < 3; i++) await postAgentHook({ run_id: "r1", status: "COMPLETED" });
    const rows = await agentSpendRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount_usd).toBeCloseTo(0.064);
    expect(await cacheRow(PROFILE_URL)).toMatchObject({ status: "ok", run_id: "r1" });
  });

  it("the step count comes from TinyFish, not the callback, and a missing count is booked at the 12-step cap", async () => {
    interceptRunAsync();
    await callTool("get_faculty_profile", { profile_url: PROFILE_URL });
    interceptGetRun("r1", { status: "COMPLETED", result: profileResult });
    await postAgentHook({ run_id: "r1", status: "COMPLETED", num_of_steps: 0, result: { name: "Not Example" } });
    expect((await spendByKind(env.DB)).agent_step).toBeCloseTo(0.192);
    const row = await cacheRow(PROFILE_URL);
    expect(row!.status).toBe("ok");
    expect(JSON.parse(row!.data!).name).toBe("Amal Example");
  });

  it("a failure more than 6 hours old lets the page be read again", async () => {
    await env.DB.prepare(
      "INSERT INTO agent_cache (url, kind, status, run_id, started_at, error, failed_at) VALUES (?, 'profile', 'failed', 'r0', ?, 'FAILED', ?)",
    )
      .bind(PROFILE_URL, minutesAgo(7 * 60 + 2), minutesAgo(7 * 60))
      .run();
    interceptRunAsync();
    const r = await callTool("get_faculty_profile", { profile_url: PROFILE_URL });
    expect(r.structuredContent).toMatchObject({ status: "reading" });
    expect(runAsyncCalls()).toHaveLength(1);
  });

  it("a start TinyFish refuses gives the day's count back and does not hold the page back", async () => {
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: { status: 500, json: { error: "down" } } });
    expect((await callTool("get_faculty_profile", { profile_url: PROFILE_URL })).isError).toBe(true);
    expect(await today(env.DB, "agent_reads", utcDay(new Date()))).toBe(0);
    expect(await cacheRow(PROFILE_URL)).toMatchObject({ status: "failed", error: "start_failed", failed_at: null });

    interceptRunAsync();
    const r = await callTool("get_faculty_profile", { profile_url: PROFILE_URL });
    expect(r.structuredContent).toMatchObject({ status: "reading" });
    expect(await today(env.DB, "agent_reads", utcDay(new Date()))).toBe(1);
  });

  it("a refused start says that nothing was read or charged and that asking again is safe", async () => {
    // TinyFish runs two Agent reads at once for the whole account; a third is refused.
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: { status: 429, json: { error: "too many runs" } } });
    const busy = errorBody(await callTool("get_faculty_profile", { profile_url: PROFILE_URL }));
    expect(busy).toMatchObject({ code: "RATE_LIMITED", scope: "global", retry_after_seconds: 60 });
    expect(busy.message).toContain("Nothing was read and nothing was charged");
    expect(busy.fix).toContain("again");

    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: { status: 500, json: { error: "down" } } });
    const down = errorBody(await callTool("get_faculty_profile", { profile_url: PROFILE_URL }));
    expect(down).toMatchObject({ code: "UPSTREAM_TIMEOUT", retry_after_seconds: 60 });
    expect(down.message).toContain("Nothing was read and nothing was charged");
  });
});

describe("a pending read past 5 minutes is read back before it expires", () => {
  it("a finished run whose callback never came is booked and served", async () => {
    await env.DB.prepare(
      "INSERT INTO agent_cache (url, kind, status, run_id, started_at) VALUES (?, 'profile', 'pending', 'r-lost', ?)",
    )
      .bind(PROFILE_URL, minutesAgo(6))
      .run();
    interceptGetRun("r-lost", { status: "COMPLETED", num_of_steps: 5, result: profileResult });
    const r = await callTool("get_faculty_profile", { profile_url: PROFILE_URL });
    expect(r.structuredContent).toMatchObject({ name: "Amal Example", method: "agent_cached" });
    expect(runAsyncCalls()).toHaveLength(0);
    const rows = await agentSpendRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount_usd).toBeCloseTo(0.08);
  });

  it("a failed run found at expiry is booked and frees the slot", async () => {
    await env.DB.prepare(
      "INSERT INTO agent_cache (url, kind, status, run_id, started_at) VALUES (?, 'profile', 'pending', 'r-lost', ?)",
    )
      .bind(OTHER_PROFILE_URL, minutesAgo(6))
      .run();
    interceptGetRun("r-lost", { status: "FAILED", num_of_steps: 12, result: null, error: "step limit" });
    interceptRunAsync();
    const r = await callTool("get_faculty_profile", { profile_url: PROFILE_URL });
    expect(r.structuredContent).toMatchObject({ status: "reading" });
    expect((await spendByKind(env.DB)).agent_step).toBeCloseTo(0.192);
    expect(await cacheRow(OTHER_PROFILE_URL)).toMatchObject({ status: "failed", error: "step limit" });
  });

  it("a run TinyFish still reports as running keeps the slot, and fails as timeout only after 30 minutes", async () => {
    await env.DB.prepare(
      "INSERT INTO agent_cache (url, kind, status, run_id, started_at) VALUES (?, 'profile', 'pending', 'r-slow', ?)",
    )
      .bind(OTHER_PROFILE_URL, minutesAgo(6))
      .run();
    interceptGetRun("r-slow", { status: "RUNNING" }, 2);
    const held = errorBody(await callTool("get_faculty_profile", { profile_url: PROFILE_URL }));
    expect(held).toMatchObject({ code: "RATE_LIMITED", scope: "global" });
    expect(runAsyncCalls()).toHaveLength(0);
    expect(await cacheRow(OTHER_PROFILE_URL)).toMatchObject({ status: "pending" });

    await env.DB.prepare("UPDATE agent_cache SET started_at = ? WHERE url = ?")
      .bind(minutesAgo(31), OTHER_PROFILE_URL)
      .run();
    interceptRunAsync();
    const r = await callTool("get_faculty_profile", { profile_url: PROFILE_URL });
    expect(r.structuredContent).toMatchObject({ status: "reading" });
    expect(await cacheRow(OTHER_PROFILE_URL)).toMatchObject({ status: "failed", error: "timeout" });
    expect(await agentSpendRows()).toHaveLength(0);
  });
});

describe("only COMPLETED, FAILED and CANCELLED settle a run", () => {
  it("a callback with a status Falaj does not know leaves the row pending and the slot held", async () => {
    interceptRunAsync();
    await callTool("get_faculty_profile", { profile_url: PROFILE_URL });
    for (const status of ["RUNNING", "PENDING", "paused", "SOMETHING_NEW"]) {
      const res = await postAgentHook({ run_id: "r1", status });
      expect(res.status).toBe(200);
    }
    expect(getRunCalls()).toHaveLength(0);
    expect(await cacheRow(PROFILE_URL)).toMatchObject({ status: "pending", run_id: "r1" });
    expect(await agentSpendRows()).toHaveLength(0);

    const other = errorBody(await callTool("get_faculty_profile", { profile_url: OTHER_PROFILE_URL }));
    expect(other).toMatchObject({ code: "RATE_LIMITED", scope: "global" });
    expect(runAsyncCalls()).toHaveLength(1);
  });

  it("a callback with no status settles nothing while TinyFish says the run is still running", async () => {
    interceptRunAsync();
    await callTool("get_faculty_profile", { profile_url: PROFILE_URL });
    interceptGetRun("r1", { status: "RUNNING" });
    const res = await postAgentHook({ run_id: "r1" });
    expect(await res.json()).toEqual({ ok: true, deferred: true });
    expect(await cacheRow(PROFILE_URL)).toMatchObject({ status: "pending" });
  });

  it("a callback whose run TinyFish cannot report leaves the row pending", async () => {
    interceptRunAsync();
    await callTool("get_faculty_profile", { profile_url: PROFILE_URL });
    fetchMock.intercept({
      method: "GET",
      url: `${RUNS_API}/r1?screenshots=none&html=none`,
      reply: { status: 500, json: { error: "down" } },
    });
    const res = await postAgentHook({ run_id: "r1", status: "COMPLETED", num_of_steps: 4, result: profileResult });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deferred: true });
    expect(await cacheRow(PROFILE_URL)).toMatchObject({ status: "pending", data: null });
    expect(await agentSpendRows()).toHaveLength(0);
  });

  it("a lower-case status and a payload nested under data or run settle the run", async () => {
    interceptRunAsync();
    await callTool("get_faculty_profile", { profile_url: PROFILE_URL });
    interceptGetRun("r1", { status: "completed", num_of_steps: 4, result: profileResult });
    const res = await postAgentHook({ event: "run.finished", data: { run_id: "r1", status: "completed" } });
    expect(await res.json()).toEqual({ ok: true });
    expect(await cacheRow(PROFILE_URL)).toMatchObject({ status: "ok", run_id: "r1" });

    await env.DB.prepare(
      "INSERT INTO agent_cache (url, kind, status, run_id, started_at) VALUES (?, 'profile', 'pending', 'r2', ?)",
    )
      .bind(OTHER_PROFILE_URL, minutesAgo(1))
      .run();
    interceptGetRun("r2", {
      status: "COMPLETED",
      num_of_steps: 2,
      result: { ...profileResult, name: "Badr Example", email: "b.example@uaeu.ac.ae" },
    });
    await postAgentHook({ run: { id: "r2", status: "Completed" } });
    expect(await cacheRow(OTHER_PROFILE_URL)).toMatchObject({ status: "ok", run_id: "r2" });
    expect((await spendByKind(env.DB)).agent_step).toBeCloseTo(0.096);
  });
});

describe("a started run is never lost", () => {
  it("a run whose id cannot be stored stays pending, starts no second run, and is settled by its callback", async () => {
    await env.DB.prepare(
      `CREATE TRIGGER refuse_run_id BEFORE UPDATE OF run_id ON agent_cache
       WHEN NEW.run_id IS NOT NULL AND OLD.run_id IS NULL
       BEGIN SELECT RAISE(ABORT, 'write refused'); END`,
    ).run();
    interceptRunAsync();
    const first = await callTool("get_faculty_profile", { profile_url: PROFILE_URL });
    expect(first.structuredContent).toMatchObject({ status: "reading" });
    expect(await cacheRow(PROFILE_URL)).toMatchObject({ status: "pending", run_id: null });
    expect(await today(env.DB, "agent_reads", utcDay(new Date()))).toBe(1);

    const again = await callTool("get_faculty_profile", { profile_url: PROFILE_URL });
    expect(again.structuredContent).toMatchObject({ status: "reading" });
    const other = errorBody(await callTool("get_faculty_profile", { profile_url: OTHER_PROFILE_URL }));
    expect(other).toMatchObject({ code: "RATE_LIMITED", scope: "global" });
    expect(runAsyncCalls()).toHaveLength(1);
    await env.DB.prepare("DROP TRIGGER refuse_run_id").run();

    // A callback for an id no row holds is not attached while the start may still be in progress.
    const early = await postAgentHook({ run_id: "r1", status: "COMPLETED" });
    expect(await early.json()).toEqual({ ignored: true });
    expect(await cacheRow(PROFILE_URL)).toMatchObject({ status: "pending", run_id: null });

    await env.DB.prepare("UPDATE agent_cache SET started_at = ? WHERE url = ?")
      .bind(minutesAgo(1), PROFILE_URL)
      .run();
    interceptGetRun("r1", { status: "COMPLETED", num_of_steps: 4, result: profileResult });
    const hook = await postAgentHook({ run_id: "r1", status: "COMPLETED" });
    expect(await hook.json()).toEqual({ ok: true });
    expect(await cacheRow(PROFILE_URL)).toMatchObject({ status: "ok", run_id: "r1" });
    const rows = await agentSpendRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount_usd).toBeCloseTo(0.064);
  });
});

describe("a page has one cache key however it is written", () => {
  it("spellings of one profile page share one cache row and one run", async () => {
    interceptRunAsync();
    const spellings = [
      `${PROFILE_URL}&x=1`,
      `${PROFILE_URL}&x=2#a`,
      "https://WWW.UAEU.AC.AE/en/CMHS/profile.shtml?utm=1&email=A.Example%40UAEU.ac.ae",
      PROFILE_URL,
    ];
    for (const profile_url of spellings) {
      const r = await callTool("get_faculty_profile", { profile_url });
      expect(r.structuredContent).toMatchObject({ status: "reading" });
    }
    expect(runAsyncCalls()).toHaveLength(1);
    expect((runAsyncCalls()[0]!.body as { url: string }).url).toBe(PROFILE_URL);
    const { results } = await env.DB.prepare("SELECT url FROM agent_cache").all<{ url: string }>();
    expect(results.map((r) => r.url)).toEqual([PROFILE_URL]);
  });

  it("a cached profile is served under its canonical address for any spelling", async () => {
    await env.DB.prepare(
      "INSERT INTO agent_cache (url, kind, status, data, read_at) VALUES (?, 'profile', 'ok', ?, ?)",
    )
      .bind(PROFILE_URL, JSON.stringify(profileResult), new Date().toISOString())
      .run();
    const r = await callTool("get_faculty_profile", { profile_url: `${PROFILE_URL}&tab=2#top` });
    expect(r.structuredContent).toMatchObject({
      name: "Amal Example",
      profile_url: PROFILE_URL,
      source_url: PROFILE_URL,
    });
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("an address that is not a college profile page is INVALID_INPUT before any paid call", async () => {
    const refused = [
      "https://www.uaeu.ac.ae/en/news/item.shtml?next=/profile.shtml?email=a.example@uaeu.ac.ae",
      "https://www.uaeu.ac.ae/en/zzz/profile.shtml?email=a.example@uaeu.ac.ae",
      "https://www.uaeu.ac.ae/en/cmhs/extra/profile.shtml?email=a.example@uaeu.ac.ae",
      `${PROFILE_URL}&email=b.example@uaeu.ac.ae`,
      "https://www.uaeu.ac.ae/en/cmhs/profile.shtml?email=a.example@example.com",
      "https://www.uaeu.ac.ae/en/cmhs/profile.shtml?email=",
      "https://www.uaeu.ac.ae/en/cmhs/profile.shtml?email=a%20example@uaeu.ac.ae",
      "https://www.uaeu.ac.ae:8443/en/cmhs/profile.shtml?email=a.example@uaeu.ac.ae",
      "http://www.uaeu.ac.ae/en/cmhs/profile.shtml?email=a.example@uaeu.ac.ae",
    ];
    for (const profile_url of refused) {
      const body = errorBody(await callTool("get_faculty_profile", { profile_url }));
      expect(body.code, profile_url).toBe("INVALID_INPUT");
    }
    expect(fetchMock.calls).toHaveLength(0);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM agent_cache").first<{ n: number }>();
    expect(rows!.n).toBe(0);
  });

  it("an academic year that is not the previous, current or next tab is INVALID_INPUT before any paid call", async () => {
    const current = currentAcademicYear(new Date());
    const start = Number(current.slice(0, 4));
    for (const academic_year of ["2098-2099", `${start + 2}-${start + 3}`, `${start - 2}-${start - 1}`]) {
      const body = errorBody(await callTool("get_academic_calendar", { academic_year }));
      expect(body.code, academic_year).toBe("INVALID_INPUT");
      expect(body.message).toContain(current);
    }
    expect(fetchMock.calls).toHaveLength(0);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM agent_cache").first<{ n: number }>();
    expect(rows!.n).toBe(0);
  });

  it("an academic year written with spaces is read under the same key as without", async () => {
    interceptRunAsync();
    const current = currentAcademicYear(new Date());
    const spaced = `  ${current.slice(0, 4)} - ${current.slice(5)} `;
    for (const academic_year of [spaced, current]) {
      const r = await callTool("get_academic_calendar", { academic_year });
      expect(r.structuredContent).toMatchObject({ status: "reading" });
    }
    expect(runAsyncCalls()).toHaveLength(1);
    const { results } = await env.DB.prepare("SELECT url FROM agent_cache").all<{ url: string }>();
    expect(results.map((r) => r.url)).toEqual([`${CALENDAR_URL}#${current}`]);
  });
});
