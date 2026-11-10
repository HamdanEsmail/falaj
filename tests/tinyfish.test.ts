import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_MAX_DURATION_SECONDS, AGENT_MAX_STEPS } from "../src/core/limits";
import { PRICES } from "../src/core/spend";
import { getRun, startRun, stepsCost } from "../src/tinyfish/agent";
import { TinyFishError, tinyfishFetch } from "../src/tinyfish/client";
import { fetchPage, fetchPages } from "../src/tinyfish/fetch";
import { createMonitor, deleteMonitor, listMonitors, setMonitorStatus } from "../src/tinyfish/monitor";
import { searchSite } from "../src/tinyfish/search";
import { fetchMock } from "./helpers/fetch-mock";
import catalogueFixture from "./fixtures/uaeu/catalogue-index.json";
import refundsFixture from "./fixtures/uaeu/refunds.json";
import agentRunCalendar from "./fixtures/tinyfish/agent-run-calendar.json";
import monitorCreate from "./fixtures/tinyfish/monitor-create.json";
import searchFaculty from "./fixtures/tinyfish/search-faculty.json";

const FETCH_API = "https://api.fetch.tinyfish.ai";
const SEARCH_API = /^https:\/\/api\.search\.tinyfish\.ai\/\?/;
const RUN_ASYNC_API = "https://agent.tinyfish.ai/v1/automation/run-async";
const MONITORS_API = "https://agent.tinyfish.ai/v1/monitors";
const CATALOGUE_URL = "https://www.uaeu.ac.ae/en/catalog/courses/";
const REFUNDS_URL = "https://www.uaeu.ac.ae/en/dvcsae/student_account_office/refunds.shtml";

type SpendRow = { kind: string; amount_usd: number; ref: string };

async function spendRows(): Promise<SpendRow[]> {
  const { results } = await env.DB.prepare("SELECT kind, amount_usd, ref FROM spend ORDER BY at, rowid").all<SpendRow>();
  return results;
}

function callsTo(method: string, url: string) {
  return fetchMock.calls.filter((c) => c.method === method && c.url === new URL(url).href);
}

