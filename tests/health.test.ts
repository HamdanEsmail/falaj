import { applyD1Migrations, createExecutionContext, reset, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CANARY_SLOW_MS } from "../src/core/limits";
import { recordSpend } from "../src/core/spend";
import { slugToName } from "../src/core/text";
import { setToolStatus } from "../src/db/toolStatus";
import { canaryClock, runCanaries } from "../src/health/run";
import worker from "../src/index";
import { CATALOGUE_URL } from "../src/catalogue/read";
import { fetchMock } from "./helpers/fetch-mock";
import { callTool } from "./helpers/mcp";
import catalogueFixture from "./fixtures/uaeu/catalogue-index.json";
import hsrFixture from "./fixtures/uaeu/course-hsr140.json";
import eventsFixture from "./fixtures/uaeu/events.json";
import mdsFixture from "./fixtures/uaeu/program-mds.json";
import programsIndexFixture from "./fixtures/uaeu/programs-index.json";
import refundsFixture from "./fixtures/uaeu/refunds.json";
import searchFaculty from "./fixtures/tinyfish/search-faculty.json";
import agentRunCalendar from "./fixtures/tinyfish/agent-run-calendar.json";

const FETCH_API = "https://api.fetch.tinyfish.ai";
const SEARCH_API = /^https:\/\/api\.search\.tinyfish\.ai\/\?/;
const RUN_ASYNC_API = "https://agent.tinyfish.ai/v1/automation/run-async";
const HSR_URL = "https://www.uaeu.ac.ae/en/catalog/courses/course_2924.shtml?id=HSR140";
const INDEX_URL = "https://www.uaeu.ac.ae/en/catalog/undergraduate/programs/";
const MDS_URL = `${INDEX_URL}bachelor-of-science-in-the-mathematics-of-data-science.shtml`;
const EVENTS_URL = "https://www.uaeu.ac.ae/en/events/";
const REFUNDS_URL = "https://www.uaeu.ac.ae/en/dvcsae/student_account_office/refunds.shtml";
const CALENDAR_URL = "https://www.uaeu.ac.ae/en/calendar/";
const PROFILE_URL = "https://www.uaeu.ac.ae/en/cmhs/profile.shtml?email=a.example@uaeu.ac.ae";

const cat = catalogueFixture.results[0]!;
const hsr = hsrFixture.results[0]!;
const idx = programsIndexFixture.results[0]!;
const mds = mdsFixture.results[0]!;
const events = eventsFixture.results[0]!;
const refunds = refundsFixture.results[0]!;

const profileData = {
  name: "Amal Example",
  title: "Assistant Professor",
  college: "College of Medicine and Health Sciences",
  department: "Public Health",
  email: "a.example@uaeu.ac.ae",
  research_interests: ["epidemiology"],
  education: ["PhD in Public Health"],
};

const calendarData = {
  academic_year: "2026-2027",
  semesters: [
    {
      name: "Fall Semester",
      items: (agentRunCalendar.result as { items: { date: string; title: string }[] }).items,
    },
  ],
};

type Page = { text: string; links?: string[] };

function stubProgram(url: string): string {
  const slug = url.split("/").pop()?.replace(/\.shtml$/, "") ?? "programme";
  return `## ${slugToName(slug)}\n\nHosted by the Department of Mathematical Sciences, COS.\n`;
}

function registerCanaryFixtures(pages: Record<string, Page>): void {
  fetchMock.intercept({
    url: FETCH_API,
    times: Infinity,
    reply: (_req, body) => {
      const urls = (body as { urls: string[] }).urls;
      const results: unknown[] = [];
      const errors: unknown[] = [];
      for (const url of urls) {
        const page = pages[url];
        if (page) results.push({ url, final_url: url, title: null, text: page.text, links: page.links ?? [] });
        else if (/\/en\/catalog\/undergraduate\/programs\/[^/]+\.shtml$/.test(url)) {
          results.push({ url, final_url: url, title: null, text: stubProgram(url), links: [] });
        } else errors.push({ url, error: "not_recorded" });
      }
      return Response.json({ results, errors });
    },
  });
  fetchMock.intercept({
    url: SEARCH_API,
    times: Infinity,
    reply: { json: searchFaculty },
  });
}

