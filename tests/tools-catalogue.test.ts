import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { slugToName } from "../src/core/text";
import { getProgramMap, matchProgram, upsertProgramMap } from "../src/db/programMap";
import { parseCatalogue } from "../src/parsers/catalogue";
import { parseProgramIndex, programKind } from "../src/parsers/program";
import { fetchMock } from "./helpers/fetch-mock";
import { callTool, listTools } from "./helpers/mcp";
import catalogueFixture from "./fixtures/uaeu/catalogue-index.json";
import aeroFixture from "./fixtures/uaeu/course-aero485.json";
import hsrFixture from "./fixtures/uaeu/course-hsr140.json";
import mdsFixture from "./fixtures/uaeu/program-mds.json";
import microFixture from "./fixtures/uaeu/program-microcredential.json";
import minorFixture from "./fixtures/uaeu/program-minor.json";
import programsIndexFixture from "./fixtures/uaeu/programs-index.json";

const FETCH_API = "https://api.fetch.tinyfish.ai";
const CATALOGUE_URL = "https://www.uaeu.ac.ae/en/catalog/courses/";
const HSR_URL = "https://www.uaeu.ac.ae/en/catalog/courses/course_2924.shtml?id=HSR140";
const INDEX_URL = "https://www.uaeu.ac.ae/en/catalog/undergraduate/programs/";
const PROGRAMS = `${INDEX_URL}`;
// The index links the single-hyphen slug; the recorded page was read at the double-hyphen one.
const MDS_URL = `${PROGRAMS}bachelor-of-science-in-the-mathematics-of-data-science.shtml`;
const CS_URL = `${PROGRAMS}bachelor-of-science-in-computer-science.shtml`;
const MARKETING_URL = `${PROGRAMS}bachelor-of-business-administration-in-marketing.shtml`;
const MDS_NAME = "Bachelor of Science in the Mathematics of Data Science";

// `final_url` is where TinyFish says it ended up; it defaults to the requested URL (no redirect).
type Page = { text: string; links?: string[]; final_url?: string };

const cat = catalogueFixture.results[0]!;
const hsr = hsrFixture.results[0]!;
const mds = mdsFixture.results[0]!;
const idx = programsIndexFixture.results[0]!;
const minor = minorFixture.results[0]!;
const micro = microFixture.results[0]!;
const aero = aeroFixture.results[0]!;
const REAL_MINOR_URL = `${PROGRAMS}minor-in--statistics-and-data-analytics.shtml`;
const REAL_MICRO_URL = `${PROGRAMS}creditbearing-microcredential-in-accounting-foundations.shtml`;

// What TinyFetch answers for each URL in this test; a URL not listed gets an error entry.
let pages: Record<string, Page>;

function registerTinyFetch(): void {
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
}

function course(code: string) {
  return parseCatalogue(cat.text, cat.links)
    .colleges.flatMap((c) => c.courses)
    .find((c) => c.code === code);
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
    [CATALOGUE_URL]: { text: cat.text, links: cat.links },
    [INDEX_URL]: { text: idx.text, links: idx.links },
    [HSR_URL]: { text: hsr.text, links: hsr.links },
    [MDS_URL]: { text: mds.text, links: mds.links },
  };
  registerTinyFetch();
  await upsertProgramMap(
    env.DB,
    [
      { url: MDS_URL, name: MDS_NAME, college: "College of Science", kind: "bachelor" },
      { url: CS_URL, name: "Bachelor of Science in Computer Science", college: "College of Information Technology", kind: "bachelor" },
      {
        url: MARKETING_URL,
        name: "Bachelor of Business Administration in Marketing",
        college: "College of Business and Economics",
        kind: "bachelor",
      },
    ],
    new Date("2026-11-02T22:00:00Z"),
  );
});
afterEach(() => fetchMock.reset());

