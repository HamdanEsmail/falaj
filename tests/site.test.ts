// The visitor's page: what it says about the ten tools, and the form that runs a real tool.
import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bump, utcDay } from "../src/db/counters";
import { setToolStatus } from "../src/db/toolStatus";
import { PAGE_ORDER } from "../src/site/tools";
import { TRY_PER_MINUTE } from "../src/core/limits";
import { hashKey } from "../src/core/text";
import { callWorker } from "./helpers/app";
import { fetchMock } from "./helpers/fetch-mock";
import catalogueFixture from "./fixtures/uaeu/catalogue-index.json";
import hsrFixture from "./fixtures/uaeu/course-hsr140.json";

const FETCH_API = "https://api.fetch.tinyfish.ai";
const CATALOGUE_URL = "https://www.uaeu.ac.ae/en/catalog/courses/";
const HSR_URL = "https://www.uaeu.ac.ae/en/catalog/courses/course_2924.shtml?id=HSR140";
const cat = catalogueFixture.results[0]!;
const hsr = hsrFixture.results[0]!;

function registerTinyFetch(): void {
  const pages: Record<string, { text: string; links: string[] }> = {
    [CATALOGUE_URL]: { text: cat.text, links: cat.links },
    [HSR_URL]: { text: hsr.text, links: hsr.links },
  };
  fetchMock.intercept({
    url: FETCH_API,
    times: Infinity,
    reply: (_req, body) => {
      const results: unknown[] = [];
      const errors: unknown[] = [];
      for (const url of (body as { urls: string[] }).urls) {
        const page = pages[url];
        if (!page) errors.push({ url, error: "not_recorded" });
        else results.push({ url, final_url: url, title: null, text: page.text, links: page.links });
      }
      return Response.json({ results, errors });
    },
  });
}

function tinyFetchCalls() {
  return fetchMock.calls.filter((c) => c.url === `${FETCH_API}/`);
}

async function home(path = "/"): Promise<{ res: Response; html: string }> {
  const res = await callWorker(path);
  return { res, html: await res.text() };
}

async function ask(fields: Record<string, string>, ip = "203.0.113.9"): Promise<{ res: Response; html: string }> {
  const res = await callWorker("/try", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": ip },
    body: new URLSearchParams(fields).toString(),
  });
  return { res, html: await res.text() };
}

beforeEach(async () => {
  fetchMock.activate();
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  registerTinyFetch();
});
afterEach(() => fetchMock.reset());