beforeEach(async () => {
  fetchMock.activate();
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
afterEach(() => fetchMock.reset());

describe("fetchPages", () => {
  it("fetchPages returns text and links aligned to the requested urls", async () => {
    fetchMock.intercept({ url: "https://api.fetch.tinyfish.ai", reply: { json: catalogueFixture } });
    const [r] = await fetchPages(env, [CATALOGUE_URL], { links: true });
    expect(r.ok && r.links.length).toBeGreaterThan(2000);
    expect(fetchMock.calls[0].body).toMatchObject({ format: "markdown", ttl: 3600, links: true });
    // Exactly these five keys, nothing else.
    expect(fetchMock.calls[0].body).toEqual({
      urls: [CATALOGUE_URL],
      format: "markdown",
      ttl: 3600,
      links: true,
      per_url_timeout_ms: 45000,
    });
    expect(r).toMatchObject({ ok: true, url: CATALOGUE_URL, finalUrl: CATALOGUE_URL, upstream_cached: null });
    expect(r.ok && r.text.length).toBeGreaterThan(1000);
  });

  it("sends the key, defaults links to false, and lets a caller pass ttl 0", async () => {
    fetchMock.intercept({
      url: FETCH_API,
      reply: (req) => {
        expect(req.headers.get("X-API-Key")).toBe("test-tinyfish-key");
        return Response.json(refundsFixture);
      },
      times: 2,
    });
    await fetchPages(env, [REFUNDS_URL], {});
    await fetchPages(env, [REFUNDS_URL], { ttl: 0 });
    expect(fetchMock.calls[0].body).toMatchObject({ links: false, ttl: 3600 });
    expect(fetchMock.calls[1].body).toMatchObject({ links: false, ttl: 0 });
  });

  it("fetchPages refuses more than 10 urls", async () => {
    await expect(fetchPages(env, Array(11).fill("https://www.uaeu.ac.ae/en/"), {})).rejects.toThrow(/10/);
    expect(fetchMock.calls).toHaveLength(0);
    expect(await spendRows()).toEqual([]);
  });

  it("a non-2xx becomes a TinyFishError and no spend row", async () => {
    fetchMock.intercept({
      url: FETCH_API,
      reply: { status: 500, json: { error: { code: "INTERNAL", message: "boom test-tinyfish-key" } } },
    });
    const err = await fetchPages(env, [CATALOGUE_URL], {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TinyFishError);
    expect(err).toMatchObject({ status: 500, code: "INTERNAL" });
    expect((err as Error).message).not.toContain("test-tinyfish-key");
    expect(await spendRows()).toEqual([]);
  });

  it("a 2xx appends one $0 fetch spend row for the whole batch", async () => {
    fetchMock.intercept({ url: FETCH_API, reply: { json: refundsFixture } });
    await fetchPages(env, [REFUNDS_URL], {});
    expect(await spendRows()).toEqual([{ kind: "fetch", amount_usd: 0, ref: REFUNDS_URL }]);
  });

  it("aligns results to the requested urls by url or final_url, whatever order TinyFish answers in", async () => {
    const a = "https://www.uaeu.ac.ae/en/a/";
    const b = "https://www.uaeu.ac.ae/en/b/";
    const c = "https://www.uaeu.ac.ae/en/c/";
    const page = (url: string, finalUrl: string, text: string) => ({
      url,
      final_url: finalUrl,
      title: `T ${text}`,
      text,
      links: [`${finalUrl}x`],
    });
    fetchMock.intercept({
      url: FETCH_API,
      reply: {
        json: {
          // Order differs from the request, and b was redirected.
          results: [page(c, c, "see"), page(a, a, "ay"), page("https://www.uaeu.ac.ae/en/b-old/", b, "bee")],
          errors: [],
        },
      },
    });
    const out = await fetchPages(env, [a, b, c], { links: true });
    expect(out.map((r) => r.url)).toEqual([a, b, c]);
    expect(out.map((r) => r.ok && r.text)).toEqual(["ay", "bee", "see"]);
    expect(out[1]).toMatchObject({ ok: true, finalUrl: b, title: "T bee", links: [`${b}x`] });
  });

  it("a url with no result becomes {ok:false}, with the per-url error text when TinyFish gave one", async () => {
    const a = "https://www.uaeu.ac.ae/en/a/";
    const b = "https://www.uaeu.ac.ae/en/b/";
    const c = "https://www.uaeu.ac.ae/en/c/";
    fetchMock.intercept({
      url: FETCH_API,
      reply: {
        json: {
          results: [{ url: a, final_url: a, title: null, text: "ay" }],
          errors: [{ url: b, error: "timeout" }],
        },
      },
    });
    const out = await fetchPages(env, [a, b, c], {});
    expect(out[0]).toMatchObject({ ok: true, text: "ay", title: null, links: [] });
    expect(out[1]).toEqual({ ok: false, url: b, error: "timeout" });
    expect(out[2]).toEqual({ ok: false, url: c, error: "no_result" });
  });

  it("reads an error object's code, and ignores a result without text", async () => {
    const a = "https://www.uaeu.ac.ae/en/a/";
    const b = "https://www.uaeu.ac.ae/en/b/";
    fetchMock.intercept({
      url: FETCH_API,
      reply: { json: { results: [{ url: b, final_url: b, text: null }], errors: [{ url: a, error: { code: "bot_blocked" } }] } },
    });
    const out = await fetchPages(env, [a, b], {});
    expect(out[0]).toEqual({ ok: false, url: a, error: "bot_blocked" });
    expect(out[1]).toEqual({ ok: false, url: b, error: "no_result" });
  });

  it("fetchPage is the first of fetchPages", async () => {
    fetchMock.intercept({ url: FETCH_API, reply: { json: refundsFixture } });
    const r = await fetchPage(env, REFUNDS_URL, { ttl: 0 });
    expect(r).toMatchObject({ ok: true, url: REFUNDS_URL });
    expect(fetchMock.calls[0].body).toMatchObject({ urls: [REFUNDS_URL], ttl: 0 });
  });

  it("upstream_cached is null: the 2026-11-03 probe found no cache indicator in a Fetch reply", async () => {
    fetchMock.intercept({ url: FETCH_API, reply: { json: refundsFixture } });
    expect((await fetchPages(env, [REFUNDS_URL], {}))[0]).toMatchObject({ ok: true, upstream_cached: null });
  });
});

describe("searchSite", () => {
  it("searchSite restricts to the domain and returns url/title/snippet", async () => {
    fetchMock.intercept({
      method: "GET",
      url: SEARCH_API,
      reply: (req) => {
        expect(req.headers.get("X-API-Key")).toBe("test-tinyfish-key");
        return Response.json(searchFaculty);
      },
    });
    const hits = await searchSite(env, "uaeu faculty", "uaeu.ac.ae");
    const sent = new URL(fetchMock.calls[0].url);
    expect(sent.searchParams.get("include_domains")).toBe("uaeu.ac.ae");
    expect(sent.searchParams.get("query")).toBe("uaeu faculty");
    expect(sent.searchParams.get("purpose")).toBe("find pages on a university website");
    expect(hits).toHaveLength(searchFaculty.results.length);
    expect(hits[0]).toEqual({
      url: "https://www.uaeu.ac.ae/en/catalog/uaeu-faculty-directory.shtml",
      title: "UAEU Faculty Directory",
      snippet: "",
    });
    expect(await spendRows()).toEqual([{ kind: "search", amount_usd: 0, ref: "uaeu.ac.ae" }]);
  });

  it("skips entries without a url, defaults a missing title and snippet to empty, and tolerates no results", async () => {
    fetchMock.intercept({
      url: SEARCH_API,
      reply: { json: { query: "x", results: [{ url: "https://www.uaeu.ac.ae/en/x" }, { title: "no url" }, null], total_results: 1, page: 0 } },
    });
    expect(await searchSite(env, "x", "uaeu.ac.ae")).toEqual([{ url: "https://www.uaeu.ac.ae/en/x", title: "", snippet: "" }]);
    fetchMock.intercept({ url: SEARCH_API, reply: { json: { query: "y" } } });
    expect(await searchSite(env, "y", "uaeu.ac.ae")).toEqual([]);
  });

  it("a non-2xx throws a TinyFishError", async () => {
    fetchMock.intercept({ url: SEARCH_API, reply: { status: 503, body: "down" } });
    await expect(searchSite(env, "x", "uaeu.ac.ae")).rejects.toBeInstanceOf(TinyFishError);
  });
});

describe("agent", () => {
  const params = {
    url: "https://www.uaeu.ac.ae/en/calendar/",
    goal: "Read the academic calendar",
    outputSchema: { type: "object", properties: { items: { type: "array" } } },
    webhookUrl: "https://falaj.test/api/webhooks/agent/test-secret",
  };

  it("startRun posts run-async with lite profile, max_steps 12 and the webhook url; getRun reads status and result", async () => {
    fetchMock.intercept({
      method: "POST",
      url: RUN_ASYNC_API,
      reply: (req) => {
        expect(req.headers.get("X-API-Key")).toBe("test-tinyfish-key");
        return Response.json({ run_id: agentRunCalendar.run_id });
      },
    });
    expect(await startRun(env, params)).toEqual({ runId: agentRunCalendar.run_id });
    expect(callsTo("POST", RUN_ASYNC_API)[0]!.body).toEqual({
      url: params.url,
      goal: params.goal,
      browser_profile: "lite",
      agent_config: { max_steps: AGENT_MAX_STEPS, max_duration_seconds: AGENT_MAX_DURATION_SECONDS },
      output_schema: params.outputSchema,
      webhook_url: params.webhookUrl,
    });
    expect(AGENT_MAX_STEPS).toBe(12);
    // Steps are billed when the run finishes, not at start.
    expect(await spendRows()).toEqual([]);

    const id = agentRunCalendar.run_id;
    fetchMock.intercept({
      method: "GET",
      url: `https://agent.tinyfish.ai/v1/runs/${id}?screenshots=none&html=none`,
      reply: (req) => {
        expect(req.headers.get("X-API-Key")).toBe("test-tinyfish-key");
        return Response.json(agentRunCalendar);
      },
    });
    expect(await getRun(env, id)).toEqual({
      status: "COMPLETED",
      result: agentRunCalendar.result,
      num_of_steps: 4,
      error: null,
    });

    fetchMock.intercept({
      method: "GET",
      url: "https://agent.tinyfish.ai/v1/runs/r2?screenshots=none&html=none",
      reply: { json: { run_id: "r2", status: "FAILED", error: "step limit" } },
    });
    expect(await getRun(env, "r2")).toEqual({ status: "FAILED", result: null, num_of_steps: null, error: "step limit" });
    expect(await spendRows()).toEqual([]);
  });

  it("startRun does not retry a 429: it surfaces a TinyFishError after one call", async () => {
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: { status: 429, body: "slow down" }, times: 3 });
    const err = await startRun(env, params).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TinyFishError);
    expect(err).toMatchObject({ status: 429 });
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(1);
  });

  it("startRun throws no_run_id when TinyFish accepts the run but returns no run_id", async () => {
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: { json: {} } });
    await expect(startRun(env, params)).rejects.toMatchObject({ code: "no_run_id" });
  });

  it("stepsCost is steps times the agent_step price", () => {
    expect(stepsCost(0)).toBe(0);
    expect(stepsCost(4)).toBeCloseTo(4 * PRICES.agent_step, 10);
    expect(stepsCost(12)).toBeCloseTo(0.192, 10);
  });
});