function defaultPages(): Record<string, Page> {
  return {
    [CATALOGUE_URL]: { text: cat.text, links: cat.links },
    [HSR_URL]: { text: hsr.text, links: hsr.links },
    [INDEX_URL]: { text: idx.text, links: idx.links },
    [MDS_URL]: { text: mds.text, links: mds.links },
    [EVENTS_URL]: { text: events.text, links: events.links },
    [REFUNDS_URL]: { text: refunds.text, links: refunds.links },
  };
}

async function seedAgentCache(): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO agent_cache (url, kind, status, data, read_at) VALUES (?, 'calendar', 'ok', ?, ?)",
  )
    .bind(`${CALENDAR_URL}#2026-2027`, JSON.stringify(calendarData), now)
    .run();
  await env.DB.prepare(
    "INSERT INTO agent_cache (url, kind, status, data, read_at) VALUES (?, 'profile', 'ok', ?, ?)",
  )
    .bind(PROFILE_URL, JSON.stringify(profileData), now)
    .run();
}

async function toolStatuses(): Promise<Record<string, { status: string; detail: string | null }>> {
  const { results } = await env.DB.prepare("SELECT tool, status, detail FROM tool_status").all<{
    tool: string;
    status: string;
    detail: string | null;
  }>();
  const out: Record<string, { status: string; detail: string | null }> = {};
  for (const r of results) out[r.tool] = { status: r.status, detail: r.detail };
  return out;
}

async function runNightly(): Promise<void> {
  const ctx = createExecutionContext();
  await runCanaries(env, ctx, "nightly");
  await waitOnExecutionContext(ctx);
}

beforeEach(async () => {
  fetchMock.activate();
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  canaryClock.now = () => Date.now();
});
afterEach(() => {
  fetchMock.reset();
  canaryClock.now = () => Date.now();
});

