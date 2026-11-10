import { applyD1Migrations, createExecutionContext, reset, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CATALOGUE_URL, PROGRAM_INDEX_URL } from "../src/catalogue/read";
import { slugToName } from "../src/core/text";
import worker from "../src/index";
import { callWorker } from "./helpers/app";
import { fetchMock } from "./helpers/fetch-mock";
import catalogueFixture from "./fixtures/uaeu/catalogue-index.json";
import hsrFixture from "./fixtures/uaeu/course-hsr140.json";
import eventsFixture from "./fixtures/uaeu/events.json";
import mdsFixture from "./fixtures/uaeu/program-mds.json";
import programsIndexFixture from "./fixtures/uaeu/programs-index.json";
import refundsFixture from "./fixtures/uaeu/refunds.json";
import searchFaculty from "./fixtures/tinyfish/search-faculty.json";
import agentRunCalendar from "./fixtures/tinyfish/agent-run-calendar.json";
import changedPayload from "./fixtures/webhooks/changed.json";
import unchangedPayload from "./fixtures/webhooks/unchanged.json";

const FETCH_API = "https://api.fetch.tinyfish.ai";
const SEARCH_API = /^https:\/\/api\.search\.tinyfish\.ai\/\?/;
const MONITORS_API = "https://agent.tinyfish.ai/v1/monitors";
const HSR_URL = "https://www.uaeu.ac.ae/en/catalog/courses/course_2924.shtml?id=HSR140";
const MDS_URL = `${PROGRAM_INDEX_URL}bachelor-of-science-in-the-mathematics-of-data-science.shtml`;
const EVENTS_URL = "https://www.uaeu.ac.ae/en/events/";
const REFUNDS_URL = "https://www.uaeu.ac.ae/en/dvcsae/student_account_office/refunds.shtml";
const CALENDAR_URL = "https://www.uaeu.ac.ae/en/calendar/";
const PROFILE_URL = "https://www.uaeu.ac.ae/en/cmhs/profile.shtml?email=a.example@uaeu.ac.ae";
const CAT_MONITOR = changedPayload.fetch_monitor_id;

const cat = catalogueFixture.results[0]!;
const hsr = hsrFixture.results[0]!;
const idx = programsIndexFixture.results[0]!;
const mds = mdsFixture.results[0]!;
const events = eventsFixture.results[0]!;
const refunds = refundsFixture.results[0]!;

const ADMIN = { Authorization: "Bearer test-admin", "content-type": "application/json" };

function stubProgram(url: string): string {
  const slug = url.split("/").pop()?.replace(/\.shtml$/, "") ?? "programme";
  return `## ${slugToName(slug)}\n\nHosted by the Department of Mathematical Sciences, COS.\n`;
}

function registerCanaryFixtures(): void {
  const pages: Record<string, { text: string; links?: string[] }> = {
    [CATALOGUE_URL]: { text: cat.text, links: cat.links },
    [HSR_URL]: { text: hsr.text, links: hsr.links },
    [PROGRAM_INDEX_URL]: { text: idx.text, links: idx.links },
    [MDS_URL]: { text: mds.text, links: mds.links },
    [EVENTS_URL]: { text: events.text, links: events.links },
    [REFUNDS_URL]: { text: refunds.text, links: refunds.links },
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
        if (page) results.push({ url, final_url: url, title: null, text: page.text, links: page.links ?? [] });
        else if (/\/en\/catalog\/undergraduate\/programs\/[^/]+\.shtml$/.test(url)) {
          results.push({ url, final_url: url, title: null, text: stubProgram(url), links: [] });
        } else errors.push({ url, error: "not_recorded" });
      }
      return Response.json({ results, errors });
    },
  });
  fetchMock.intercept({ url: SEARCH_API, times: Infinity, reply: { json: searchFaculty } });
}

async function seedCatalogueMonitor(): Promise<void> {
  await env.DB.prepare("INSERT INTO monitors (page, monitor_id, url) VALUES (?, ?, ?)").bind(
    "catalogue",
    CAT_MONITOR,
    CATALOGUE_URL,
  ).run();
}

