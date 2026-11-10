import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fetchMock } from "./helpers/fetch-mock";
import { callTool, listTools } from "./helpers/mcp";
import eventsFixture from "./fixtures/uaeu/events.json";
import refundsFixture from "./fixtures/uaeu/refunds.json";
import searchFaculty from "./fixtures/tinyfish/search-faculty.json";

const FETCH_API = "https://api.fetch.tinyfish.ai";
const SEARCH_API = /^https:\/\/api\.search\.tinyfish\.ai\/\?/;
const EVENTS_URL = "https://www.uaeu.ac.ae/en/events/";
const REFUNDS_URL = "https://www.uaeu.ac.ae/en/dvcsae/student_account_office/refunds.shtml";
const DIRECTORY_URL = "https://www.uaeu.ac.ae/en/catalog/uaeu-faculty-directory.shtml";
const EVENTS_NOTE = "Highlighted events from uaeu.ac.ae/en/events; may include past events";

type Page = { text: string; links?: string[]; final_url?: string };

const events = eventsFixture.results[0]!;
const refunds = refundsFixture.results[0]!;

// What TinyFetch answers for each URL in this test; a URL not listed gets an error entry.
let pages: Record<string, Page>;
// What TinySearch answers; the request URLs it saw.
let searchReply: unknown;
let searchRequests: URL[];

function registerTinyFish(): void {
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
        else results.push({ url, final_url: page.final_url ?? url, title: null, text: page.text, links: page.links ?? [] });
      }
      return Response.json({ results, errors });
    },
  });
  fetchMock.intercept({
    url: SEARCH_API,
    times: Infinity,
    reply: (req) => {
      searchRequests.push(new URL(req.url));
      return Response.json(searchReply);
    },
  });
}

function errorBody(r: any): any {
  expect(r.isError).toBe(true);
  expect(r.structuredContent).toBeUndefined();
  return JSON.parse(r.content[0].text);
}

function tinyFetchCalls() {
  return fetchMock.calls.filter((c) => c.url === `${FETCH_API}/`);
}

beforeEach(async () => {
  fetchMock.activate();
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  pages = {
    [EVENTS_URL]: { text: events.text, links: events.links },
    [REFUNDS_URL]: { text: refunds.text, links: refunds.links },
  };
  searchReply = searchFaculty;
  searchRequests = [];
  registerTinyFish();
});
afterEach(() => fetchMock.reset());