describe("monitor", () => {
  const params = {
    url: CATALOGUE_URL,
    name: "Falaj course catalogue",
    scheduleCron: "7 1,13 * * *",
    purpose: "Tell me when the course catalogue index changes",
    webhookUrl: "https://falaj.test/api/webhooks/monitor/test-secret",
  };

  it("createMonitor returns monitorId and the baseline text and records one monitor_check", async () => {
    fetchMock.intercept({ method: "POST", url: MONITORS_API, reply: { status: 201, json: monitorCreate } });
    const out = await createMonitor(env, params);
    expect(out.monitorId).toBe(monitorCreate.monitor.id);
    expect(out.baselineRunId).toBe(monitorCreate.run.id);
    expect(out.baselineText).toBe(monitorCreate.run.results[0]!.text);
    expect(callsTo("POST", MONITORS_API)[0]!.body).toEqual({
      type: "fetch",
      name: params.name,
      config: { url: CATALOGUE_URL, format: "markdown" },
      schedule_cron: params.scheduleCron,
      purpose: params.purpose,
      webhook_url: params.webhookUrl,
    });
    expect(await spendRows()).toEqual([{ kind: "monitor_check", amount_usd: 0.005, ref: CATALOGUE_URL }]);
  });

  it("createMonitor deletes the new monitor and throws baseline_failed when the baseline has no text", async () => {
    const id = monitorCreate.monitor.id;
    const failed = { ...monitorCreate, run: { ...monitorCreate.run, results: [], errors: [{ url: CATALOGUE_URL, error: "bot_blocked" }] } };
    fetchMock.intercept({ method: "POST", url: MONITORS_API, reply: { status: 201, json: failed } });
    fetchMock.intercept({ method: "DELETE", url: `${MONITORS_API}/${id}`, reply: { status: 200, json: {} } });
    const err = await createMonitor(env, params).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TinyFishError);
    expect(err).toMatchObject({ code: "baseline_failed" });
    expect(callsTo("DELETE", `${MONITORS_API}/${id}`)).toHaveLength(1);
  });

  it("setMonitorStatus sends {status} alone", async () => {
    const url = `${MONITORS_API}/m1`;
    fetchMock.intercept({ method: "PATCH", url, reply: { json: {} }, times: 2 });
    await setMonitorStatus(env, "m1", "paused");
    await setMonitorStatus(env, "m1", "active");
    expect(callsTo("PATCH", url).map((c) => c.body)).toEqual([{ status: "paused" }, { status: "active" }]);
    expect(await spendRows()).toEqual([]);
  });

  it("deleteMonitor treats a 404 as already deleted and surfaces other failures", async () => {
    const url = `${MONITORS_API}/gone`;
    fetchMock.intercept({ method: "DELETE", url, reply: { status: 404, json: { error: { code: "NOT_FOUND" } } } });
    await expect(deleteMonitor(env, "gone")).resolves.toBeUndefined();
    fetchMock.intercept({ method: "DELETE", url, reply: { status: 500, body: "boom" } });
    await expect(deleteMonitor(env, "gone")).rejects.toMatchObject({ status: 500 });
  });

  it("listMonitors maps the account's monitors to id, status and name", async () => {
    fetchMock.intercept({
      method: "GET",
      url: MONITORS_API,
      reply: { json: { monitors: [monitorCreate.monitor, { id: "m2", status: "paused", name: null, config: {} }, { nope: true }] } },
    });
    expect(await listMonitors(env)).toEqual([
      { id: monitorCreate.monitor.id, status: monitorCreate.monitor.status, name: monitorCreate.monitor.name },
      { id: "m2", status: "paused", name: null },
    ]);
  });
});