describe("the page", () => {
  it("is one HTML page with my name on it, sent with a content security policy", async () => {
    const { res, html } = await home();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(html).toContain('<meta name="author" content="Hamdan Esmail"/>');
    expect(html).toContain('Built by <a href="https://github.com/HamdanEsmail" rel="author">Hamdan Esmail</a>');
    // The code is public, and the footer links it.
    expect(html).toContain('<a href="https://github.com/HamdanEsmail/falaj">GitHub</a>');
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    // Every script is a file of this site, and nothing carries a style attribute.
    expect(html.match(/<script(?![^>]*\ssrc="\/assets\/)[^>]*>/g)).toBeNull();
    expect(html).not.toMatch(/\sstyle="/);
  });

  it("gives the address an assistant is pointed at, with a button that copies it", async () => {
    const { html } = await home();
    expect(html).toContain("<code>https://falaj.test/mcp</code>");
    expect(html).toContain('data-copy="https://falaj.test/mcp"');
    expect(html).toContain("claude mcp add --transport http falaj https://falaj.test/mcp");
  });

  it("shows ten wells, one per tool, and says nothing about health before the first check", async () => {
    const { html } = await home();
    const wells = html.match(/<a class="well[^"]*" href="#[a-z_]+"/g) ?? [];
    expect(wells.map((w) => w.split("#")[1]!.replace('"', ""))).toEqual([...PAGE_ORDER]);
    expect(html).not.toContain('class="well dry"');
    // A tool nothing has checked yet is neither running nor stopped: its well is shown empty.
    expect(html.match(/class="well idle"/g)).toHaveLength(10);
    expect(html).toContain(">Is it running?</a>");
    expect(html).not.toContain("All ten are running");
  });

  it("counts only the tools that have answered, and leaves the others' wells empty", async () => {
    const at = new Date("2026-11-09T22:00:05Z");
    // What a health pass writes before the two browser reads exist: seven checked tools. health_check
    // has no page to check; it reads Falaj's own record, so it counts as running once a pass has run.
    const unread = ["get_faculty_profile", "get_academic_calendar", "health_check"];
    for (const tool of PAGE_ORDER.filter((t) => !unread.includes(t))) {
      await setToolStatus(env.DB, tool, "ok", null, at);
    }
    const { html } = await home();
    expect(html).toMatch(/<div class="tile">.*health_.*check.*Answers from Falaj&#39;s own record/s);
    expect(html).toContain(">Eight of ten are running</a>");
    expect(html).toContain("Eight of ten are running.</h2>");
    expect(html.match(/class="well idle"/g)).toHaveLength(2);
    expect(html).toContain('<a class="well idle" href="#get_faculty_profile"');
    expect(html).toMatch(/<div class="tile idle">.*calendar.*Not read yet/s);
  });

  it("says all ten are running once every tool has passed its check", async () => {
    const at = new Date("2026-11-09T22:00:05Z");
    for (const tool of PAGE_ORDER) await setToolStatus(env.DB, tool, "ok", null, at);
    const { html } = await home();
    expect(html).toContain(">All ten are running</a>");
    expect(html).toContain("All ten are running.</h2>");
    // 22:00 UTC is 02:00 in Al Ain.
    expect(html).toContain("Answered at 02:00");
  });

  it("shows a stopped tool as a dry well and a dry tile, with the reason", async () => {
    const at = new Date("2026-11-09T22:00:05Z");
    for (const tool of PAGE_ORDER) await setToolStatus(env.DB, tool, "ok", null, at);
    await setToolStatus(env.DB, "get_course", "broken", "credit hours not found on the course page", new Date("2026-11-10T22:00:07Z"));
    const { html } = await home();
    expect(html).toContain('<a class="well dry" href="#get_course"');
    expect(html.match(/class="well dry"/g)).toHaveLength(1);
    expect(html).toContain(">Nine of ten are running</a>");
    expect(html).toContain("Nine of ten are running.</h2>");
    expect(html).toMatch(/<div class="tile dry">.*get_.*course.*Stopped.*credit hours not found on the course page/s);
  });

  it("lists every tool with the arguments its schema takes", async () => {
    const { html } = await home();
    for (const tool of PAGE_ORDER) expect(html).toContain(`<details id="${tool}"`);
    const bar = (tool: string) => html.slice(html.indexOf(`<details id="${tool}"`)).split("</details>")[0]!;
    expect(bar("search_courses")).toMatch(/query<\/span>.*text, needed/s);
    expect(bar("search_courses")).toContain("college");
    expect(bar("search_courses")).toContain("limit");
    expect(bar("get_course")).toMatch(/code<\/span>.*text, needed/s);
    expect(bar("academic_deadlines")).toContain("Takes nothing");
  });

  it("works out what is left of the day's share", async () => {
    await bump(env.DB, "fetch_urls", 28, utcDay(new Date()));
    await bump(env.DB, "agent_reads", 3, utcDay(new Date()));
    const { html } = await home();
    expect(html).toMatch(/<span class="num">372<\/span>\s*<span class="unit">pages<\/span>/);
    expect(html).toMatch(/<span class="num">7<\/span>\s*<span class="unit">reads<\/span>/);
  });
});

describe("trying a tool on the page", () => {
  it("offers a form that shows it is working once pressed", async () => {
    const { html } = await home();
    expect(html).toContain('<form class="ask" method="post" action="/try#try">');
    expect(html).toContain('<input type="hidden" name="tool" value="search_courses"/>');
    expect(html).toMatch(/<button class="btn ink" type="submit" data-busy="Reading uaeu.ac.ae…">Ask the university<\/button>/);
    expect(html).toMatch(/<p class="wait" data-wait="true" hidden="">.*data-since=""/s);
    expect(html).toContain('<script src="/assets/wait.js" defer=""></script>');
  });

  it("switches the form to another tool from its tab", async () => {
    const { html } = await home("/?try=get_course");
    expect(html).toContain('<input type="hidden" name="tool" value="get_course"/>');
    expect(html).toContain('name="code"');
    expect(html).toContain('<a href="/?try=get_course#try" aria-current="true">Read a course</a>');
  });

  it("runs the real tool and shows the answer with where and when it was read", async () => {
    const { res, html } = await ask({ tool: "search_courses", query: "machine learning" });
    expect(res.status).toBe(200);
    // Six titles hold both words; twenty-one more hold one of them. The page shows the first eight.
    expect(html).toMatch(/<span class="num">27<\/span> courses/);
    expect(html).toContain("The first 8 are shown here.");
    // That one read is counted, and the count is told in plain words.
    expect(html).toContain("1 has been read since midnight UTC.");
    expect(html).toMatch(/<b>CSBP411<\/b>\s*<span>Machine Learning<\/span>/);
    expect(html).toContain(`Read from <a href="${CATALOGUE_URL}">`);
    expect(html).toContain("with TinyFish Fetch");
    expect(tinyFetchCalls()).toHaveLength(1);
    // What the visitor typed stays in the field, and the call is in the log like any other.
    expect(html).toContain('name="query" value="machine learning"');
    const logged = await env.DB.prepare("SELECT tool, status FROM calls").all<{ tool: string; status: string }>();
    expect(logged.results).toEqual([{ tool: "search_courses", status: "ok" }]);
  });

  it("reads one course", async () => {
    const { html } = await ask({ tool: "get_course", code: "hsr140" });
    expect(html).toContain("Introduction to Society &amp; Behavior");
    expect(html).toMatch(/Credit hours<\/span>\s*<span>3<\/span>/);
    expect(html).toContain(`Read from <a href="${HSR_URL.replace("&", "&amp;")}">`);
  });

  it("shows the tool's own error in plain words, and escapes what was typed", async () => {
    const { res, html } = await ask({ tool: "get_course", code: "ZZZZ999" });
    expect(res.status).toBe(200);
    expect(html).toContain('<div class="plate dry"');
    expect(html).toContain("No course ZZZZ999 in the UAEU catalogue");
    const typed = await ask({ tool: "search_courses", query: '<script>alert("x")</script>' });
    expect(typed.html).not.toContain('<script>alert("x")</script>');
    expect(typed.html).toContain("&lt;script&gt;");
  });

  it("refuses a tool that is not one of the three on the page, without reading anything", async () => {
    const { res, html } = await ask({ tool: "get_faculty_profile", profile_url: "https://www.uaeu.ac.ae/en/cit/profile.shtml?email=a.example@uaeu.ac.ae" });
    expect(res.status).toBe(400);
    expect(html).toContain("That tool cannot be tried on this page");
    expect(tinyFetchCalls()).toHaveLength(0);
  });

  it("stops one visitor after the page's questions a minute, without reading anything more", async () => {
    const first = await ask({ tool: "search_courses", query: "econ" }, "203.0.113.50");
    expect(first.res.status).toBe(200);
    // The visitor has used this minute's questions. The next minute is filled too, so the check
    // does not depend on the second the test runs in.
    const key = await hashKey("203.0.113.50");
    for (const at of [Date.now(), Date.now() + 60_000]) {
      await env.DB.prepare(
        "INSERT INTO rate (key_hash, bucket, count) VALUES (?, ?, ?) ON CONFLICT (key_hash, bucket) DO UPDATE SET count = excluded.count",
      )
        .bind(key, `tm:${new Date(at).toISOString().slice(0, 16)}`, TRY_PER_MINUTE)
        .run();
    }
    const before = tinyFetchCalls().length;
    const { res, html } = await ask({ tool: "search_courses", query: "econ" }, "203.0.113.50");
    expect(res.status).toBe(429);
    expect(html).toContain("Slow down");
    expect(tinyFetchCalls()).toHaveLength(before);
    // Another visitor is not held back by the first.
    const other = await ask({ tool: "search_courses", query: "econ" }, "203.0.113.51");
    expect(other.res.status).toBe(200);
  });
});