async function seedAgentCache(): Promise<void> {
  const now = new Date().toISOString();
  const calendarData = {
    academic_year: "2026-2027",
    semesters: [
      { name: "Fall Semester", items: (agentRunCalendar.result as { items: { date: string; title: string }[] }).items },
    ],
  };
  await env.DB.prepare(
    "INSERT INTO agent_cache (url, kind, status, data, read_at) VALUES (?, 'calendar', 'ok', ?, ?)",
  )
    .bind(`${CALENDAR_URL}#2026-2027`, JSON.stringify(calendarData), now)
    .run();
  await env.DB.prepare(
    "INSERT INTO agent_cache (url, kind, status, data, read_at) VALUES (?, 'profile', 'ok', ?, ?)",
  )
    .bind(
      PROFILE_URL,
      JSON.stringify({
        name: "Amal Example",
        title: "Assistant Professor",
        college: "College of Medicine and Health Sciences",
        department: "Public Health",
        email: "a.example@uaeu.ac.ae",
        research_interests: ["epidemiology"],
        education: ["PhD in Public Health"],
      }),
      now,
    )
    .run();
}

async function postMonitor(secret: string, body: unknown): Promise<Response> {
  return callWorker(`/api/webhooks/monitor/${secret}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  fetchMock.activate();
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
afterEach(() => fetchMock.reset());

describe("Monitor webhook", () => {
  it("wrong secret is 401 and writes nothing", async () => {
    await seedCatalogueMonitor();
    const res = await postMonitor("wrong-secret", changedPayload);
    expect(res.status).toBe(401);
    expect(await env.DB.prepare("SELECT last_outcome, site_changed_at FROM monitors WHERE page = 'catalogue'").first()).toMatchObject({
      last_outcome: null,
      site_changed_at: null,
    });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM spend").first<{ n: number }>())?.n).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM canary_runs").first<{ n: number }>())?.n).toBe(0);
  });

  it("a changed payload for an unknown monitor id is 200 ignored", async () => {
    await seedCatalogueMonitor();
    const res = await postMonitor("test-secret", { ...changedPayload, fetch_monitor_id: "not-ours" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ignored: true });
    expect(await env.DB.prepare("SELECT last_outcome, site_changed_at FROM monitors WHERE page = 'catalogue'").first()).toMatchObject({
      last_outcome: null,
      site_changed_at: null,
    });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM spend").first<{ n: number }>())?.n).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM canary_runs").first<{ n: number }>())?.n).toBe(0);
  });

  const due = async () =>
    (await env.DB.prepare("SELECT canaries_due_at FROM monitors WHERE page='catalogue'").first<{ canaries_due_at: string | null }>())?.canaries_due_at ?? null;
  const canaryRuns = async () => (await env.DB.prepare("SELECT trigger FROM canary_runs ORDER BY at").all<{ trigger: string }>()).results.map((r) => r.trigger);
  const quarterHour = async () => {
    const ctx = createExecutionContext();
    await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: Date.now(), noRetry() {} }, env, ctx);
    await waitOnExecutionContext(ctx);
  };

  it("a changed payload sets site_changed_at and marks the health pass due; the request itself reads no page", async () => {
    await seedCatalogueMonitor();
    await seedAgentCache();
    registerCanaryFixtures();
    const res = await postMonitor("test-secret", changedPayload);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ changed: true, canaries: "due" });
    expect(
      (await env.DB.prepare("SELECT site_changed_at FROM monitors WHERE page='catalogue'").first<{ site_changed_at: string | null }>())
        ?.site_changed_at,
    ).not.toBeNull();
    expect(await due()).not.toBeNull();
    // The pass takes longer than a webhook's answer may run on, so nothing of it starts here.
    expect(await canaryRuns()).toEqual([]);
    expect(fetchMock.calls.filter((c) => c.url.startsWith(FETCH_API))).toHaveLength(0);
  });

  it("the quarter-hour job runs the health pass that is due, once, and clears the mark", async () => {
    await seedCatalogueMonitor();
    await seedAgentCache();
    registerCanaryFixtures();
    await postMonitor("test-secret", changedPayload);
    await quarterHour();
    expect(await canaryRuns()).toEqual(["monitor"]);
    expect(await due()).toBeNull();
    const reads = fetchMock.calls.length;
    await quarterHour();
    expect(await canaryRuns()).toEqual(["monitor"]);
    expect(fetchMock.calls.length).toBe(reads);
  });

  it("the quarter-hour job does nothing when no change is waiting", async () => {
    await seedCatalogueMonitor();
    registerCanaryFixtures();
    await quarterHour();
    expect(await canaryRuns()).toEqual([]);
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("a change that arrives while the pass runs stays due for the next one", async () => {
    await seedCatalogueMonitor();
    await seedAgentCache();
    registerCanaryFixtures();
    await postMonitor("test-secret", changedPayload);
    // A second change, marked later than the pass will start.
    const later = new Date(Date.now() + 60_000).toISOString();
    await env.DB.prepare("INSERT INTO monitors (page, monitor_id, url, canaries_due_at) VALUES ('programs', 'mon-programs', ?, ?)").bind(PROGRAM_INDEX_URL, later).run();
    await quarterHour();
    expect(await due()).toBeNull();
    expect((await env.DB.prepare("SELECT canaries_due_at FROM monitors WHERE page='programs'").first<{ canaries_due_at: string | null }>())?.canaries_due_at).toBe(later);
  });

  it("an unchanged payload records the check and spend and runs nothing", async () => {
    await seedCatalogueMonitor();
    const res = await postMonitor("test-secret", unchangedPayload);
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT last_outcome, site_changed_at FROM monitors WHERE page = 'catalogue'").first<{
      last_outcome: string;
      site_changed_at: string | null;
    }>();
    expect(row).toMatchObject({ last_outcome: "unchanged", site_changed_at: null });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM spend WHERE kind = 'monitor_check'").first<{ n: number }>())?.n).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM canary_runs").first<{ n: number }>())?.n).toBe(0);
  });

  it("the same payload id twice records one check", async () => {
    await seedCatalogueMonitor();
    const first = await postMonitor("test-secret", unchangedPayload);
    const second = await postMonitor("test-secret", unchangedPayload);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ duplicate: true });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM spend WHERE kind = 'monitor_check'").first<{ n: number }>())?.n).toBe(1);
  });
});

describe("monitors-init", () => {
  it("monitors-init creates two monitors and refuses a third run", async () => {
    let created = 0;
    fetchMock.intercept({
      method: "POST",
      url: MONITORS_API,
      times: Infinity,
      reply: () => {
        created += 1;
        return Response.json(
          {
            monitor: { id: `mon-${created}` },
            run: { id: `run-${created}`, results: [{ text: "# Courses\n\nCatalogue." }], errors: [] },
          },
          { status: 201 },
        );
      },
    });
    const first = await callWorker("/api/admin/monitors-init", { method: "POST", headers: ADMIN });
    expect(first.status).toBe(200);
    const body = (await first.json()) as { monitors: { page: string; monitor_id: string }[] };
    expect(body.monitors).toHaveLength(2);
    expect(created).toBe(2);
    const rows = (
      await env.DB.prepare("SELECT page, monitor_id FROM monitors ORDER BY page").all<{ page: string; monitor_id: string }>()
    ).results;
    expect(rows.map((r) => r.page).sort()).toEqual(["catalogue", "programs"]);
    expect(rows.every((r) => typeof r.monitor_id === "string" && r.monitor_id.startsWith("mon-"))).toBe(true);

    const second = await callWorker("/api/admin/monitors-init", { method: "POST", headers: ADMIN });
    expect(await second.json()).toEqual({ error: "monitors already exist" });
    expect(created).toBe(2);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM monitors").first<{ n: number }>())?.n).toBe(2);
  });

  it("after one page's Monitor could not be made, a second run makes only that one and orphans nothing", async () => {
    let n = 0;
    fetchMock.intercept({
      method: "POST",
      url: MONITORS_API,
      times: Infinity,
      reply: () => {
        n += 1;
        if (n === 2) return new Response("boom", { status: 500 });
        return Response.json({ monitor: { id: `m-${n}` }, run: { id: `b-${n}`, results: [{ text: "# Courses" }], errors: [] } }, { status: 201 });
      },
    });
    const pagesAsked = () =>
      fetchMock.calls
        .filter((c) => c.url === MONITORS_API && c.method === "POST")
        .map((c) => ((c.body as { name: string }).name));

    const first = await callWorker("/api/admin/monitors-init", { method: "POST", headers: ADMIN });
    expect(first.status).toBe(502);
    expect(await first.json()).toEqual({ monitors: [{ page: "catalogue", monitor_id: "m-1" }], failed: ["programs"] });

    const second = await callWorker("/api/admin/monitors-init", { method: "POST", headers: ADMIN });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ monitors: [{ page: "programs", monitor_id: "m-3" }] });
    // The catalogue Monitor was asked for once: the one made first is the one stored.
    expect(pagesAsked()).toEqual(["falaj-catalogue", "falaj-programs", "falaj-programs"]);
    const rows = (await env.DB.prepare("SELECT page, monitor_id FROM monitors ORDER BY page").all<{ page: string; monitor_id: string }>()).results;
    expect(rows).toEqual([
      { page: "catalogue", monitor_id: "m-1" },
      { page: "programs", monitor_id: "m-3" },
    ]);
  });
});