describe("canaries", () => {
  it("runCanaries sets ok for passing tools and records a canary run", async () => {
    registerCanaryFixtures(defaultPages());
    await seedAgentCache();
    await runNightly();
    const statuses = await toolStatuses();
    expect(statuses.get_course?.status).toBe("ok");
    expect(statuses.search_courses?.status).toBe("ok");
    expect(statuses.list_programs?.status).toBe("ok");
    expect(statuses.get_program?.status).toBe("ok");
    expect(statuses.list_events?.status).toBe("ok");
    expect(statuses.academic_deadlines?.status).toBe("ok");
    expect(statuses.find_faculty?.status).toBe("ok");
    expect(statuses.get_academic_calendar?.status).toBe("ok");
    expect(statuses.get_faculty_profile?.status).toBe("ok");
    const run = await env.DB.prepare("SELECT trigger, results FROM canary_runs").first<{
      trigger: string;
      results: string;
    }>();
    expect(run?.trigger).toBe("nightly");
    expect(JSON.parse(run!.results).length).toBeGreaterThanOrEqual(9);
  });

  it("a canary whose check fails marks the tool broken with the detail", async () => {
    const pages = defaultPages();
    pages[CATALOGUE_URL] = {
      text: cat.text.replace(/\+ HSR140 :[^\n]*/, ""),
      links: cat.links.filter((l) => !String(l).includes("HSR140")),
    };
    registerCanaryFixtures(pages);
    await seedAgentCache();
    await runNightly();
    const row = await env.DB.prepare("SELECT status, detail FROM tool_status WHERE tool = 'get_course'").first<{
      status: string;
      detail: string;
    }>();
    expect(row?.status).toBe("broken");
    expect(row?.detail).toMatch(/HSR140/);
  });

  it("a broken tool returns SITE_CHANGED with the page url and makes no TinyFish call", async () => {
    await setToolStatus(env.DB, "get_course", "broken", "credit hours missing", new Date());
    const r = await callTool("get_course", { code: "HSR140" });
    expect(JSON.parse(r.content[0].text)).toMatchObject({
      code: "SITE_CHANGED",
      source_url: expect.stringContaining("uaeu.ac.ae"),
    });
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("a canary blocked by BUDGET_PAUSED leaves the previous status and records why", async () => {
    registerCanaryFixtures(defaultPages());
    await setToolStatus(env.DB, "get_academic_calendar", "ok", "cached calendar", new Date("2026-11-01T00:00:00Z"));
    await recordSpend(env.DB, "agent_step", 3.0, "seed");
    const ctx = createExecutionContext();
    await runCanaries(env, ctx, "manual");
    const row = await env.DB.prepare(
      "SELECT status, detail FROM tool_status WHERE tool = 'get_academic_calendar'",
    ).first<{ status: string; detail: string | null }>();
    expect(row?.status).toBe("ok");
    const run = await env.DB.prepare("SELECT results FROM canary_runs").first<{ results: string }>();
    expect(run?.results).toMatch(/BUDGET_PAUSED/);
  });

  it("a slow canary is degraded", async () => {
    registerCanaryFixtures(defaultPages());
    await seedAgentCache();
    let n = 0;
    canaryClock.now = () => {
      n += 1;
      return n === 1 ? 0 : n === 2 ? CANARY_SLOW_MS + 25 : 1_000_000 + n;
    };
    await runNightly();
    const row = await env.DB.prepare("SELECT status FROM tool_status WHERE tool = 'get_course'").first<{
      status: string;
    }>();
    expect(row?.status).toBe("degraded");
  });
});

describe("health_check and cron", () => {
  it("health_check reports every tool, monitors and spend", async () => {
    await setToolStatus(env.DB, "get_course", "ok", "ok", new Date());
    await env.DB.prepare(
      "INSERT INTO monitors (page, monitor_id, url, last_check_at, last_outcome, site_changed_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind("catalogue", "mon-cat", CATALOGUE_URL, "2026-11-09T00:00:00Z", "unchanged", null)
      .run();
    await recordSpend(env.DB, "monitor_check", 0.005, "chk-1");
    const r = await callTool("health_check", {});
    const body = r.structuredContent;
    expect(Object.keys(body.tools).sort()).toEqual(
      [
        "academic_deadlines",
        "find_faculty",
        "get_academic_calendar",
        "get_course",
        "get_faculty_profile",
        "get_program",
        "health_check",
        "list_events",
        "list_programs",
        "search_courses",
      ].sort(),
    );
    expect(body.tools.get_course.status).toBe("ok");
    expect(body.monitors).toEqual([
      { page: "catalogue", last_check_at: "2026-11-09T00:00:00Z", last_outcome: "unchanged" },
    ]);
    expect(body.spend).toMatchObject({ used_usd: 0.005, share_usd: 3.5, paused: false });
    expect(body.site_changed_at).toBeNull();
    expect(body).toMatchObject({
      source_url: "https://falaj.test/api/health",
      method: "status",
      cached: false,
    });
  });

  it("the nightly cron runs the canaries; the Sunday cron starts the calendar read", async () => {
    registerCanaryFixtures(defaultPages());
    await seedAgentCache();
    fetchMock.intercept({
      method: "POST",
      url: RUN_ASYNC_API,
      times: Infinity,
      reply: { json: { run_id: "cron-cal-1" } },
    });
    const ctx1 = createExecutionContext();
    await worker.scheduled({ cron: "0 22 * * *", scheduledTime: Date.now(), noRetry() {} }, env, ctx1);
    await waitOnExecutionContext(ctx1);
    expect((await env.DB.prepare("SELECT trigger FROM canary_runs").first<{ trigger: string }>())?.trigger).toBe(
      "nightly",
    );
    const before = fetchMock.calls.filter((c) => c.url.includes("run-async")).length;
    const ctx2 = createExecutionContext();
    // Cloudflare counts Sunday as 1, not 0, and refuses "0 21 * * 0"; the trigger is written with the day's name.
    await worker.scheduled({ cron: "0 21 * * SUN", scheduledTime: Date.now(), noRetry() {} }, env, ctx2);
    await waitOnExecutionContext(ctx2);
    expect(fetchMock.calls.filter((c) => c.url.includes("run-async")).length).toBeGreaterThan(before);
  });
});