describe("list_events", () => {
  it("returns the five highlighted events with ISO dates, their pages, the note and the Fetch envelope", async () => {
    const r = await callTool("list_events", {});
    expect(r.isError).toBeUndefined();
    const s = r.structuredContent;
    expect(s.events).toHaveLength(5);
    expect(s.events[0]).toEqual({
      date: "2026-02-28",
      title: "Emirati Day for Education",
      url: "https://www.uaeu.ac.ae/en/events/emirati-day-for-education.shtml",
    });
    expect(s).toMatchObject({
      total: 5,
      note: EVENTS_NOTE,
      source_url: EVENTS_URL,
      method: "fetch",
      cached: false,
      ttl_seconds: 3600,
    });
    expect(new Date(s.read_at).toISOString()).toBe(s.read_at);
    expect(JSON.parse(r.content[0].text)).toEqual(s);
    // One Fetch URL, with links (for the events' own pages).
    expect(tinyFetchCalls()).toHaveLength(1);
    expect(tinyFetchCalls()[0]!.body).toMatchObject({ urls: [EVENTS_URL], links: true, ttl: 3600 });
  });

  it("filters by from/to, both ends included", async () => {
    const r = await callTool("list_events", { from: "2026-02-01", to: "2026-02-28" });
    expect(r.structuredContent.events.map((e: any) => e.date)).toEqual(["2026-02-28", "2026-02-16", "2026-02-09"]);
    expect(r.structuredContent.total).toBe(3);

    const exact = await callTool("list_events", { from: "2026-02-16", to: "2026-02-16" });
    expect(exact.structuredContent.events.map((e: any) => e.title)).toEqual(["UAEU's Session with The Great Arab Minds"]);

    const fromOnly = await callTool("list_events", { from: "2026-03-01" });
    expect(fromOnly.structuredContent.events.map((e: any) => e.date)).toEqual(["2026-03-02"]);
    const toOnly = await callTool("list_events", { to: "2026-01-31" });
    expect(toOnly.structuredContent.events.map((e: any) => e.date)).toEqual(["2026-01-26"]);
  });

  it("limits the list but not the total, and answers an empty list, not an error, when nothing falls in the range", async () => {
    const limited = await callTool("list_events", { limit: 2 });
    expect(limited.structuredContent.events).toHaveLength(2);
    expect(limited.structuredContent.total).toBe(5);
    const none = await callTool("list_events", { from: "2030-01-01" });
    expect(none.isError).toBeUndefined();
    // An empty answer says why: the page's events are all outside the range, and when they are dated.
    expect(none.structuredContent).toMatchObject({ events: [], total: 0 });
    expect(none.structuredContent.note).toBe(
      `${EVENTS_NOTE}. The page lists 5 events, dated 2026-01-26 to 2026-03-02; none falls in the range asked for.`,
    );
  });

  it("rejects a malformed date, a limit outside 1 to 50 and a range that runs backwards, without reading anything", async () => {
    for (const args of [{ from: "tomorrow" }, { to: "2026-13-01" }, { from: "28/02/2026" }, { limit: 0 }, { limit: 51 }]) {
      expect(errorBody(await callTool("list_events", args)), JSON.stringify(args)).toMatchObject({ code: "INVALID_INPUT" });
    }
    const backwards = errorBody(await callTool("list_events", { from: "2026-03-01", to: "2026-02-01" }));
    expect(backwards).toMatchObject({ code: "INVALID_INPUT" });
    expect(backwards.message).toContain("from");
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("is SITE_CHANGED, naming the events page, when the page lists no event", async () => {
    pages[EVENTS_URL] = { text: "# EVENTS\n\nNothing here.\n" };
    expect(errorBody(await callTool("list_events", {}))).toMatchObject({ code: "SITE_CHANGED", source_url: EVENTS_URL });
  });

  it("is SITE_CHANGED when the events page redirects, and UPSTREAM_TIMEOUT when TinyFetch could not read it", async () => {
    pages[EVENTS_URL] = { text: events.text, links: events.links, final_url: "https://www.uaeu.ac.ae/en/" };
    expect(errorBody(await callTool("list_events", {}))).toMatchObject({ code: "SITE_CHANGED", source_url: EVENTS_URL });
    delete pages[EVENTS_URL];
    expect(errorBody(await callTool("list_events", {}))).toMatchObject({ code: "UPSTREAM_TIMEOUT", retry_after_seconds: 30 });
  });
});

describe("academic_deadlines", () => {
  it("returns the withdrawal deadlines and the policy summary with the refunds url", async () => {
    const r = await callTool("academic_deadlines", {});
    expect(r.isError).toBeUndefined();
    const s = r.structuredContent;
    expect(s.deadlines).toHaveLength(7);
    expect(s.deadlines[0]).toEqual({
      label: "Courses Under the Full-Semester System: Course Withdrawal",
      date_or_rule: "24 August 2026 to 18 September 2026",
      refund_percent: 100,
      start_date: "2026-08-24",
      end_date: "2026-09-18",
    });
    expect(s.policy_summary.startsWith("This page outlines the approved deadlines")).toBe(true);
    expect(s).toMatchObject({
      url: REFUNDS_URL,
      source_url: REFUNDS_URL,
      method: "fetch",
      cached: false,
      ttl_seconds: 3600,
    });
    expect(JSON.parse(r.content[0].text)).toEqual(s);
    expect(tinyFetchCalls()).toHaveLength(1);
    expect(tinyFetchCalls()[0]!.body).toMatchObject({ urls: [REFUNDS_URL], links: false, ttl: 3600 });
  });

  it("is SITE_CHANGED, naming the page, when it has no deadline table", async () => {
    pages[REFUNDS_URL] = { text: "## Withdrawal Deadlines\n\nCome back later.\n" };
    expect(errorBody(await callTool("academic_deadlines", {}))).toMatchObject({ code: "SITE_CHANGED", source_url: REFUNDS_URL });
  });

  it("is SITE_CHANGED when the page redirects, and UPSTREAM_TIMEOUT when TinyFetch could not read it", async () => {
    pages[REFUNDS_URL] = { text: refunds.text, final_url: EVENTS_URL };
    expect(errorBody(await callTool("academic_deadlines", {}))).toMatchObject({ code: "SITE_CHANGED", source_url: REFUNDS_URL });
    delete pages[REFUNDS_URL];
    expect(errorBody(await callTool("academic_deadlines", {}))).toMatchObject({ code: "UPSTREAM_TIMEOUT", retry_after_seconds: 30 });
  });
});

describe("find_faculty", () => {
  it("calls TinySearch restricted to uaeu.ac.ae and returns people with method search", async () => {
    const r = await callTool("find_faculty", { query: "Amal Example" });
    expect(r.isError).toBeUndefined();
    const s = r.structuredContent;
    expect(s.people).toHaveLength(5);
    expect(s.total).toBe(5);
    expect(s.people[0]).toEqual({
      name: "Amal Example",
      title: "Dr.",
      college: "College of Medicine and Health Sciences",
      profile_url: "https://www.uaeu.ac.ae/en/cmhs/profile.shtml?email=a.example@uaeu.ac.ae",
    });
    expect(s.people.map((p: any) => p.profile_url)).not.toContain(DIRECTORY_URL);
    expect(s).toMatchObject({ source_url: DIRECTORY_URL, method: "search", cached: false });
    expect(s.ttl_seconds).toBeUndefined();
    expect(new Date(s.read_at).toISOString()).toBe(s.read_at);

    expect(searchRequests).toHaveLength(1);
    expect(searchRequests[0]!.searchParams.get("include_domains")).toBe("uaeu.ac.ae");
    expect(searchRequests[0]!.searchParams.get("query")).toContain("Amal Example");
    expect(tinyFetchCalls()).toHaveLength(0);
  });

  it("keeps the people whose college contains the filter text, ignoring case", async () => {
    const med = await callTool("find_faculty", { query: "example", college: "medicine" });
    expect(med.structuredContent.people.map((p: any) => p.name)).toEqual(["Amal Example", "Chen Example", "Eli Example"]);
    expect(med.structuredContent.total).toBe(3);
    const eng = await callTool("find_faculty", { query: "example", college: "ENGINEERING" });
    expect(eng.structuredContent.people.map((p: any) => p.name)).toEqual(["Basel Example"]);
  });

  it("is NOT_FOUND when Search returns no faculty profile", async () => {
    searchReply = {
      query: "zzz qqq",
      results: [{ position: 1, site_name: "uaeu.ac.ae", snippet: "", title: "UAEU Faculty Directory", url: DIRECTORY_URL }],
      total_results: 1,
      page: 0,
    };
    const body = errorBody(await callTool("find_faculty", { query: "zzz qqq" }));
    expect(body).toMatchObject({
      code: "NOT_FOUND",
      message: "No UAEU faculty profile matched zzz qqq",
      source_url: DIRECTORY_URL,
    });
    expect(body.fix).toEqual(expect.any(String));
    searchReply = { results: [] };
    expect(errorBody(await callTool("find_faculty", { query: "zzz qqq" })).code).toBe("NOT_FOUND");
  });

  it("is NOT_FOUND, naming the college, when the college filter leaves nobody", async () => {
    const body = errorBody(await callTool("find_faculty", { query: "example", college: "law" }));
    expect(body.code).toBe("NOT_FOUND");
    expect(body.message).toContain("example");
    expect(body.message).toContain("law");
    expect(body.fix).toContain("college");
  });

  it("rejects a query shorter than 2 characters as INVALID_INPUT, without searching", async () => {
    expect(errorBody(await callTool("find_faculty", { query: "x" }))).toMatchObject({ code: "INVALID_INPUT" });
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("is UPSTREAM_TIMEOUT when TinySearch fails", async () => {
    fetchMock.reset();
    fetchMock.activate();
    fetchMock.intercept({ url: SEARCH_API, times: Infinity, reply: { status: 502, json: { error: { code: "bad_gateway" } } } });
    expect(errorBody(await callTool("find_faculty", { query: "Amal Example" }))).toMatchObject({ code: "UPSTREAM_TIMEOUT" });
  });
});

describe("the page and faculty tools in tools/list", () => {
  it("lists the three with annotations, an example call, the TinyFish call behind them, and schemas", async () => {
    const tools = await listTools();
    const byName = (n: string) => tools.find((x: any) => x.name === n);
    for (const name of ["list_events", "academic_deadlines", "find_faculty"]) {
      const t = byName(name);
      expect(t, name).toBeDefined();
      expect(t.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true });
      expect(t.description).toContain(`Example: ${name}(`);
      expect(t.description).toMatch(/Returns/);
      expect(t.inputSchema.type).toBe("object");
      expect(Object.keys(t.outputSchema.properties)).toEqual(
        expect.arrayContaining(["source_url", "read_at", "method", "cached"]),
      );
    }
    expect(byName("list_events").description).toContain("TinyFetch");
    expect(byName("academic_deadlines").description).toContain("TinyFetch");
    expect(byName("find_faculty").description).toContain("TinySearch");
    expect(byName("list_events").inputSchema.properties.limit).toMatchObject({ minimum: 1, maximum: 50 });
    expect(byName("list_events").inputSchema.properties.from).toMatchObject({ type: "string", format: "date" });
    expect(Object.keys(byName("list_events").outputSchema.properties)).toEqual(
      expect.arrayContaining(["events", "total", "note", "ttl_seconds"]),
    );
    expect(Object.keys(byName("academic_deadlines").outputSchema.properties)).toEqual(
      expect.arrayContaining(["deadlines", "policy_summary", "url", "ttl_seconds"]),
    );
    expect(byName("find_faculty").inputSchema.properties.query.minLength).toBe(2);
    expect(Object.keys(byName("find_faculty").outputSchema.properties)).toEqual(expect.arrayContaining(["people", "total"]));
    expect(byName("find_faculty").description).toContain("College of Medicine and Health Sciences");
  });
});