describe("tinyfishFetch", () => {
  it("keeps whatever the response echoes (a rejected webhook url with its secret) out of the error message", async () => {
    const webhook = `https://falaj.test/api/webhooks/monitor/${env.WEBHOOK_SECRET}`;
    const echoes = [
      { status: 400, json: { error: { code: "INVALID_WEBHOOK_URL", message: `webhook_url ${webhook} is not allowed` } } },
      { status: 400, json: { error: `rejected ${webhook}` } },
      { status: 502, body: `<html>upstream saw ${webhook} and test-tinyfish-key</html>` },
    ];
    const messages: string[] = [];
    for (const reply of echoes) {
      fetchMock.intercept({ method: "POST", url: MONITORS_API, reply });
      const err = await tinyfishFetch(env, MONITORS_API, { method: "POST", body: JSON.stringify({ webhook_url: webhook }) }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(TinyFishError);
      messages.push((err as Error).message);
    }
    expect(messages).toEqual([
      "TinyFish HTTP 400 INVALID_WEBHOOK_URL",
      "TinyFish HTTP 400 http_400",
      "TinyFish HTTP 502 http_502",
    ]);
    expect(messages.join("\n")).not.toContain(env.WEBHOOK_SECRET);
    expect(messages.join("\n")).not.toContain("test-tinyfish-key");
  });
});