describe("search_courses", () => {
  it("ranks the exact code first and honours the college filter", async () => {
    const r = await callTool("search_courses", { query: "ECON105", college: "business" });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent.courses[0]).toMatchObject({
      code: "ECON105",
      title: "Principles of Microeconomics",
      college: "College of Business and Economics",
      url: expect.stringMatching(/course_\d+\.shtml\?id=ECON105$/),
    });
    expect(r.structuredContent).toMatchObject({
      total_matches: 1,
      source_url: CATALOGUE_URL,
      method: "fetch",
      cached: false,
      ttl_seconds: 3600,
    });
    expect(r.structuredContent.catalogue_read_at).toBe(r.structuredContent.read_at);
    expect(new Date(r.structuredContent.read_at).toISOString()).toBe(r.structuredContent.read_at);
    expect(JSON.parse(r.content[0].text)).toEqual(r.structuredContent);
    // One Fetch URL, with links.
    expect(tinyFetchCalls()).toHaveLength(1);
    expect(tinyFetchCalls()[0]!.body).toMatchObject({ urls: [CATALOGUE_URL], links: true, ttl: 3600 });
  });

  it("finds titles from topic words", async () => {
    const r = await callTool("search_courses", { query: "international finance" });
    const codes = r.structuredContent.courses.map((c: any) => c.code);
    expect(codes).toEqual(expect.arrayContaining(["FINC348", "ECON331"]));
    expect(r.structuredContent.total_matches).toBeGreaterThanOrEqual(2);
    // Titles that hold both words come before titles that hold only one.
    const both = r.structuredContent.courses.filter((c: any) => /international/i.test(c.title) && /finance/i.test(c.title));
    expect(r.structuredContent.courses.slice(0, both.length).map((c: any) => c.code)).toEqual(both.map((c: any) => c.code));
  });

  it("ranks code prefixes next, breaks ties by code, and limits the list but not total_matches", async () => {
    const expected = parseCatalogue(cat.text, cat.links)
      .colleges.flatMap((c) => c.courses)
      .filter((c) => c.code.startsWith("ECON"))
      .map((c) => c.code)
      .sort();
    const r = await callTool("search_courses", { query: "econ", limit: 5 });
    expect(r.structuredContent.courses.map((c: any) => c.code)).toEqual(expected.slice(0, 5));
    expect(r.structuredContent.total_matches).toBeGreaterThan(expected.length);
    const all = await callTool("search_courses", { query: "econ", limit: 50 });
    expect(all.structuredContent.courses.slice(0, expected.length).map((c: any) => c.code)).toEqual(expected);
  });

  it("returns 20 results by default and accepts a code with a space in it", async () => {
    const r = await callTool("search_courses", { query: "econ" });
    expect(r.structuredContent.courses).toHaveLength(20);
    const spaced = await callTool("search_courses", { query: "econ 105" });
    expect(spaced.structuredContent.courses[0]).toMatchObject({ code: "ECON105" });
  });

  it("ignores filler words such as 'of', so they do not match every title", async () => {
    const r = await callTool("search_courses", { query: "principles of economics", limit: 50 });
    expect(r.structuredContent.courses.length).toBeGreaterThan(0);
    for (const c of r.structuredContent.courses) expect(c.title).toMatch(/principles|economics/i);
  });

  it("matches the college filter as a case-insensitive substring of the heading, General Education included", async () => {
    const edu = await callTool("search_courses", { query: "HSR", college: "EDUCATION" });
    expect(edu.structuredContent.courses.map((c: any) => [c.code, c.college])).toEqual([
      ["HSR140", "General Education"],
      ["HSR150", "General Education"],
    ]);
    const none = await callTool("search_courses", { query: "HSR", college: "College of Education" });
    expect(none.structuredContent).toMatchObject({ courses: [], total_matches: 0 });
  });

  it("answers an empty list, not an error, when nothing matches", async () => {
    const r = await callTool("search_courses", { query: "zzzzqqqq" });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toMatchObject({ courses: [], total_matches: 0 });
  });

  it("rejects an empty query and a limit outside 1 to 50 as INVALID_INPUT, without reading anything", async () => {
    for (const args of [{ query: "" }, { query: "x", limit: 0 }, { query: "x", limit: 51 }, { query: "x", limit: 1.5 }]) {
      expect(errorBody(await callTool("search_courses", args))).toMatchObject({ code: "INVALID_INPUT" });
    }
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("is SITE_CHANGED, naming the catalogue page, when the page has no course list", async () => {
    pages[CATALOGUE_URL] = { text: "# Courses\n\nThe catalogue has moved.\n", links: [] };
    expect(errorBody(await callTool("search_courses", { query: "ECON" }))).toMatchObject({
      code: "SITE_CHANGED",
      source_url: CATALOGUE_URL,
    });
  });
});

describe("get_course", () => {
  it("reads the catalogue then the course page and returns only HSR140", async () => {
    const r = await callTool("get_course", { code: "hsr140" });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toMatchObject({
      code: "HSR140",
      title: "Introduction to Society & Behavior",
      college: "General Education",
      credit_hours: 3,
      prerequisites: [],
      url: HSR_URL,
      source_url: expect.stringContaining("id=HSR140"),
      method: "fetch",
      cached: false,
      ttl_seconds: 3600,
    });
    expect(r.structuredContent.learning_outcomes).toHaveLength(4);
    expect(r.structuredContent.description).toContain("Psychology");
    expect(r.structuredContent.description).not.toContain("Geography"); // HSR150's sentence
    expect(fetchMock.calls).toHaveLength(2);
    expect(tinyFetchCalls().map((c) => (c.body as any).urls)).toEqual([[CATALOGUE_URL], [HSR_URL]]);
    expect((tinyFetchCalls()[0]!.body as any).links).toBe(true);
  });

  it("is NOT_FOUND for a code that is not in the catalogue, after one read", async () => {
    const body = errorBody(await callTool("get_course", { code: "ZZZZ999" }));
    expect(body).toMatchObject({ code: "NOT_FOUND", message: "No course ZZZZ999 in the UAEU catalogue", source_url: CATALOGUE_URL });
    expect(body.fix).toContain("search_courses");
    expect(fetchMock.calls).toHaveLength(1);
  });

  it("is INVALID_INPUT for a malformed code, without reading anything", async () => {
    for (const code of ["hello", "HSR", "H140", "HSR1", "HSR14000", " HSR140", "HSR140 "]) {
      expect(errorBody(await callTool("get_course", { code }))).toMatchObject({ code: "INVALID_INPUT" });
    }
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("is SITE_CHANGED, naming the course page, when its heading is absent", async () => {
    pages[HSR_URL] = { text: "# Some Other Course (XYZ999)\n\nSomething else.\n" };
    expect(errorBody(await callTool("get_course", { code: "HSR140" }))).toMatchObject({
      code: "SITE_CHANGED",
      source_url: HSR_URL,
    });
  });

  it("reads a heading with a space inside the parentheses (the trailing-space codes)", async () => {
    pages[CATALOGUE_URL] = {
      text: "# Courses\n\n## College of Engineering\n\n* + AERO485  : Aerospace Project\n",
      links: ["https://www.uaeu.ac.ae/en/catalog/courses/course_2945.shtml?id=AERO485 "],
    };
    pages["https://www.uaeu.ac.ae/en/catalog/courses/course_2945.shtml?id=AERO485"] = {
      text: "# Aerospace Project (AERO485 )\n\nA capstone.\n\n### Credit Hours : 3\n",
    };
    const r = await callTool("get_course", { code: "AERO485" });
    expect(r.structuredContent).toMatchObject({
      code: "AERO485",
      title: "Aerospace Project",
      college: "College of Engineering",
      credit_hours: 3,
      learning_outcomes: [],
    });
  });

  it("never fetches a course URL outside https://www.uaeu.ac.ae/: SITE_CHANGED naming the catalogue page", async () => {
    pages[CATALOGUE_URL] = {
      text: "# Courses\n\n## College of Science\n\n* + TEST101 : A test course\n",
      links: ["https://evil.example/en/catalog/courses/course_1.shtml?id=TEST101"],
    };
    const body = errorBody(await callTool("get_course", { code: "TEST101" }));
    expect(body).toMatchObject({ code: "SITE_CHANGED", source_url: CATALOGUE_URL });
    expect(fetchMock.calls).toHaveLength(1); // the catalogue only
  });

  it("is SITE_CHANGED, naming the catalogue, for a course the catalogue lists without a link to its page", async () => {
    pages[CATALOGUE_URL] = {
      text: "# Courses\n\n## College of Science\n\n* + TEST101 : A test course\n",
      links: [],
    };
    expect(errorBody(await callTool("get_course", { code: "TEST101" }))).toMatchObject({
      code: "SITE_CHANGED",
      source_url: CATALOGUE_URL,
    });
    expect(fetchMock.calls).toHaveLength(1);
  });

  it("is UPSTREAM_TIMEOUT when TinyFetch could not read the course page", async () => {
    delete pages[HSR_URL];
    expect(errorBody(await callTool("get_course", { code: "HSR140" }))).toMatchObject({
      code: "UPSTREAM_TIMEOUT",
      retry_after_seconds: 30,
      source_url: HSR_URL,
    });
  });
});

describe("list_programs", () => {
  it("returns the 75 offerings of the index, named from the map or from the slug", async () => {
    const r = await callTool("list_programs", {});
    expect(r.isError).toBeUndefined();
    const out = r.structuredContent;
    expect(out).toMatchObject({
      total: 75,
      map_built_at: "2026-11-02T22:00:00.000Z",
      source_url: INDEX_URL,
      method: "fetch",
      cached: false,
      ttl_seconds: 3600,
    });
    expect(out.programs).toHaveLength(75);
    expect(out.programs.find((p: any) => p.url === MDS_URL)).toEqual({
      name: MDS_NAME,
      college: "College of Science",
      kind: "bachelor",
      url: MDS_URL,
    });
    // Not in the map: the name comes from the slug (double hyphen = one separator), the college is null.
    expect(out.programs.find((p: any) => p.url === `${PROGRAMS}bachelor-of-arts-in-psychology.shtml`)).toEqual({
      name: "Bachelor of Arts in Psychology",
      college: null,
      kind: "bachelor",
      url: `${PROGRAMS}bachelor-of-arts-in-psychology.shtml`,
    });
    expect(out.programs.find((p: any) => p.url.endsWith("minor-in--statistics-and-data-analytics.shtml"))).toMatchObject({
      name: "Minor in Statistics and Data Analytics",
      college: null,
      kind: "minor",
    });
    // It reads the index only, never a programme page.
    expect(tinyFetchCalls()).toHaveLength(1);
    expect(tinyFetchCalls()[0]!.body).toMatchObject({ urls: [INDEX_URL], links: true });
  });

  it("gives every offering a kind: 54 bachelor, 1 doctorate, 12 minor, 8 micro-credential", async () => {
    const r = await callTool("list_programs", {});
    const counts: Record<string, number> = {};
    for (const p of r.structuredContent.programs) counts[p.kind] = (counts[p.kind] ?? 0) + 1;
    expect(counts).toEqual({ bachelor: 54, doctorate: 1, minor: 12, micro_credential: 8 });
    const gaming = r.structuredContent.programs.find((p: any) => p.url.endsWith("creditbearing-microcredential-in-ai-in-gaming.shtml"));
    expect(gaming).toMatchObject({ name: "Creditbearing Microcredential in Ai in Gaming", kind: "micro_credential" });
  });

  it("filters by kind, by college (a case-insensitive substring) and by query words, and totals the filtered list", async () => {
    const micro = await callTool("list_programs", { kind: "micro_credential" });
    expect(micro.structuredContent.total).toBe(8);
    expect(micro.structuredContent.programs.every((p: any) => p.kind === "micro_credential")).toBe(true);

    const science = await callTool("list_programs", { college: "COLLEGE OF SCIENCE" });
    expect(science.structuredContent).toMatchObject({ total: 1 });
    expect(science.structuredContent.programs[0]).toMatchObject({ url: MDS_URL, college: "College of Science" });

    const query = await callTool("list_programs", { query: "data  ANALYTICS" });
    expect(query.structuredContent.programs.map((p: any) => p.name)).toEqual([
      "Minor in Statistics and Data Analytics",
      "Bachelor of Science in Statistics and Data Analytics",
      "Bachelor of Science in Applied Sociology and Social Data Analytics",
    ]);
    expect(query.structuredContent.total).toBe(3);

    const both = await callTool("list_programs", { query: "science", kind: "doctorate" });
    expect(both.structuredContent).toMatchObject({ programs: [], total: 0 });
  });

  it("rejects an unknown kind as INVALID_INPUT", async () => {
    expect(errorBody(await callTool("list_programs", { kind: "masters" }))).toMatchObject({ code: "INVALID_INPUT" });
  });

  it("works with an empty programme map: slug names, null colleges, map_built_at null", async () => {
    await env.DB.prepare("DELETE FROM program_map").run();
    const r = await callTool("list_programs", {});
    expect(r.structuredContent).toMatchObject({ total: 75, map_built_at: null });
    expect(r.structuredContent.programs.every((p: any) => p.college === null)).toBe(true);
  });

  it("is SITE_CHANGED, naming the index, when the page lists no programme", async () => {
    pages[INDEX_URL] = { text: "Programs\n", links: ["https://www.uaeu.ac.ae/en/"] };
    expect(errorBody(await callTool("list_programs", {}))).toMatchObject({ code: "SITE_CHANGED", source_url: INDEX_URL });
  });
});

describe("get_program", () => {
  it("reads the page of an exact name, from the map alone (one Fetch URL)", async () => {
    const r = await callTool("get_program", { name_or_url: "Mathematics of Data Science" });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toMatchObject({
      name: MDS_NAME,
      college: "College of Science",
      kind: "bachelor",
      url: MDS_URL,
      source_url: MDS_URL,
      method: "fetch",
      cached: false,
      ttl_seconds: 3600,
    });
    expect(r.structuredContent.degree_plan.length).toBeGreaterThanOrEqual(80);
    expect(r.structuredContent.degree_plan[0]).toMatchObject({ code: expect.stringMatching(/^[A-Z]+\d+/), title: expect.any(String) });
    expect(r.structuredContent.objectives).toHaveLength(5);
    expect(r.structuredContent.credit_hours).toEqual(expect.any(Number));
    expect(r.structuredContent.description.length).toBeGreaterThan(100);
    expect(tinyFetchCalls()).toHaveLength(1);
    expect(tinyFetchCalls()[0]!.body).toMatchObject({ urls: [MDS_URL] });
  });

  it("matches a name regardless of case, punctuation and the leading degree words", async () => {
    for (const q of ["BACHELOR OF SCIENCE IN THE MATHEMATICS OF DATA SCIENCE", "mathematics of data science!", "the Mathematics of Data Science"]) {
      const r = await callTool("get_program", { name_or_url: q });
      expect(r.structuredContent).toMatchObject({ url: MDS_URL });
    }
  });

  it("reads a programme URL directly, without the map", async () => {
    await env.DB.prepare("DELETE FROM program_map").run();
    const r = await callTool("get_program", { name_or_url: MDS_URL });
    expect(r.structuredContent).toMatchObject({ name: MDS_NAME, college: "College of Science", url: MDS_URL, kind: "bachelor" });
    expect(tinyFetchCalls()).toHaveLength(1);
  });

  it("reads the URL it rebuilds from the input: a query string or fragment is dropped", async () => {
    const r = await callTool("get_program", { name_or_url: `${MDS_URL}?utm=1#plan` });
    expect(r.structuredContent).toMatchObject({ url: MDS_URL });
    expect(tinyFetchCalls()[0]!.body).toMatchObject({ urls: [MDS_URL] });
  });

  it("is INVALID_INPUT for any other URL, before anything is fetched", async () => {
    for (const bad of [
      "https://evil.example/en/catalog/undergraduate/programs/x.shtml",
      "http://www.uaeu.ac.ae/en/catalog/undergraduate/programs/bachelor-of-economics.shtml",
      "https://www.uaeu.ac.ae@evil.example/en/catalog/undergraduate/programs/bachelor-of-economics.shtml",
      "https://www.uaeu.ac.ae:8443/en/catalog/undergraduate/programs/bachelor-of-economics.shtml",
      "https://www.uaeu.ac.ae/en/catalog/courses/course_2924.shtml?id=HSR140",
      "https://www.uaeu.ac.ae/en/catalog/undergraduate/programs/",
      "https://www.uaeu.ac.ae/en/catalog/undergraduate/programs/a/b.shtml",
      "https://www.uaeu.ac.ae/en/catalog/undergraduate/programs/general-education-requirements.shtml",
    ]) {
      const body = errorBody(await callTool("get_program", { name_or_url: bad }));
      expect(body, bad).toMatchObject({ code: "INVALID_INPUT" });
      expect(body.fix).toContain("list_programs");
    }
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("is NOT_FOUND listing the programmes when a name matches several, and reads no page", async () => {
    const body = errorBody(await callTool("get_program", { name_or_url: "Bachelor of Science" }));
    expect(body).toMatchObject({
      code: "NOT_FOUND",
      near_matches: expect.arrayContaining([expect.stringContaining("Bachelor of Science")]),
    });
    expect([...body.near_matches].sort()).toEqual([MDS_NAME, "Bachelor of Science in Computer Science"].sort());
    expect(body.fix).toContain("name_or_url");
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("is NOT_FOUND with the nearest names when nothing matches well enough", async () => {
    const near = errorBody(await callTool("get_program", { name_or_url: "Marketing Analytics" }));
    expect(near).toMatchObject({ code: "NOT_FOUND", near_matches: ["Bachelor of Business Administration in Marketing"] });
    const nothing = errorBody(await callTool("get_program", { name_or_url: "Quantum Basketweaving" }));
    expect(nothing.code).toBe("NOT_FOUND");
    expect(nothing.near_matches).toBeUndefined();
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("is NOT_FOUND with the build-the-map fix when the programme map is empty", async () => {
    await env.DB.prepare("DELETE FROM program_map").run();
    const body = errorBody(await callTool("get_program", { name_or_url: "Mathematics of Data Science" }));
    expect(body).toMatchObject({
      code: "NOT_FOUND",
      fix: "The programme map is not built yet; pass a programme URL from list_programs",
    });
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("rejects a name shorter than 2 characters as INVALID_INPUT", async () => {
    expect(errorBody(await callTool("get_program", { name_or_url: "x" }))).toMatchObject({ code: "INVALID_INPUT" });
  });

  it("is SITE_CHANGED, naming the page, when it holds no programme content", async () => {
    pages[MDS_URL] = { text: "Page not found\n" };
    expect(errorBody(await callTool("get_program", { name_or_url: MDS_URL }))).toMatchObject({
      code: "SITE_CHANGED",
      source_url: MDS_URL,
    });
  });

  it("is SITE_CHANGED for a blank page and for a page that is only the language notice", async () => {
    for (const text of ["", "   \n\n", "### عفوا\n\nهذه الصفحة غير متوفرة باللغة العربية\n", "Sorry, this page is not available in English.\n"]) {
      pages[MDS_URL] = { text };
      expect(errorBody(await callTool("get_program", { name_or_url: MDS_URL })), JSON.stringify(text)).toMatchObject({
        code: "SITE_CHANGED",
        source_url: MDS_URL,
      });
    }
  });

  it("gives a sparse result, not SITE_CHANGED, for a minor-shaped page: no name heading, a credit-hours line, no plan table", async () => {
    const MINOR_URL = `${PROGRAMS}minor-in--statistics-and-data-analytics.shtml`;
    pages[MINOR_URL] = { text: "A minor for students of other majors.\n\nRequired Credit Hours: 15\n" };

    // Not in the map: the name comes from the slug.
    const bySlug = await callTool("get_program", { name_or_url: MINOR_URL });
    expect(bySlug.isError).toBeUndefined();
    expect(bySlug.structuredContent).toMatchObject({
      name: "Minor in Statistics and Data Analytics",
      kind: "minor",
      college: null,
      credit_hours: 15,
      description: "",
      objectives: [],
      degree_plan: [],
      url: MINOR_URL,
      source_url: MINOR_URL,
    });

    // In the map: the name and college come from the map, and a name finds it.
    await upsertProgramMap(
      env.DB,
      [{ url: MINOR_URL, name: "Minor in Statistics and Data Analytics", college: "College of Business and Economics", kind: "minor" }],
      new Date("2026-11-02T22:00:00Z"),
    );
    const byName = await callTool("get_program", { name_or_url: "Minor in Statistics and Data Analytics" });
    expect(byName.structuredContent).toMatchObject({
      name: "Minor in Statistics and Data Analytics",
      kind: "minor",
      college: "College of Business and Economics",
      credit_hours: 15,
      objectives: [],
      degree_plan: [],
    });
  });

  it("gives a sparse result for a page that only names its hosting college", async () => {
    const MICRO_URL = `${PROGRAMS}creditbearing-microcredential-in-ai-in-gaming.shtml`;
    pages[MICRO_URL] = { text: "This micro-credential is hosted by the Department of Computer Science, CIT.\n" };
    const r = await callTool("get_program", { name_or_url: MICRO_URL });
    expect(r.structuredContent).toMatchObject({
      name: "Creditbearing Microcredential in Ai in Gaming",
      kind: "micro_credential",
      college: "College of Information Technology",
      credit_hours: null,
      description: "",
      objectives: [],
      degree_plan: [],
    });
  });

  it("tolerates a page without the usual sections: empty arrays and nulls, the college from the map", async () => {
    pages[MDS_URL] = { text: "## Minor in Mathematics\n\nA short minor.\n" };
    const minor = await callTool("get_program", { name_or_url: MDS_URL });
    expect(minor.structuredContent).toMatchObject({
      name: "Minor in Mathematics",
      kind: "minor",
      college: "College of Science", // the hosting sentence is absent, so the map's college fills in
      credit_hours: null,
      objectives: [],
      degree_plan: [],
    });
  });

  // The recorded minor and micro-credential pages, fetched by URL. Neither page has a "hosted by"
  // sentence, so the college is null unless the programme map has it; everything else is on the page.
  it("reads the recorded minor by URL: kind minor, 18 credit hours, 4 objectives, 9 plan courses, not SITE_CHANGED", async () => {
    pages[REAL_MINOR_URL] = { text: minor.text, links: minor.links };
    const r = await callTool("get_program", { name_or_url: REAL_MINOR_URL });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toMatchObject({
      name: "Minor in Statistics and Data Analytics",
      kind: "minor",
      college: null,
      credit_hours: 18,
      url: REAL_MINOR_URL,
      source_url: REAL_MINOR_URL,
      method: "fetch",
      ttl_seconds: 3600,
    });
    expect(r.structuredContent.objectives).toHaveLength(4);
    expect(r.structuredContent.degree_plan).toHaveLength(9);
    expect(r.structuredContent.description).toContain("applied statistics and data analytics");
    expect(tinyFetchCalls()).toHaveLength(1);

    // Once the map knows the college, it fills the gap the page leaves.
    await upsertProgramMap(
      env.DB,
      [{ url: REAL_MINOR_URL, name: "Minor in Statistics and Data Analytics", college: "College of Science", kind: "minor" }],
      new Date("2026-11-02T22:00:00Z"),
    );
    const byName = await callTool("get_program", { name_or_url: "Minor in Statistics and Data Analytics" });
    expect(byName.structuredContent).toMatchObject({ kind: "minor", college: "College of Science", credit_hours: 18 });
  });

  it("reads the recorded micro-credential by URL: kind micro_credential, 6 credit hours, 4 objectives, 2 plan courses, not SITE_CHANGED", async () => {
    pages[REAL_MICRO_URL] = { text: micro.text, links: micro.links };
    const r = await callTool("get_program", { name_or_url: REAL_MICRO_URL });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toMatchObject({
      name: "Credit-Bearing Micro-Credential in Accounting Foundations",
      kind: "micro_credential",
      college: null,
      credit_hours: 6,
      url: REAL_MICRO_URL,
    });
    expect(r.structuredContent.objectives).toHaveLength(4);
    expect(r.structuredContent.degree_plan.map((c: any) => c.code)).toEqual(["ACCT101", "ACCT103"]);
  });

  it("keeps the map's name and kind when the page's first heading is not a programme name", async () => {
    pages[MDS_URL] = { text: "## Admission Requirements\n\nStudents apply in the spring.\n\nRequired Credit Hours : minimum 18 hours\n" };
    const mapped = await callTool("get_program", { name_or_url: "Mathematics of Data Science" });
    expect(mapped.isError).toBeUndefined();
    expect(mapped.structuredContent).toMatchObject({ name: MDS_NAME, kind: "bachelor", credit_hours: 18 });

    // With no map row the slug names it, and the kind agrees with list_programs.
    await env.DB.prepare("DELETE FROM program_map").run();
    const bySlug = await callTool("get_program", { name_or_url: MDS_URL });
    expect(bySlug.structuredContent).toMatchObject({ name: MDS_NAME, kind: "bachelor" });

    // A heading that does begin with a kind prefix still wins over the map's name.
    pages[MDS_URL] = { text: "## Minor in Mathematics\n\nA short minor.\n" };
    const own = await callTool("get_program", { name_or_url: MDS_URL });
    expect(own.structuredContent).toMatchObject({ name: "Minor in Mathematics", kind: "minor" });
  });

  it("lists at most 10 near_matches for a degree-only name, and says how many programmes match", async () => {
    const rows = parseProgramIndex(idx.links).map((url) => {
      const name = slugToName(/\/([^/]+)\.shtml$/.exec(url)![1]!);
      return { url, name, college: null, kind: programKind(name) };
    });
    await upsertProgramMap(env.DB, rows, new Date("2026-11-02T22:00:00Z"));
    const bachelors = [...new Set(rows.filter((r) => r.kind === "bachelor").map((r) => r.name))].sort((a, b) => a.localeCompare(b));
    expect(bachelors).toHaveLength(54);

    const body = errorBody(await callTool("get_program", { name_or_url: "Bachelor of" }));
    expect(body.code).toBe("NOT_FOUND");
    expect(body.near_matches).toEqual(bachelors.slice(0, 10));
    expect(body.message).toBe(
      '54 programmes match "Bachelor of"; the first 10 are listed; add words from the programme name to narrow it',
    );
    expect(body.fix).toContain("name_or_url");
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("lists every near_match, with the short message, when 10 or fewer programmes match", async () => {
    const body = errorBody(await callTool("get_program", { name_or_url: "Bachelor of Science" }));
    expect(body.near_matches).toHaveLength(2);
    expect(body.message).toBe('"Bachelor of Science" matches 2 programmes; say which one');
  });

  it("is UPSTREAM_TIMEOUT when TinyFetch could not read the page", async () => {
    delete pages[MDS_URL];
    expect(errorBody(await callTool("get_program", { name_or_url: "Mathematics of Data Science" }))).toMatchObject({
      code: "UPSTREAM_TIMEOUT",
      retry_after_seconds: 30,
    });
  });
});

describe("the recorded AERO485 page", () => {
  it("get_course reads AERO485 at the catalogue's link, although the site's id ends in a space", async () => {
    const url = parseCatalogue(cat.text, cat.links).courseMap.get("AERO485")!;
    expect(url).toMatch(/course_2945\.shtml\?id=AERO485$/);
    pages[url] = { text: aero.text, links: aero.links };
    const r = await callTool("get_course", { code: "aero485" });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toMatchObject({
      code: "AERO485",
      title: "Internship I",
      credit_hours: 1,
      url,
      source_url: url,
    });
    expect(r.structuredContent.learning_outcomes).toHaveLength(3);
    expect(r.structuredContent.prerequisites).toHaveLength(7);
    expect(r.structuredContent.description).not.toContain("correlate their academic preparation"); // AERO490's
  });
});

describe("a page TinyFish redirected somewhere else", () => {
  const SITE_CHANGED_FIX = "UAEU changed this page; health_check shows when it was last seen working, so try again later";

  it("get_program: a URL the caller gave is NOT_FOUND, naming where it went", async () => {
    pages[MDS_URL] = { text: idx.text, links: idx.links, final_url: INDEX_URL };
    const body = errorBody(await callTool("get_program", { name_or_url: MDS_URL }));
    expect(body).toMatchObject({
      code: "NOT_FOUND",
      message: `${MDS_URL} redirects to ${INDEX_URL}; it is not a programme page`,
      source_url: MDS_URL,
    });
    expect(tinyFetchCalls()).toHaveLength(1);
  });

  it("get_program: a URL from the programme map is SITE_CHANGED (the map is out of date, not the caller wrong)", async () => {
    pages[MDS_URL] = { text: idx.text, links: idx.links, final_url: INDEX_URL };
    const body = errorBody(await callTool("get_program", { name_or_url: "Mathematics of Data Science" }));
    expect(body).toMatchObject({ code: "SITE_CHANGED", source_url: MDS_URL, fix: SITE_CHANGED_FIX });
    expect(body.message).toContain(INDEX_URL);
  });

  it("get_course: a course page that redirects is SITE_CHANGED, naming the course page", async () => {
    pages[HSR_URL] = { text: hsr.text, final_url: CATALOGUE_URL };
    const body = errorBody(await callTool("get_course", { code: "HSR140" }));
    expect(body).toMatchObject({ code: "SITE_CHANGED", source_url: HSR_URL, fix: SITE_CHANGED_FIX });
    expect(body.message).toContain(CATALOGUE_URL);
  });

  it("the catalogue and the programmes index are SITE_CHANGED when they redirect", async () => {
    pages[CATALOGUE_URL] = { text: cat.text, links: cat.links, final_url: "https://www.uaeu.ac.ae/en/" };
    expect(errorBody(await callTool("search_courses", { query: "ECON105" }))).toMatchObject({
      code: "SITE_CHANGED",
      source_url: CATALOGUE_URL,
    });
    pages[INDEX_URL] = { text: idx.text, links: idx.links, final_url: "https://www.uaeu.ac.ae/en/catalog/" };
    expect(errorBody(await callTool("list_programs", {}))).toMatchObject({ code: "SITE_CHANGED", source_url: INDEX_URL });
  });

  it("a trailing slash, an upper-case host or a fragment is not a redirect", async () => {
    for (const final of [`${MDS_URL}/`, MDS_URL.replace("www.uaeu.ac.ae", "WWW.UAEU.AC.AE"), `${MDS_URL}#plan`]) {
      pages[MDS_URL] = { text: mds.text, links: mds.links, final_url: final };
      const r = await callTool("get_program", { name_or_url: MDS_URL });
      expect(r.isError, final).toBeUndefined();
      expect(r.structuredContent.name).toBe(MDS_NAME);
    }
  });
});

describe("a TinyFetch failure", () => {
  it("is UPSTREAM_TIMEOUT with retry_after_seconds 30, whichever tool read", async () => {
    fetchMock.reset();
    fetchMock.activate();
    fetchMock.intercept({ url: FETCH_API, times: Infinity, reply: { status: 502, json: { error: { code: "bad_gateway" } } } });
    for (const [tool, args] of [
      ["search_courses", { query: "ECON105" }],
      ["get_course", { code: "HSR140" }],
      ["list_programs", {}],
      ["get_program", { name_or_url: MDS_URL }],
    ] as const) {
      const body = errorBody(await callTool(tool, args));
      expect(body, tool).toEqual({
        code: "UPSTREAM_TIMEOUT",
        message: "TinyFish did not answer in time while reading uaeu.ac.ae",
        retry_after_seconds: 30,
      });
    }
  });
});

describe("the catalogue tools in tools/list", () => {
  it("lists the four with annotations, an example call, the TinyFish call behind them, and schemas", async () => {
    const tools = await listTools();
    for (const name of ["search_courses", "get_course", "list_programs", "get_program"]) {
      const t = tools.find((x: any) => x.name === name);
      expect(t, name).toBeDefined();
      expect(t.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true });
      expect(t.description).toContain(`Example: ${name}(`);
      expect(t.description).toContain("TinyFetch");
      expect(t.description).toMatch(/Returns/);
      expect(t.inputSchema.type).toBe("object");
      expect(Object.keys(t.outputSchema.properties)).toEqual(
        expect.arrayContaining(["source_url", "read_at", "method", "cached", "ttl_seconds"]),
      );
    }
    const byName = (n: string) => tools.find((x: any) => x.name === n);
    expect(byName("search_courses").inputSchema.properties.limit).toMatchObject({ minimum: 1, maximum: 50 });
    expect(byName("get_course").inputSchema.properties.code.pattern).toBe("^[A-Za-z]{2,5}\\d{3,4}[A-Za-z]?$");
    expect(byName("list_programs").inputSchema.properties.kind.enum).toEqual([
      "bachelor",
      "doctorate",
      "minor",
      "micro_credential",
      "other",
    ]);
    expect(byName("list_programs").outputSchema.properties.programs.items.properties).toHaveProperty("kind");
    expect(byName("get_program").outputSchema.properties).toHaveProperty("kind");
    expect(byName("get_program").inputSchema.properties.name_or_url.minLength).toBe(2);
  });

  it("explains the college filter in search_courses and list_programs (substring of the heading)", async () => {
    const tools = await listTools();
    for (const name of ["search_courses", "list_programs"]) {
      const d = tools.find((x: any) => x.name === name).description as string;
      expect(d, name).toMatch(/substring/i);
      expect(d, name).toContain("College of Science");
      expect(d, name).toContain("Humanities and Social Sciences");
    }
    expect(tools.find((x: any) => x.name === "search_courses").description).toContain("General Education");
  });
});

describe("the programme map", () => {
  it("stores name, college and kind per URL, upserts on conflict, and reports the latest built_at", async () => {
    await env.DB.prepare("DELETE FROM program_map").run();
    expect(await getProgramMap(env.DB)).toEqual({ rows: new Map(), built_at: null });

    await upsertProgramMap(
      env.DB,
      [
        { url: "https://x/a", name: "Bachelor of Arts in A", college: "College of Law", kind: "bachelor" },
        { url: "https://x/b", name: "Minor in B", college: null, kind: "minor" },
      ],
      new Date("2026-11-01T00:00:00Z"),
    );
    await upsertProgramMap(
      env.DB,
      [{ url: "https://x/a", name: "Bachelor of Arts in Alpha", college: "College of Law", kind: "bachelor" }],
      new Date("2026-11-02T00:00:00Z"),
    );
    const map = await getProgramMap(env.DB);
    expect(map.rows).toEqual(
      new Map([
        ["https://x/a", { name: "Bachelor of Arts in Alpha", college: "College of Law", kind: "bachelor" }],
        ["https://x/b", { name: "Minor in B", college: null, kind: "minor" }],
      ]),
    );
    expect(map.built_at).toBe("2026-11-02T00:00:00.000Z");
    await upsertProgramMap(env.DB, [], new Date());
    expect((await getProgramMap(env.DB)).rows.size).toBe(2);
  });

  it("migration 0001 gives program_map a kind column that defaults to 'other'", async () => {
    await env.DB.prepare("INSERT INTO program_map (url, name, college, built_at) VALUES ('https://x/c', 'C', NULL, 't')").run();
    expect((await getProgramMap(env.DB)).rows.get("https://x/c")).toEqual({ name: "C", college: null, kind: "other" });
  });
});

describe("matchProgram", () => {
  const row = (name: string) => ({ name, college: null, kind: "bachelor" as const });
  const map = new Map([
    ["u/mds", row(MDS_NAME)],
    ["u/cs", row("Bachelor of Science in Computer Science")],
    ["u/mkt", row("Bachelor of Business Administration in Marketing")],
    ["u/chem", row("Bachelor of Science in Chemistry")],
    ["u/minor-chem", row("Minor in Chemistry")],
    ["u/psy", row("Bachelor of Arts in Psychology")],
  ]);

  it("returns the one best match above 0.6", () => {
    expect(matchProgram(map, "Mathematics of Data Science")).toEqual({ match: "one", url: "u/mds" });
    expect(matchProgram(map, "Psychology")).toEqual({ match: "one", url: "u/psy" });
    expect(matchProgram(map, "computer science")).toEqual({ match: "one", url: "u/cs" });
  });

  it("returns every name tied at the top as many", () => {
    // Only the Bachelor of Science programmes: not the Arts or Business ones.
    expect(matchProgram(map, "Bachelor of Science")).toEqual({
      match: "many",
      names: ["Bachelor of Science in Chemistry", "Bachelor of Science in Computer Science", MDS_NAME],
    });
    const tie = matchProgram(map, "Chemistry");
    expect(tie).toEqual({ match: "many", names: expect.arrayContaining(["Bachelor of Science in Chemistry", "Minor in Chemistry"]) });
    expect(tie.match === "many" && tie.names).toHaveLength(2);
  });

  it("lets an exact full name win over a tie on the shortened words", () => {
    expect(matchProgram(map, "Bachelor of Science in Chemistry")).toEqual({ match: "one", url: "u/chem" });
    expect(matchProgram(map, "minor in chemistry")).toEqual({ match: "one", url: "u/minor-chem" });
  });

  it("returns none with the (at most three) nearest names, best first, when nothing reaches 0.6", () => {
    const r = matchProgram(map, "Marketing Analytics Strategy");
    expect(r).toEqual({ match: "none", nearest: ["Bachelor of Business Administration in Marketing"] });
    expect(matchProgram(map, "Quantum Basketweaving")).toEqual({ match: "none", nearest: [] });
    const wide = matchProgram(map, "science data analytics engineering design");
    expect(wide.match === "none" && wide.nearest.length).toBeLessThanOrEqual(3);
  });

  it("does not let filler words such as 'of' carry a match: a Master of Science is not the Mathematics of Data Science", () => {
    // "master" matches nothing, so only "science" overlaps: 1 of 2 words is below 0.6.
    expect(matchProgram(map, "Master of Science")).toEqual({
      match: "none",
      nearest: ["Bachelor of Science in Computer Science", MDS_NAME],
    });
  });

  it("falls back to the raw words when the shortened query is empty, and never divides by zero", () => {
    const r = matchProgram(map, "Bachelor of");
    expect(r.match).toBe("many");
    expect(matchProgram(map, "!!!")).toEqual({ match: "none", nearest: [] });
    expect(matchProgram(map, "")).toEqual({ match: "none", nearest: [] });
    expect(matchProgram(new Map(), "Bachelor of")).toEqual({ match: "none", nearest: [] });
  });

  it("takes a map URL as given", () => {
    expect(matchProgram(map, "u/psy")).toEqual({ match: "one", url: "u/psy" });
  });
});
