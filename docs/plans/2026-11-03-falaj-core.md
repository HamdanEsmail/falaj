# Falaj Core (MCP server, tools, canaries, Monitors, read API) Implementation Plan

> Work through this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Falaj's remote MCP server on one Cloudflare Worker: ten typed tools over UAEU's public website (TinyFetch, TinySearch and cached TinyAgent reads underneath), a fixed error contract, nightly canaries with per-tool status, two TinyFish Monitors with a webhook, the call log, caps and budget pause, and the JSON read API the Console site will use, ready to deploy and add to Claude Code.

**Architecture:** A Hono app on Cloudflare Workers with D1. `POST /mcp` builds an `McpServer` per request and answers through the MCP SDK's web-standard Streamable HTTP transport in stateless JSON mode. Every tool is one `ToolDef` (zod input, zod output, a `run` function) registered from one list, so `tools/list`, the error wrapper, the call log and `GET /api/tools` all come from the same definitions. Fetch- and Search-backed tools call TinyFish on every invocation; Agent-backed tools serve the `agent_cache` table and start at most one capped Agent run through a pending-row state machine. Cron runs the nightly canaries and the weekly calendar read; Monitor webhooks on the two catalogue indexes trigger the canaries at once.

**Tech Stack:** TypeScript (ESM, strict), Hono 4.13.16, `@modelcontextprotocol/sdk` 1.32.2, zod 4.6.7, Cloudflare Workers + D1 + Cron Triggers, Vitest 5.1.0 with `@cloudflare/vitest-plugin` 1.5.0, Wrangler 4.156.2. Same conventions as the sibling repo `../fineprint`; where Fineprint already has a tested module with the same job, copy it in and adapt rather than rewrite: `src/tinyfish/{client,fetch,search,agent,monitor}.ts`, `src/core/spend.ts`, `src/auth.ts`, `tests/helpers/{fetch-mock,app}.ts`, `vitest.config.ts`, `tests/setup.ts`, `tsconfig.json`, `.github/workflows/check.yml`.

**Spec:** `docs/specs/2026-11-03-falaj-design.md`. Read it first; this plan argues from it. Spike scripts and real responses are in `../spikes/` (`spike-mcp-sites.mjs`, `out/uaeu-pages.json` for page text, `out/mcp-sites.json` for Search results, `out/uaeu-calendar-agent.json` for the one Agent run). `DESIGN.md`, `design/tokens.css` and `design/PRINCIPLES.md` are already in this repo; the site itself is a second plan.

## Global Constraints

- Node `>=24`, `"type": "module"`, `"private": true`, exact version pins (`npm view <pkg> version`). `npm run check` = `tsc --noEmit && vitest run && wrangler deploy --dry-run`, green at the end of every task.
- Secrets only via Worker secrets / `.dev.vars`: `TINYFISH_API_KEY`, `ADMIN_TOKEN`, `WEBHOOK_SECRET`. `.dev.vars.example` lists all three. The key is read in `src/tinyfish/client.ts` and nowhere else; it never appears in a log, an error, a fixture or a commit.
- Transport: the MCP SDK's `WebStandardStreamableHTTPServerTransport` (`@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js`) with `sessionIdGenerator: undefined` (stateless) and `enableJsonResponse: true`, one transport and one `McpServer` per request, `transport.handleRequest(c.req.raw)`. The design named `@hono/mcp`; it is a thin wrapper over this same class with an extra peer dependency, so the plan uses the SDK directly (decided on 3 November, noted in the spec's section 10). Fallback order if two stateless `initialize` round trips fail under `wrangler dev`: `@hono/mcp` 0.3.5, then Cloudflare `agents` 0.32.0 `McpAgent`; record the switch in `docs/build-log.md`.
- Stateless mode means clients never receive an `Mcp-Session-Id`, so the per-caller key is `cf-connecting-ip` alone (`"anon"` when absent); a client-sent `Mcp-Session-Id` is never a rate key, only stored hashed as `session_hash` in the call log row (decided 2026-11-03). Never try to make the transport stateful.
- People in the repo: fixtures, tests and docs carry no real person's name or email local part. Use placeholders (for example "Dr. Amal Example" and `a.example@uaeu.ac.ae`), keep real URL shapes and college path segments, and mark a pseudonymized fixture with a top-level `"_note"` field saying names and local parts are placeholders. Academic leadership only after I have checked each name (decided 2026-11-03).
- Tool names, exactly: `search_courses`, `get_course`, `list_programs`, `get_program`, `list_events`, `academic_deadlines`, `find_faculty`, `get_faculty_profile`, `get_academic_calendar`, `health_check`. Every tool: `annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true }`, an `inputSchema` and an `outputSchema`, a description that includes one example call.
- Every success carries `source_url`, `read_at` (ISO), `method` (`fetch` | `search` | `agent_cached`), `cached` (boolean); Fetch-backed results also carry `ttl_seconds: 3600`. Error codes, exactly: `NOT_FOUND | SITE_CHANGED | RATE_LIMITED | BUDGET_PAUSED | UPSTREAM_TIMEOUT | INVALID_INPUT`; an error is `isError: true` with a JSON text body `{code, message, fix?, retry_after_seconds?, scope?, source_url?, near_matches?}`. Nothing else is ever returned on failure.
- Constants in `src/core/limits.ts`: `AGENT_MAX_STEPS = 12`, `AGENT_MAX_DURATION_SECONDS = 160`, `AGENT_SLOTS = 1`, `AGENT_READS_PER_DAY = 10`, `AGENT_PENDING_TIMEOUT_MS = 300_000`, `AGENT_ETA_SECONDS = 90`, `FETCH_URLS_PER_DAY = 400`, `FETCH_TTL_SECONDS = 3600`, `FETCH_BATCH_MAX = 10`, `CALLER_PER_MINUTE = 120`, `CALLER_PER_DAY = 2000`, `BUDGET_SHARE_USD = 3.5`, `BUDGET_PAUSE_USD = 3.0`, `CALENDAR_REFRESH_DAYS = 7`, `PROFILE_CACHE_DAYS = 7`, `STALE_DAYS = 14`, `MAX_MONITORS = 2`, `RESULT_LIMIT_DEFAULT = 20`, `RESULT_LIMIT_MAX = 50`, `ARGS_ABBREV_CHARS = 80`, `CANARY_SLOW_MS = 20_000`.
- Prices in `src/core/spend.ts`: `agent_step 0.016`, `monitor_check 0.005`, `fetch 0`, `search 0`.
- Every TinyFish call goes through `src/tinyfish/client.ts`. Only Fetch and Search run inside a tool call; an Agent run is never awaited in a tool's request path. At most one Agent run in flight, ever (shared account concurrency).
- Live calls allowed during the build without checking the account first: free TinyFetch and TinySearch calls, only for `scripts/record-fixtures.mjs` (six URLs) and the manual checks named in a task, kept under 60 URLs in total and logged with a running count in `docs/build-log.md`. TinyAgent, TinyBrowser, Monitor creation, deploy, remote D1 creation and the first real MCP client call wait until I have checked the wallet and what the other builds are running. The two paused spike monitors on the account are never touched.
- GitHub push is allowed at any time; the repo exists and `origin` is set.

## Cases the tests must not miss

1. A course page carries the requested course and the next one (HSR140 and HSR150 on the recorded page). `get_course("HSR140")` must return only HSR140's description, credit hours and outcomes. Test in Task 3.
2. `get_program("Bachelor of Science")` matches several programmes. It must return `NOT_FOUND` with `near_matches` listing them, never the first one. Test in Task 4.
3. A second `get_faculty_profile` call for a URL whose read is `pending` must return `{status: "reading"}` and start no Agent run, and a pending row older than 5 minutes must become `failed` and free the slot. Test in Task 6.
4. A webhook with the wrong secret answers 401 and changes nothing; a `changed` webhook for a monitor id not in the `monitors` table answers 200 and changes nothing. Test in Task 9.
5. While a tool is `broken`, calling it returns `SITE_CHANGED` with the page URL and the canary detail without any TinyFish call. Test in Task 8.

---

## File Structure

```
falaj/
  package.json  tsconfig.json  wrangler.jsonc  vitest.config.ts  .dev.vars.example  LICENSE  README.md
  DESIGN.md  design/tokens.css  design/PRINCIPLES.md     (already present)
  migrations/0001_init.sql
  src/index.ts                         Hono wiring (routes, /mcp, api, webhooks, admin) + scheduled export
  src/env.ts                           Env bindings
  src/core/limits.ts  spend.ts  errors.ts (ToolError, ErrorCode)  dates.ts (academic years, calendar dates)  text.ts (maskEmails, abbrev, hashKey, slugToName)
  src/tinyfish/client.ts  fetch.ts  search.ts  agent.ts  monitor.ts
  src/db/calls.ts  toolStatus.ts  agentCache.ts  canaryRuns.ts  monitors.ts  rate.ts  programMap.ts  spend (in core)
  src/parsers/catalogue.ts  course.ts  program.ts  events.ts  deadlines.ts  calendar.ts  faculty.ts
  src/tools/types.ts  envelope.ts  registry.ts
  src/tools/search-courses.ts  get-course.ts  list-programs.ts  get-program.ts  list-events.ts
            academic-deadlines.ts  find-faculty.ts  get-faculty-profile.ts  get-academic-calendar.ts  health-check.ts
  src/mcp/server.ts                    buildServer(env, ctx, callerKey): McpServer with every ToolDef registered through the wrapper
  src/mcp/route.ts                     POST /mcp (caller key, rate limit, transport), GET /mcp → 405 + install JSON
  src/agent/reads.ts                   requestProfileRead, requestCalendarRead, finalizeRun, slot + cap + pending timeout
  src/health/canaries.ts  run.ts       the fixtures per tool, runCanaries(trigger)
  src/handlers/api.ts  webhooks.ts  admin.ts
  src/cron.ts
  scripts/record-fixtures.mjs  scripts/mcp-smoke.mjs
  tests/fixtures/uaeu/*.json  tests/fixtures/tinyfish/*.json  tests/fixtures/webhooks/*.json
  tests/helpers/fetch-mock.ts  app.ts  mcp.ts     tests/*.test.ts
  docs/build-log.md  docs/runbook.md
  .github/workflows/check.yml
```

---

### Task 1: Scaffold, schema, MCP endpoint, statelessness check

**Files:**
- Create: `package.json`, `tsconfig.json`, `wrangler.jsonc`, `vitest.config.ts`, `tests/setup.ts`, `tests/helpers/app.ts`, `tests/helpers/mcp.ts`, `.dev.vars.example`, `LICENSE`, `migrations/0001_init.sql`, `src/env.ts`, `src/index.ts`, `src/core/limits.ts`, `src/core/spend.ts`, `src/core/errors.ts`, `src/auth.ts`, `src/tools/types.ts`, `src/tools/envelope.ts`, `src/tools/registry.ts`, `src/tools/health-check.ts` (stub), `src/mcp/server.ts`, `src/mcp/route.ts`, `docs/build-log.md`, `.github/workflows/check.yml`
- Test: `tests/smoke.test.ts`, `tests/mcp.test.ts`

**Interfaces:**
- Produces `Env = { DB: D1Database; TINYFISH_API_KEY: string; ADMIN_TOKEN: string; WEBHOOK_SECRET: string; PUBLIC_BASE_URL: string }` (no R2: nothing in Falaj stores binaries).
- Produces in `src/core/errors.ts`: `type ErrorCode = "NOT_FOUND" | "SITE_CHANGED" | "RATE_LIMITED" | "BUDGET_PAUSED" | "UPSTREAM_TIMEOUT" | "INVALID_INPUT"`; `class ToolError extends Error { code: ErrorCode; fix?: string; retry_after_seconds?: number; scope?: "caller" | "global"; source_url?: string; near_matches?: string[] }` with `toBody(): Record<string, unknown>` (`{code, message, ...the defined optionals}`).
- Produces in `src/tools/types.ts`: `type Method = "fetch" | "search" | "agent_cached" | "status"` (`status` is used by `health_check` only); `type ToolContext = { env: Env; ctx: ExecutionContext; callerKey: string; now: Date }`; `type ToolDef<I extends z.ZodRawShape, O extends z.ZodRawShape> = { name: ToolName; title: string; description: string; input: I; output: O; run(args: z.infer<z.ZodObject<I>>, t: ToolContext): Promise<z.infer<z.ZodObject<O>>> }`; `defineTool(def)` identity helper; `ToolName` union of the ten names.
- Produces in `src/tools/envelope.ts`: `const ENVELOPE = { source_url: z.string(), read_at: z.string(), method: z.enum(["fetch","search","agent_cached","status"]), cached: z.boolean(), ttl_seconds: z.number().optional() }` (spread into every output shape) and `stamp<T>(data: T, meta: { source_url: string; method: Method; cached: boolean; read_at?: Date; ttl_seconds?: number }): T & Envelope`.
- Produces in `src/tools/registry.ts`: `export const TOOLS: readonly ToolDef<any, any>[]` (Task 1: `health_check` only; later tasks append) and `toolByName(name)`.
- Produces in `src/mcp/server.ts`: `buildServer(env: Env, ctx: ExecutionContext, callerKey: string): McpServer` (name `falaj`, version from package.json). The wrapper around each `run`: validates with zod (a zod failure → `INVALID_INPUT`), on success returns `{ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result }`, on `ToolError` returns `{ isError: true, content: [{ type: "text", text: JSON.stringify(err.toBody()) }] }`, on any other error returns `UPSTREAM_TIMEOUT` with `retry_after_seconds: 30` when the cause is a `TinyFishError` or a timeout, else rethrows. Task 7 adds the call log and the gate here; leave a single `runTool(def, args, t)` function for it.
- Produces in `src/mcp/route.ts`: `mcpRouter` mounting `POST /mcp` (new transport per request, `sessionIdGenerator: undefined`, `enableJsonResponse: true`, `await server.connect(transport)`, `return transport.handleRequest(c.req.raw)`) and `GET /mcp` → 405 JSON `{ error: "use POST", install: { claude_code: "claude mcp add --transport http falaj <base>/mcp", cursor: {...}, mcp_remote: "npx mcp-remote <base>/mcp" } }`.
- Produces `recordSpend`, `PRICES`, `totalSpend(db)`, `spendByKind(db)` (copy from Fineprint); `isAdmin`, `adminOnly` (copy).
- Produces `tests/helpers/mcp.ts`: `rpc(method: string, params?: unknown, id?: number): Promise<{ status: number; headers: Headers; body: any }>` posting `{jsonrpc: "2.0", id, method, params}` to `/mcp` through `callWorker` with `Accept: application/json, text/event-stream`; `callTool(name: string, args: unknown)` = `rpc("tools/call", { name, arguments: args })` returning `body.result`; `listTools()`.
- Schema (`migrations/0001_init.sql`): spec section 5 with these exact columns: `calls(id TEXT PK, tool, args_abbrev, ms INTEGER, status, error_code, key_hash, at)`; `tool_status(tool TEXT PK, status, detail, last_ok_at, last_checked_at)`; `agent_cache(url TEXT PK, kind, status ('pending'|'ok'|'failed'), data TEXT, read_at, run_id, started_at, error, spend_usd REAL)`; `canary_runs(id TEXT PK, at, trigger, results TEXT, duration_ms INTEGER)`; `monitors(page TEXT PK, monitor_id, url, last_check_at, last_outcome, site_changed_at)`; `spend(id TEXT PK, kind, amount_usd REAL, ref, at)`; `rate(key_hash TEXT, bucket TEXT, count INTEGER, PRIMARY KEY(key_hash, bucket))`; `program_map(url TEXT PK, name, college, kind, built_at)`; indexes on `calls(at)`, `calls(tool, at)`, `agent_cache(kind, read_at)`, `spend(at)`.
- `wrangler.jsonc`: `name: "falaj"`, `main: "src/index.ts"`, `compatibility_date: "2026-09-01"`, D1 binding `DB` (`database_name: "falaj"`, `database_id: "TBD-after-create"`, `migrations_dir`), `triggers.crons: ["0 22 * * *", "0 21 * * 0"]` (nightly canaries; weekly calendar read on Sunday one hour earlier), `vars.PUBLIC_BASE_URL`, `observability.enabled: true`. No R2 binding.
- `package.json` deps: `hono 4.13.16`, `@modelcontextprotocol/sdk 1.32.2`, `zod 4.6.7`; dev: `@cloudflare/vitest-plugin 1.5.0`, `@cloudflare/workers-types 5.20261103.1`, `typescript 7.0.2`, `vitest 5.1.0`, `wrangler 4.156.2`. Scripts as Fineprint plus `"health": "node scripts/mcp-smoke.mjs"` (added in Task 10).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/smoke.test.ts
it("GET /api/stats returns zero counts and spend", async () => {
  const res = await callWorker("/api/stats");
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ calls: 0, spend_usd: 0, budget_share_usd: 3.5 });
});
it("admin route rejects a missing token", async () => {
  expect((await callWorker("/api/admin/ping", { method: "POST" })).status).toBe(401);
});
it("GET /mcp is 405 with install instructions", async () => {
  const res = await callWorker("/mcp");
  expect(res.status).toBe(405);
  expect((await res.json()).install.claude_code).toContain("claude mcp add --transport http falaj");
});

// tests/mcp.test.ts
it("initialize answers JSON without a session id", async () => {
  const r = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  expect(r.status).toBe(200);
  expect(r.headers.get("mcp-session-id")).toBeNull();
  expect(r.body.result.serverInfo.name).toBe("falaj");
});
it("tools/list works with no prior initialize (stateless) and lists health_check with annotations and schemas", async () => {
  const tools = await listTools();
  const hc = tools.find((t: any) => t.name === "health_check");
  expect(hc.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true, destructiveHint: false });
  expect(hc.inputSchema.type).toBe("object");
  expect(hc.outputSchema.type).toBe("object");
});
it("tools/call for an unknown tool name is a JSON-RPC error", async () => {
  const r = await rpc("tools/call", { name: "no_such_tool", arguments: {} });
  expect(typeof r.body.error.code).toBe("number");
});
```

(`INVALID_INPUT` is asserted in Task 4, where the first typed input exists.)

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/smoke.test.ts tests/mcp.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Create the scaffold, the schema, the tool types, the registry with the `health_check` stub (returns `{checked_at, tools: {}, monitors: []}` for now), `buildServer`, `mcpRouter`, `/api/stats` (`calls`, `spend_usd`, `budget_share_usd`, `budget_pause_usd`, `fetch_urls_today`, `agent_reads_today`), and the admin ping**

Copy `vitest.config.ts`, `tests/setup.ts`, `tests/helpers/app.ts`, `tsconfig.json` and `.github/workflows/check.yml` from `../fineprint`, changing names and the fixed test bindings (`PUBLIC_BASE_URL: "https://falaj.test"`), and dropping the R2 binding and the live-key block (Falaj has no live test in this plan).

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/smoke.test.ts tests/mcp.test.ts`
Expected: PASS

- [ ] **Step 5: Statelessness check under wrangler dev**

Run `npx wrangler dev` in one terminal; in another, send `initialize` then `tools/list` twice as separate `curl -X POST http://localhost:8787/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '...'` calls with no session header. Expected: four 200 JSON answers, `tools/list` names `health_check`. If either `tools/list` is rejected for a missing session, apply the fallback order from Global Constraints. Write the outcome (transport used, the four status codes) as the first entry of `docs/build-log.md`.

- [ ] **Step 6: `npm run check`, commit**

```bash
git add -A && git commit -m "feat: scaffold Worker, D1 schema, stateless MCP endpoint, tool registry, smoke tests"
```

---

### Task 2: TinyFish clients, fetch mock, recorded fixtures

**Files:**
- Create: `src/tinyfish/client.ts`, `src/tinyfish/fetch.ts`, `src/tinyfish/search.ts`, `src/tinyfish/agent.ts`, `src/tinyfish/monitor.ts`, `tests/helpers/fetch-mock.ts`, `scripts/record-fixtures.mjs`, `tests/fixtures/uaeu/{catalogue-index,course-hsr140,programs-index,program-mds,events,refunds}.json`, `tests/fixtures/tinyfish/{search-faculty,agent-run-calendar,monitor-create}.json`
- Test: `tests/tinyfish.test.ts`

**Interfaces:**
- Consumes `tinyfishFetch`, `TinyFishError` (copied from Fineprint unchanged), `recordSpend`.
- Produces `fetchPages(env, urls: string[], opts: { links?: boolean; ttl?: number }): Promise<FetchPageResult[]>` in `fetch.ts`: one `POST https://api.fetch.tinyfish.ai` with `{ urls, format: "markdown", ttl: opts.ttl ?? FETCH_TTL_SECONDS, links: opts.links ?? false, per_url_timeout_ms: 45000 }`, at most `FETCH_BATCH_MAX` URLs (throw on more), results aligned to `urls` by `url`/`final_url`; `FetchPageResult = { ok: true; url: string; finalUrl: string; title: string | null; text: string; links: string[] } | { ok: false; url: string; error: string; status?: number }`. Also `fetchPage(env, url, opts)` = first of `fetchPages`. Both pass through an `upstream_cached: boolean | null` field when the response carries any cache indicator (probe in Step 4; `null` when it carries none).
- Produces `searchSite(env, query: string, domain: "uaeu.ac.ae"): Promise<{ url: string; title: string; snippet: string }[]>` in `search.ts` (purpose `"find pages on a university website"`).
- Produces in `agent.ts`: `startRun(env, p: { url: string; goal: string; outputSchema: object; webhookUrl: string }): Promise<{ runId: string }>` (`run-async`, `browser_profile: "lite"`, `agent_config: { max_steps: AGENT_MAX_STEPS, max_duration_seconds: AGENT_MAX_DURATION_SECONDS }`, no retry loop: a 429 is surfaced as `TinyFishError` and the caller answers `RATE_LIMITED scope global`), `getRun(env, runId): Promise<AgentRun>` with `AgentRun = { status: string; result: unknown; num_of_steps: number | null; error: string | null }`, and `stepsCost(n: number) = n * PRICES.agent_step`.
- Produces in `monitor.ts` (copied): `createMonitor`, `setMonitorStatus`, `deleteMonitor`, `listMonitors`.
- Produces `fetchMock` (copied) and the six UAEU fixtures as the full TinyFetch response objects (`{ results: [...], errors: [] }`), which later tests feed back through `fetchMock` unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/tinyfish.test.ts
it("fetchPages returns text and links aligned to the requested urls", async () => {
  fetchMock.intercept({ url: "https://api.fetch.tinyfish.ai", reply: { json: catalogueFixture } });
  const [r] = await fetchPages(env, [CATALOGUE_URL], { links: true });
  expect(r.ok && r.links.length).toBeGreaterThan(2000);
  expect(fetchMock.calls[0].body).toMatchObject({ format: "markdown", ttl: 3600, links: true });
});
it("fetchPages refuses more than 10 urls", async () => {
  await expect(fetchPages(env, Array(11).fill("https://www.uaeu.ac.ae/en/"), {})).rejects.toThrow(/10/);
});
it("a non-2xx becomes a TinyFishError and no spend row", async () => { /* 500 reply → rejects with TinyFishError; spend count 0 */ });
it("searchSite restricts to the domain and returns url/title/snippet", async () => { /* intercept GET api.search.tinyfish.ai; assert include_domains=uaeu.ac.ae in the URL */ });
it("startRun posts run-async with lite profile, max_steps 12 and the webhook url; getRun reads status and result", async () => { /* fixtures/tinyfish/agent-run-calendar.json */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/tinyfish.test.ts`
Expected: FAIL

- [ ] **Step 3: Write `scripts/record-fixtures.mjs` and run it once**

The script reads `TINYFISH_API_KEY` from `.dev.vars` (never from the shell), sends one `POST https://api.fetch.tinyfish.ai` with `format: "markdown"`, `links: true`, `ttl: 0` for exactly these six URLs, and writes each result as its own file under `tests/fixtures/uaeu/`:

```
https://www.uaeu.ac.ae/en/catalog/courses/                                   → catalogue-index.json
https://www.uaeu.ac.ae/en/catalog/courses/course_2924.shtml?id=HSR140        → course-hsr140.json
https://www.uaeu.ac.ae/en/catalog/undergraduate/programs/                    → programs-index.json
https://www.uaeu.ac.ae/en/catalog/undergraduate/programs/bachelor-of-science-in--the-mathematics-of-data-science.shtml → program-mds.json
https://www.uaeu.ac.ae/en/events/                                            → events.json
https://www.uaeu.ac.ae/en/dvcsae/student_account_office/refunds.shtml        → refunds.json
```

Each file is `{ results: [<that result>], errors: [] }` so a test can hand it to `fetchMock` as a whole TinyFetch reply. Log "6 Fetch URLs, $0" in `docs/build-log.md`. Build `tests/fixtures/tinyfish/search-faculty.json` from `../spikes/out/mcp-sites.json` ("uaeu faculty" entry, wrapped as `{ results: [{url,title,snippet:""}] }`) and `agent-run-calendar.json` from `../spikes/out/uaeu-calendar-agent.json` (whole run object). Copy `monitor-create.json` from Fineprint's fixtures.

- [ ] **Step 4: Implement the clients; probe the cache indicator**

In the recorded responses, look for any field that says the result came from TinyFish's cache (`cached`, `cache_hit`, `from_cache`, or an `age` header). If one exists, map it to `upstream_cached`; if none, set `upstream_cached: null` and write one line in `docs/build-log.md` saying so.

- [ ] **Step 5: Run to verify they pass; `npm run check`; commit**

```bash
git add -A && git commit -m "feat: TinyFish clients, fetch mock, recorded UAEU fixtures"
```

---

### Task 3: Catalogue parsers (pure functions on the fixtures)

**Files:**
- Create: `src/parsers/catalogue.ts`, `src/parsers/course.ts`, `src/parsers/program.ts`, `src/core/text.ts`
- Test: `tests/parsers-catalogue.test.ts`

**Interfaces:**
- Produces `parseCatalogue(text: string, links: string[]): { colleges: { college: string; courses: { code: string; title: string; url: string | null }[] }[]; courseMap: Map<string, string> }`. Lines are `+ CODE : Title` under `## <College>` headings (the first item of a list reads `* + ECON105 : …`); the code class is `^[A-Z]{2,5}\d{3,4}[A-Z]?$`; `courseMap` is keyed by the `id` query parameter of every link matching `/en/catalog/courses/course_\d+\.shtml?id=<CODE>`, never by link text.
- Produces `parseCoursePage(text: string, code: string): { code; title; description; credit_hours: number | null; learning_outcomes: string[]; prerequisites: string[] } | null`. Finds the `# <Title> (<CODE>)` heading whose code equals `code` and reads only until the next `# ` heading or an Arabic `### عفوا` line; `null` when the heading is absent. `prerequisites` from a line starting `Prerequisite` or `Pre-requisite` when present, else `[]`.
- Produces `parseProgramIndex(links: string[]): string[]` (unique links matching `/en/catalog/undergraduate/programs/<slug>.shtml`, in page order) and `parseProgramPage(text: string): { name; college: string | null; credit_hours: number | null; description; objectives: string[]; degree_plan: { code: string; title: string; credit_hours: number | null }[] }`. `name` is the first `## ` heading; `college` is the college named in the "hosted by the Department of …, <COLLEGE ABBREV or name>" sentence when present (map `COS` → College of Science, `CIT` → College of Information Technology, `CBE` → College of Business and Economics, `CHSS` → College of Humanities and Social Sciences, `CEDU` → College of Education, `COE` → College of Engineering, `CAVM` → College of Agriculture and Veterinary Medicine, `CMHS` → College of Medicine and Health Sciences, `COL` → College of Law), else `null`; `degree_plan` from the course lines/links on the page.
- Produces in `src/core/text.ts`: `slugToName(slug: string): string` (split on one or more hyphens, title-case, keep "of"/"in"/"the"/"and" lower except first word), `maskEmails(s: string): string` (`local@domain` → `***@domain`), `abbrev(s: string, n = ARGS_ABBREV_CHARS): string`, `hashKey(s: string): Promise<string>` (SHA-256 hex, first 16 chars).

- [ ] **Step 1: Write the failing tests** (every fixture read from `tests/fixtures/uaeu/`)

```ts
it("parseCatalogue finds every college and 2,700+ courses, keyed by code from the link's id param", () => {
  const { colleges, courseMap } = parseCatalogue(cat.text, cat.links);
  expect(colleges.map(c => c.college)).toContain("College of Business and Economics");
  expect(colleges.flatMap(c => c.courses).length).toBeGreaterThan(2700);
  expect(courseMap.get("HSR140")).toMatch(/course_\d+\.shtml\?id=HSR140$/);
  expect(colleges.flatMap(c => c.courses).find(c => c.code === "ENGL601")?.title).toBe("Storytelling in the World");
});
it("parseCoursePage returns only the requested course when the page carries the next one too", () => {
  const c = parseCoursePage(hsr.text, "HSR140")!;
  expect(c.title).toBe("Introduction to Society & Behavior");
  expect(c.credit_hours).toBe(3);
  expect(c.learning_outcomes).toHaveLength(4);
  expect(c.description).not.toContain("Geography");          // that sentence belongs to HSR150
  expect(parseCoursePage(hsr.text, "HSR150")!.learning_outcomes).toHaveLength(5);
  expect(parseCoursePage(hsr.text, "HSR999")).toBeNull();
});
it("parseProgramIndex returns the 75 programme links in order", () => { expect(parseProgramIndex(idx.links)).toHaveLength(75); });
it("parseProgramPage reads name, college from the hosting sentence, credit hours and 80+ degree-plan courses", () => {
  const p = parseProgramPage(mds.text);
  expect(p.name).toBe("Bachelor of Science in the Mathematics of Data Science");
  expect(p.college).toBe("College of Science");
  expect(p.degree_plan.length).toBeGreaterThanOrEqual(80);
  expect(p.objectives.length).toBeGreaterThanOrEqual(4);
});
it("slugToName handles the double hyphen", () => {
  expect(slugToName("bachelor-of-science-in--the-mathematics-of-data-science")).toBe("Bachelor of Science in the Mathematics of Data Science");
});
it("maskEmails masks the local part only", () => {
  expect(maskEmails("profile.shtml?email=a.example@uaeu.ac.ae")).toBe("profile.shtml?email=***@uaeu.ac.ae");
});
```

If the programme page's degree plan is not fully present in the recorded markdown (count the course links in the fixture first), lower the 80 to the fixture's count and say so in the test name.

- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/parsers-catalogue.test.ts` → FAIL
- [ ] **Step 3: Implement the four parsers and the text helpers**
- [ ] **Step 4: Run to verify they pass; `npm run check`; commit**

```bash
git add -A && git commit -m "feat: catalogue, course and programme parsers on recorded UAEU pages"
```

---

### Task 4: Catalogue tools: search_courses, get_course, list_programs, get_program

**Files:**
- Create: `src/tools/search-courses.ts`, `src/tools/get-course.ts`, `src/tools/list-programs.ts`, `src/tools/get-program.ts`, `src/db/programMap.ts`, `src/catalogue/read.ts`
- Modify: `src/tools/registry.ts` (append the four)
- Test: `tests/tools-catalogue.test.ts`

**Interfaces:**
- Consumes `fetchPages`, the parsers, `stamp`, `ToolError`.
- Produces in `src/catalogue/read.ts`: `readCatalogue(t: ToolContext): Promise<{ parsed: ReturnType<typeof parseCatalogue>; source_url; read_at; upstream_cached }>` (one Fetch of the catalogue index with `links: true`; a failed fetch → `UPSTREAM_TIMEOUT`), `readCoursePage(t, code, url)`, `readProgramPage(t, url)`.
- Produces in `src/parsers/program.ts`: `programKind(name): "bachelor" | "doctorate" | "minor" | "micro_credential" | "other"` (from the name prefix; hyphens, spaces and case ignored, so a page name and the name made from its URL slug agree).
- Produces in `src/db/programMap.ts`: `upsertProgramMap(db, rows: { url; name; college; kind }[], builtAt: Date)`, `getProgramMap(db): Promise<{ rows: Map<string, { name; college; kind }>; built_at: string | null }>`, `matchProgram(map, nameOrUrl: string): { match: "one"; url: string } | { match: "many"; names: string[] } | { match: "none"; nearest: string[] }`. Matching: a map URL given as is is `one`, and so is a name that equals exactly one programme's full name (ignoring case, punctuation and `the`: the exact full name wins over a tie on the shortened words). Otherwise normalize both sides (lowercase, `&` read as `and`, punctuation dropped, the degree phrases `bachelor of science in`, `bachelor of arts in` and `bachelor of` removed, and the filler words `a an and at for in of on the to with` never counted), token-overlap score `|q ∩ p| / |q|`; candidates with score ≥ 0.6; a unique top score → `one`; a tie at the top → `many` (their full names, in name order); none → `none` with the three highest-scoring names. A query that is only degree words (`Bachelor of Science`, `Bachelor of`) has no naming words left: it matches the names that begin with it (exactly one → `one`, several → `many`), else it is scored on all its words with filler still ignored. Nothing divides by zero. `get_program` lists at most 10 of a `many` in `near_matches` and puts the total in the message.
- Produces the four tools with these exact input shapes and descriptions' examples:
  - `search_courses` `{ query: z.string().min(1), college: z.string().optional(), limit: z.number().int().min(1).max(50).optional() }` → `{ courses: [{code, title, college, url}], total_matches, catalogue_read_at, ...ENVELOPE }`. Ranking: exact code 3, code prefix 2, all query words in title 1, any word 0.5; ties by code; `college` filter is a case-insensitive substring of the college heading; `limit` default 20. Costs 1 Fetch URL.
  - `get_course` `{ code: z.string().regex(/^[A-Za-z]{2,5}\d{3,4}[A-Za-z]?$/) }` (upper-cased before use) → course fields + `url` + ENVELOPE. Catalogue fetch for the URL map, then the course page (2 URLs). Code not in the map → `NOT_FOUND` (`message: "No course <CODE> in the UAEU catalogue"`); heading absent on the page → `SITE_CHANGED` naming the page.
  - `list_programs` `{ college: z.string().optional(), query: z.string().optional(), kind: z.enum(["bachelor","doctorate","minor","micro_credential","other"]).optional() }` → `{ programs: [{name, college, kind, url}], total, map_built_at: string | null, ...ENVELOPE }`. Fetches the index live (1 URL), enriches from `program_map`; a URL not in the map gets `name: slugToName(slug)`, `college: null`, `kind: programKind(name)`.
  - `get_program` `{ name_or_url: z.string().min(2) }` → `{ name, college, kind, credit_hours, description, objectives, degree_plan, url, ...ENVELOPE }`. A `https://www.uaeu.ac.ae/en/catalog/undergraduate/programs/…` URL is read directly; a name goes through `matchProgram` (`many` → `NOT_FOUND` with `near_matches`; `none` → `NOT_FOUND` with the nearest three); any other URL → `INVALID_INPUT`.

- [ ] **Step 1: Write the failing tests** (TinyFetch answered by `fetchMock` with the fixtures; `program_map` seeded with 3 rows in `beforeEach`)

```ts
it("search_courses ranks the exact code first and honours the college filter", async () => {
  const r = await callTool("search_courses", { query: "ECON105", college: "business" });
  expect(r.structuredContent.courses[0]).toMatchObject({ code: "ECON105", college: "College of Business and Economics" });
  expect(r.structuredContent).toMatchObject({ method: "fetch", cached: false, ttl_seconds: 3600 });
});
it("search_courses by topic words finds titles", async () => { /* "international finance" → includes FINC348 and ECON331; total_matches ≥ 2 */ });
it("get_course reads the catalogue then the course page and returns only HSR140", async () => {
  const r = await callTool("get_course", { code: "hsr140" });
  expect(r.structuredContent).toMatchObject({ code: "HSR140", credit_hours: 3, source_url: expect.stringContaining("id=HSR140") });
  expect(fetchMock.calls).toHaveLength(2);
});
it("get_course for a code not in the catalogue is NOT_FOUND", async () => {
  const r = await callTool("get_course", { code: "ZZZZ999" });
  expect(r.isError).toBe(true);
  expect(JSON.parse(r.content[0].text)).toMatchObject({ code: "NOT_FOUND" });
});
it("get_course with a malformed code is INVALID_INPUT", async () => { /* code: "hello" */ });
it("list_programs returns 75 programmes, named from the map or the slug", async () => { /* total 75; the MDS row has college "College of Science"; an unmapped row has college null and a title-cased name */ });
it("get_program by exact name reads the page", async () => { /* "Mathematics of Data Science" → name, college, degree_plan ≥ 80 */ });
it("get_program with several matches is NOT_FOUND listing them", async () => {
  const r = await callTool("get_program", { name_or_url: "Bachelor of Science" });
  expect(JSON.parse(r.content[0].text)).toMatchObject({ code: "NOT_FOUND", near_matches: expect.arrayContaining([expect.stringContaining("Bachelor of Science")]) });
});
it("a TinyFetch failure is UPSTREAM_TIMEOUT with retry_after_seconds", async () => { /* 502 reply → code UPSTREAM_TIMEOUT, retry_after_seconds 30 */ });
```

- [ ] **Step 2: Run to verify they fail** — FAIL
- [ ] **Step 3: Implement `read.ts`, `programMap.ts`, the four tools; append them to `TOOLS`**
- [ ] **Step 4: Run to verify they pass; `npm run check`; commit**

```bash
git add -A && git commit -m "feat: catalogue tools (search_courses, get_course, list_programs, get_program)"
```

---

### Task 5: Events, deadlines and find_faculty

**Files:**
- Create: `src/parsers/events.ts`, `src/parsers/deadlines.ts`, `src/parsers/faculty.ts`, `src/tools/list-events.ts`, `src/tools/academic-deadlines.ts`, `src/tools/find-faculty.ts`
- Modify: `src/tools/registry.ts`
- Test: `tests/parsers-pages.test.ts`, `tests/tools-pages.test.ts`

**Interfaces:**
- Produces `parseEvents(text: string): { date: string; title: string; url: string | null }[]`: the `DD \nMon \nYYYY` three-line date followed by a `###### Title` heading, read until the `## Video Highlights` heading; `date` as ISO `YYYY-MM-DD`.
- Produces `parseDeadlines(text: string): { label: string; date_or_rule: string; refund_percent: number | null; start_date: string | null; end_date: string | null }[]` from each `| Status | Start Date | End Date | Payment Refund % | …` table row, `label` = the nearest `######` heading above the table + the row's Status (e.g. `"Courses Under the Full-Semester System: Course Withdrawal"`), dates ISO when parsable; plus `policySummary(text): string` = the first paragraph.
- Produces `facultyFromSearch(hits: { url; title; snippet }[]): { name: string; title: string | null; college: string | null; profile_url: string }[]`: keep only `/en/<college>/profile.shtml?email=` URLs; `name` = result title with a leading `Faculty Profile - ` stripped and a leading `Dr. `/`Prof. ` kept in `title` when present; `college` from the path segment (`cmhs` → College of Medicine and Health Sciences, `eng` → College of Engineering, `chss` → College of Humanities and Social Sciences, `cit`, `cbe`, `cos`, `col`, `cedu`, `cavm` as in Task 3, else the raw segment).
- Produces the tools: `list_events` `{ from: z.string().date().optional(), to: z.string().date().optional(), limit: ≤ 50 }` → `{ events, total, note: "Highlighted events from uaeu.ac.ae/en/events; may include past events", ...ENVELOPE }`; `academic_deadlines` `{}` → `{ deadlines, policy_summary, url, ...ENVELOPE }`; `find_faculty` `{ query: z.string().min(2), college: z.string().optional() }` → `{ people, total, ...ENVELOPE }` with `method: "search"`, `source_url` = the Search request's human URL (`https://www.uaeu.ac.ae/en/catalog/uaeu-faculty-directory.shtml`), `college` filter as a case-insensitive substring of the mapped college name; results with no profile URL match → `NOT_FOUND` with `message: "No UAEU faculty profile matched <query>"`.

- [ ] **Step 1: Write the failing tests**

```ts
it("parseEvents reads the five highlighted events with ISO dates and stops before video highlights", () => {
  const ev = parseEvents(events.text);
  expect(ev).toHaveLength(5);
  expect(ev[0]).toMatchObject({ date: "2026-02-28", title: "Emirati Day for Education" });
  expect(ev.map(e => e.title)).not.toContain("Academic Carnival");
});
it("parseDeadlines reads the withdrawal table rows with refund percent and ISO dates", () => {
  const d = parseDeadlines(refunds.text);
  expect(d.length).toBeGreaterThanOrEqual(3);
  expect(d[0]).toMatchObject({ refund_percent: 100, start_date: "2026-08-24", end_date: "2026-09-18" });
  expect(d[0].label).toContain("Course Withdrawal");
});
it("facultyFromSearch keeps only profile urls and maps the college", () => { /* fixtures/tinyfish/search-faculty.json → 5 people (placeholder names), the placeholder "Dr. Amal Example" at College of Medicine and Health Sciences, directory url dropped */ });
it("list_events filters by from/to", async () => { /* from 2026-02-01 to 2026-02-28 → 3 events */ });
it("academic_deadlines returns deadlines and the policy summary with the refunds url", async () => {});
it("find_faculty calls TinySearch restricted to uaeu.ac.ae and returns people with method search", async () => {});
it("find_faculty with no profile hits is NOT_FOUND", async () => {});
```

- [ ] **Step 2: Run to verify they fail** — FAIL
- [ ] **Step 3: Implement the parsers and the three tools; append to `TOOLS`**
- [ ] **Step 4: Run to verify they pass; `npm run check`; commit**

```bash
git add -A && git commit -m "feat: list_events, academic_deadlines and Search-backed find_faculty"
```

---

### Task 6: Agent-backed reads: profile and academic calendar

**Files:**
- Create: `src/agent/reads.ts`, `src/db/agentCache.ts`, `src/db/counters.ts`, `src/parsers/calendar.ts`, `src/core/dates.ts`, `src/tools/get-faculty-profile.ts`, `src/tools/get-academic-calendar.ts`, `src/handlers/webhooks.ts` (Agent route only; Task 9 adds the Monitor route)
- Modify: `src/tools/registry.ts`, `src/index.ts`
- Test: `tests/agent-reads.test.ts`, `tests/dates.test.ts`

**Interfaces:**
- Consumes `startRun`, `getRun`, `stepsCost`, `recordSpend`, `totalSpend`.
- Produces in `src/core/dates.ts`: `currentAcademicYear(now: Date): string` (month ≥ August → `${y}-${y+1}`, else `${y-1}-${y}`), `nextAcademicYear(year: string)`, `isAcademicYear(s)` (`/^\d{4}-\d{4}$/` and consecutive), `resolveCalendarDate(dayMonth: string, academicYear: string): string | null` (`"17 Aug"` + `"2026-2027"` → `"2026-08-17"`; months Aug–Dec take the first year, Jan–Jul the second; unparsable → `null`), `daysBetween(a: Date, b: Date)`.
- Produces in `src/parsers/calendar.ts`: `CALENDAR_GOAL(year)` = `"This is UAEU's academic calendar with academic-year tabs such as 2025-2026 and 2026-2027. Click the tab for ${year} if it is not already selected. Then list every dated row shown for that year, grouped under the semester heading it appears beneath (for example Fall Semester, Spring Semester, Summer). For each row return date exactly as shown (for example '17 Aug') and title exactly as shown. Do not navigate to other pages."`; `CALENDAR_SCHEMA` = `{type:"object", required:["academic_year","semesters"], properties:{academic_year:{type:"string"}, semesters:{type:"array", items:{type:"object", required:["name","items"], properties:{name:{type:"string"}, items:{type:"array", items:{type:"object", required:["date","title"], properties:{date:{type:"string"}, title:{type:"string"}}}}}}}}}`; `normalizeCalendar(result: unknown, year: string): { academic_year: string; semesters: { name: string; items: { date: string; date_text: string; title: string }[] }[] } | null` (ISO dates via `resolveCalendarDate`; an item whose date does not resolve is dropped and counted in a `dropped` number; `null` when the result has no semesters). `PROFILE_GOAL` = `"This is a UAEU faculty profile page. Return the person's full name, academic title, college, department, email address if shown on the page, research interests as a list of short phrases, and education as a list of degree lines, each exactly as shown. Do not navigate to other pages."`; `PROFILE_SCHEMA` with `required: ["name"]` and the other fields nullable; `normalizeProfile(result, url)`.
- Produces in `src/db/agentCache.ts`: `getCached(db, url)`, `insertPending(db, { url, kind, run_id, started_at })`, `markOk(db, url, data, read_at, run_id, spend_usd)`, `markFailed(db, url, error)`, `pendingCount(db)`, `expirePending(db, olderThan: Date): Promise<number>` (pending → failed, error `"timeout"`), `calendarRows(db)`.
- Produces in `src/db/counters.ts`: `bump(db, key: "fetch_urls" | "agent_reads", n: number, day: string): Promise<number>` and `today(db, key, day)`, stored in `rate` with `key_hash = "global:" + key`, `bucket = "d:" + day`.
- Produces in `src/agent/reads.ts`: `requestRead(t: ToolContext, p: { url: string; kind: "profile" | "calendar"; goal: string; schema: object }): Promise<{ status: "ok"; data: unknown; read_at: string } | { status: "reading"; eta_seconds: number }>`. Order of checks: cached `ok` row fresh enough (profile ≤ `PROFILE_CACHE_DAYS`, calendar ≤ `CALENDAR_REFRESH_DAYS`, otherwise still served but the caller marks it stale) → return it; `pending` row younger than `AGENT_PENDING_TIMEOUT_MS` → if older than 60 s, `getRun` once and finalize when `COMPLETED`/`FAILED`, else return `reading` with the remaining eta; `pending` older than the timeout → `expirePending`; then: `totalSpend ≥ BUDGET_PAUSE_USD` → throw `BUDGET_PAUSED` (`fix: "Falaj's TinyFish budget is paused; cached data and Fetch/Search tools keep working"`); `pendingCount ≥ AGENT_SLOTS` or `today("agent_reads") ≥ AGENT_READS_PER_DAY` → throw `RATE_LIMITED` `scope: "global"`, `retry_after_seconds: 120`; else `insertPending`, `startRun` with `webhookUrl = ${PUBLIC_BASE_URL}/api/webhooks/agent/${WEBHOOK_SECRET}`, `bump("agent_reads", 1)`, return `reading` with `AGENT_ETA_SECONDS`. `finalizeRun(env, runId, run: AgentRun): Promise<void>` is idempotent (a row already `ok` is left alone): on `COMPLETED` with a normalizable result → `markOk` + `recordSpend("agent_step", stepsCost(num_of_steps), runId)`; otherwise `markFailed`.
- Produces `POST /api/webhooks/agent/:secret`: wrong secret → 401; body parsed tolerantly for `run_id`, `status`, `result`, `num_of_steps`; unknown `run_id` → 200 `{ignored: true}`; else `finalizeRun`, 200.
- Produces the tools: `get_faculty_profile` `{ profile_url: z.string().url() }` (host must be `www.uaeu.ac.ae` and path must contain `/profile.shtml?email=`, else `INVALID_INPUT`) → the profile fields + ENVELOPE (`method: "agent_cached"`, `cached: true`, `stale: boolean` when older than `STALE_DAYS`) or `{ status: "reading", eta_seconds, retry: "call again in <eta> seconds" }` (the output schema is a union: success fields optional, plus `status?`); `get_academic_calendar` `{ academic_year: z.string().optional() }` (default `currentAcademicYear(now)`; invalid → `INVALID_INPUT`) → `{ academic_year, semesters, dropped, stale, ...ENVELOPE }` or the `reading` shape.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/dates.test.ts
it("currentAcademicYear flips in August", () => { expect(currentAcademicYear(new Date("2026-11-03"))).toBe("2026-2027"); expect(currentAcademicYear(new Date("2026-07-31"))).toBe("2025-2026"); });
it("resolveCalendarDate picks the year from the tab", () => { expect(resolveCalendarDate("17 Aug", "2026-2027")).toBe("2026-08-17"); expect(resolveCalendarDate("05 Jan", "2026-2027")).toBe("2027-01-05"); expect(resolveCalendarDate("TBA", "2026-2027")).toBeNull(); });

// tests/agent-reads.test.ts  (TinyFish answered by fetchMock; run-async reply {run_id: "r1"})
it("first profile call starts one Agent run and answers reading", async () => {
  const r = await callTool("get_faculty_profile", { profile_url: PROFILE_URL });
  expect(r.structuredContent).toMatchObject({ status: "reading", eta_seconds: 90 });
  expect(fetchMock.calls.filter(c => c.url.includes("run-async"))).toHaveLength(1);
  expect(fetchMock.calls[0].body).toMatchObject({ browser_profile: "lite", agent_config: { max_steps: 12 } });
});
it("a second call while pending starts nothing", async () => { /* two calls → still one run-async request */ });
it("the Agent webhook finalizes the row, records spend, and the next call serves the cached profile", async () => {
  await callWorker("/api/webhooks/agent/test-secret", { method: "POST", body: JSON.stringify({ run_id: "r1", status: "COMPLETED", num_of_steps: 4, result: profileResult }) });
  const r = await callTool("get_faculty_profile", { profile_url: PROFILE_URL });
  expect(r.structuredContent).toMatchObject({ name: expect.any(String), method: "agent_cached", cached: true, stale: false });
  expect((await spendByKind(env.DB)).agent_step).toBeCloseTo(0.064);
});
it("a pending row older than 5 minutes expires and frees the slot", async () => { /* insert pending with started_at = now-6min; call → new run-async; old row failed */ });
it("the daily Agent cap answers RATE_LIMITED scope global", async () => { /* bump agent_reads to 10 → code RATE_LIMITED, scope "global" */ });
it("spend at the pause answers BUDGET_PAUSED and Fetch tools still work", async () => { /* insert spend 3.0 → profile call BUDGET_PAUSED; get_course still ok */ });
it("get_academic_calendar serves the weekly read with ISO dates and marks 15-day-old data stale", async () => {
  /* seed agent_cache calendar row for "2026-2027" from fixtures/tinyfish/agent-run-calendar.json reshaped into semesters, read_at = now-15d */
  const r = await callTool("get_academic_calendar", {});
  expect(r.structuredContent.semesters[0].items[0]).toMatchObject({ date: "2026-08-17", title: "Add and drop begins" });
  expect(r.structuredContent.stale).toBe(true);
});
it("webhook with the wrong secret is 401 and an unknown run_id is 200 ignored", async () => {});
it("get_faculty_profile on a non-UAEU url is INVALID_INPUT", async () => {});
```

- [ ] **Step 2: Run to verify they fail** — FAIL
- [ ] **Step 3: Implement dates, calendar/profile goals and normalizers, the cache rows, counters, `requestRead`/`finalizeRun`, the Agent webhook route, the two tools; append to `TOOLS`**
- [ ] **Step 4: Run to verify they pass; `npm run check`; commit**

```bash
git add -A && git commit -m "feat: Agent-backed profile and academic calendar reads with single slot, cap, webhook and cache"
```

---

### Task 7: Call log, caller rate limits, Fetch cap, masking

**Files:**
- Create: `src/db/calls.ts`, `src/db/rate.ts`
- Modify: `src/mcp/server.ts` (`runTool` gains log + gate), `src/mcp/route.ts` (caller key, per-caller limit), `src/catalogue/read.ts` and every Fetch call site (count URLs through one `countFetch(t, n)` in `src/tinyfish/fetch.ts`)
- Test: `tests/limits.test.ts`

**Interfaces:**
- Produces `logCall(db, { tool, args, ms, status: "ok" | "error", error_code, callerKey, sessionId })` storing `args_abbrev = abbrev(maskEmails(JSON.stringify(args)))`, `key_hash = hashKey(callerKey)` and `session_hash = sessionId ? hashKey(sessionId) : null` (a nullable `calls.session_hash` column added to `migrations/0001_init.sql`, since nothing is deployed yet; `sessionId` is the client-sent `Mcp-Session-Id`, carried on `ToolContext`); `recentCalls(db, limit)` returning rows without `key_hash` or `session_hash`.
- Produces `checkCaller(db, callerKey, now): Promise<{ ok: true } | { ok: false; retry_after_seconds: number }>` using buckets `m:<YYYY-MM-DDTHH:MM>` and `d:<YYYY-MM-DD>` with `INSERT … ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count`; limits `CALLER_PER_MINUTE`, `CALLER_PER_DAY`.
- Produces `countFetch(t: ToolContext, n: number)`: `bump("fetch_urls", n)` before the Fetch; over `FETCH_URLS_PER_DAY` → `RATE_LIMITED scope global`, `retry_after_seconds` = seconds to next UTC midnight.
- `POST /mcp` over the caller limit answers HTTP 429 with the `RATE_LIMITED scope caller` body as JSON (the transport is bypassed, so the body is plain JSON, not JSON-RPC).

- [ ] **Step 1: Write the failing tests**

```ts
it("every tool call writes a log row with masked, abbreviated args and no raw caller key", async () => {
  await callTool("find_faculty", { query: "a.example@uaeu.ac.ae" });
  const row = (await env.DB.prepare("SELECT * FROM calls").all()).results[0];
  expect(row.args_abbrev).toContain("***@uaeu.ac.ae");
  expect(row.key_hash).toHaveLength(16);
});
it("the 121st call in a minute from one caller is 429 RATE_LIMITED scope caller", async () => { /* seed rate row m:<now> count 120 for the hashed key → 429 */ });
it("the 401st Fetch URL of the day is RATE_LIMITED scope global and makes no TinyFish call", async () => { /* seed global:fetch_urls d:<today> = 400 → get_course error, fetchMock.calls length 0 */ });
it("the caller key is the IP alone; a client-sent Mcp-Session-Id is only logged", async () => { /* same IP, two session ids → one caller bucket (the same rate rows); the two log rows carry different session_hash values */ });
```

- [ ] **Step 2: Run to verify they fail** — FAIL
- [ ] **Step 3: Implement the log, the limiter, the Fetch counter; wire them**
- [ ] **Step 4: Run to verify they pass; `npm run check`; commit**

```bash
git add -A && git commit -m "feat: call log with masking, per-caller limits, daily Fetch cap"
```

---

### Task 8: Canaries, tool status, SITE_CHANGED gate, health_check, cron

**Files:**
- Create: `src/health/canaries.ts`, `src/health/run.ts`, `src/db/toolStatus.ts`, `src/db/canaryRuns.ts`, `src/cron.ts`, `src/handlers/admin.ts`
- Modify: `src/tools/health-check.ts` (real), `src/mcp/server.ts` (gate), `src/index.ts` (scheduled + admin routes)
- Test: `tests/health.test.ts`

**Interfaces:**
- Produces `CANARIES: readonly Canary[]` with `Canary = { tool: ToolName; args: unknown; check(result: unknown): { level: "ok" | "degraded" | "broken"; detail: string }; costs: "fetch" | "search" | "agent_cached" }`, exactly: `get_course {code:"HSR140"}` → credit_hours 3 and description non-empty; `search_courses {query:"ECON"}` → ≥ 10; `list_programs {}` → ≥ 70 (and the run rebuilds the programme map first); `get_program {name_or_url:"Mathematics of Data Science"}` → degree_plan ≥ 80; `list_events {}` → ≥ 1 with an ISO date; `academic_deadlines {}` → ≥ 3; `find_faculty {query:"mathematics"}` → ≥ 1 (a topic, so no person is named by the canary); `get_academic_calendar {}` → ≥ 5 dated items, `degraded` when `stale`; `get_faculty_profile` on the most recently cached profile URL → served from cache (skipped with detail `"no cached profile yet"` when the table is empty, status unchanged). `health_check` has no canary.
- Produces `runCanaries(env, ctx, trigger: "nightly" | "monitor" | "manual"): Promise<CanaryRunResult>`: rebuilds the programme map (`buildProgramMap(env)`: index + pages in batches of `FETCH_BATCH_MAX`, counted by `countFetch`; stores `name, college, kind` from each programme page), runs each canary through `runTool` with `callerKey: "canary"` sequentially, sets `tool_status` (`ok` / `degraded` when slower than `CANARY_SLOW_MS` or the check says so / `broken` with the detail; `BUDGET_PAUSED`, `RATE_LIMITED` or `UPSTREAM_TIMEOUT` from a canary leaves the previous status and writes the reason as `detail`), inserts a `canary_runs` row.
- Produces the gate in `runTool`: before running any tool but `health_check`, read its `tool_status`; `broken` → throw `SITE_CHANGED` with `message: "<page> changed: <detail> (canary failed at <last_checked_at>)"`, `source_url` = the canary's page, `fix: "See /api/health; the parser in src/parsers/<file> needs updating"`, with no TinyFish call.
- Produces `health_check` `{}` → `{ checked_at, tools: { [name]: { status, last_ok_at, last_checked_at, detail } }, site_changed_at: string | null, monitors: [{ page, last_check_at, last_outcome }], spend: { used_usd, share_usd, paused: boolean }, ...ENVELOPE }`. `health_check` reads no page, so its envelope is `{ source_url: "<base>/api/health", read_at, method: "status", cached: false }`.
- Produces `scheduled(event, env, ctx)` in `src/cron.ts`: `event.cron === "0 22 * * *"` → `runCanaries(env, ctx, "nightly")`; `"0 21 * * 0"` → `requestRead` for the calendar for `currentAcademicYear(now)` and, when the slot is free afterwards, the next academic year is queued by setting a `calendar_next` marker that the following nightly run picks up (one Agent run per hour of cron at most).
- Produces admin routes (token required): `POST /api/admin/health-run` → `runCanaries(…, "manual")` result; `POST /api/admin/program-map` → rebuild and `{ programs, built_at }`; `POST /api/admin/calendar-read` `{ academic_year? }` → `requestRead` outcome; `POST /api/admin/tool-status` `{ tool, status, detail }` → set it (used by the health demo in the design's section 7.3).

- [ ] **Step 1: Write the failing tests**

```ts
it("runCanaries sets ok for passing tools and records a canary run", async () => { /* fetchMock fixtures for all pages + search; calendar + profile seeded → every status ok except profile when seeded */ });
it("a canary whose check fails marks the tool broken with the detail", async () => { /* catalogue fixture with HSR140 line removed → get_course broken, detail mentions HSR140 */ });
it("a broken tool returns SITE_CHANGED with the page url and makes no TinyFish call", async () => {
  await setToolStatus(env.DB, "get_course", "broken", "credit hours missing", new Date());
  const r = await callTool("get_course", { code: "HSR140" });
  expect(JSON.parse(r.content[0].text)).toMatchObject({ code: "SITE_CHANGED", source_url: expect.stringContaining("uaeu.ac.ae") });
  expect(fetchMock.calls).toHaveLength(0);
});
it("a canary blocked by BUDGET_PAUSED leaves the previous status and records why", async () => {});
it("a slow canary is degraded", async () => { /* fetchMock reply delayed past CANARY_SLOW_MS via fake timers, or inject a clock */ });
it("health_check reports every tool, monitors and spend", async () => {});
it("the nightly cron runs the canaries; the Sunday cron starts the calendar read", async () => { /* worker.scheduled({cron: "0 22 * * *"}) and ({cron: "0 21 * * 0"}) */ });
```

- [ ] **Step 2: Run to verify they fail** — FAIL
- [ ] **Step 3: Implement canaries, status, the gate, health_check, cron, admin routes**
- [ ] **Step 4: Run to verify they pass; `npm run check`; commit**

```bash
git add -A && git commit -m "feat: canaries, tool status gate, health_check tool, cron, admin routes"
```

---

### Task 9: Monitors and the Monitor webhook

**Files:**
- Create: `src/db/monitors.ts`, `scripts/init-monitors.mjs` (calls the admin route), `tests/fixtures/webhooks/{changed,unchanged}.json`
- Modify: `src/handlers/webhooks.ts` (Monitor route), `src/handlers/admin.ts` (`POST /api/admin/monitors-init`), `src/tools/health-check.ts` (monitors come from the table already)
- Test: `tests/webhook-monitor.test.ts`

**Interfaces:**
- Produces `MONITOR_PAGES = [{ page: "catalogue", url: CATALOGUE_URL }, { page: "programs", url: PROGRAMS_INDEX_URL }]`, `schedule_cron "0 */12 * * *"`, `purpose "The page structure changed or the list of courses or programmes changed."`, webhook `${PUBLIC_BASE_URL}/api/webhooks/monitor/${WEBHOOK_SECRET}`.
- Produces `POST /api/admin/monitors-init`: refuses when the table already has `MAX_MONITORS` rows (`{error: "monitors already exist"}`), else `createMonitor` for each page and upserts `monitors`.
- Produces `POST /api/webhooks/monitor/:secret`: wrong secret → 401; payload parsed as in Fineprint (`id`, `fetch_monitor_id`, `outcome`); monitor id not in the table → 200 `{ignored: true}`; records `last_check_at`/`last_outcome` and a `monitor_check` spend row once per payload `id` (duplicate → 200 `{duplicate: true}`); `outcome === "changed"` and not baseline → sets `site_changed_at`, then `ctx.waitUntil(runCanaries(env, ctx, "monitor"))`, 200 `{changed: true, canaries: "started"}`.
- Copy the webhook fixtures' shape from `../fineprint/tests/fixtures/webhooks/`.

- [ ] **Step 1: Write the failing tests**

```ts
it("wrong secret is 401 and writes nothing", async () => {});
it("a changed payload for an unknown monitor id is 200 ignored", async () => {});
it("a changed payload for the catalogue monitor sets site_changed_at and runs the canaries", async () => {
  /* seed monitors row; fetchMock fixtures for the canary pages; post fixtures/webhooks/changed.json via callWorker (waits for waitUntil) */
  expect((await env.DB.prepare("SELECT site_changed_at FROM monitors WHERE page='catalogue'").first()).site_changed_at).not.toBeNull();
  expect((await env.DB.prepare("SELECT trigger FROM canary_runs").first()).trigger).toBe("monitor");
});
it("an unchanged payload records the check and spend and runs nothing", async () => {});
it("the same payload id twice records one check", async () => {});
it("monitors-init creates two monitors and refuses a third run", async () => {});
```

- [ ] **Step 2: Run to verify they fail** — FAIL
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run to verify they pass; `npm run check`; commit**

```bash
git add -A && git commit -m "feat: two catalogue Monitors, Monitor webhook, canaries on change"
```

---

### Task 10: Read API, install JSON, smoke script, docs

**Files:**
- Create: `src/handlers/api.ts`, `scripts/mcp-smoke.mjs`, `docs/runbook.md`, `README.md` (first version), `.dev.vars.example` (if not yet), `LICENSE` (MIT, if not yet)
- Modify: `src/index.ts`, `package.json` (`"health": "node scripts/mcp-smoke.mjs"`)
- Test: `tests/api.test.ts`

**Interfaces:**
- Produces `GET /api/health` (the `health_check` result as JSON), `GET /api/log?limit=` (default 50, max 200; `recentCalls`), `GET /api/tools` (`[{ name, title, description, inputSchema, outputSchema, annotations }]` generated from `TOOLS` through the same zod → JSON Schema conversion the SDK uses, so the site's tables and `tools/list` agree), `GET /api/stats` (from Task 1, plus `fetch_urls_today`, `agent_reads_today`, `monitors`), all with `Cache-Control: public, max-age=30` and CORS `*` for GET.
- Produces `scripts/mcp-smoke.mjs <base-url>`: `initialize`, `tools/list` (asserts 10 names), `tools/call health_check`, then `search_courses {query:"ECON"}`; prints one line per step with status and ms; exit code 1 on any failure. This is `npm run health`.
- Produces `docs/runbook.md`: deploy steps (D1 create, `migrate:remote`, three secrets, `wrangler deploy`), `monitors-init`, the first `program-map` and `calendar-read` runs, `claude mcp add --transport http falaj <url>/mcp`, the health demo (set `get_course` broken through `/api/admin/tool-status`, call it, show `SITE_CHANGED`, re-run `health-run` to clear), key rotation (`wrangler secret put TINYFISH_API_KEY`), the caps and where to raise them.
- Produces `README.md` opening: one paragraph on what Falaj is, the live URL placeholder, the install block for Claude Code / Claude Desktop / Cursor / ChatGPT / `mcp-remote`, the tool table (name, what it answers, TinyFish call behind it, cost), the "How TinyFish is used" table (Fetch, Search, Agent, Monitor with where each is used), the error contract, the health story, limits and budget, the people rule from spec section 6. The demo transcript section is a placeholder until the first live conversation is recorded.

- [ ] **Step 1: Write the failing tests**

```ts
it("GET /api/tools lists ten tools whose names and schemas match tools/list", async () => {
  const api = await (await callWorker("/api/tools")).json();
  const list = await listTools();
  expect(api.map((t: any) => t.name).sort()).toEqual(list.map((t: any) => t.name).sort());
  expect(api).toHaveLength(10);
});
it("GET /api/log never includes key_hash and abbreviates args", async () => {});
it("GET /api/health mirrors health_check", async () => {});
it("GET /api/stats carries today's counters", async () => {});
```

- [ ] **Step 2: Run to verify they fail** — FAIL
- [ ] **Step 3: Implement the API, the smoke script, the runbook and the README**
- [ ] **Step 4: Run to verify they pass; `npm run check`; commit**

```bash
git add -A && git commit -m "feat: read API, MCP smoke script, runbook and README"
```

---

### Task 11: Deploy and first live run (only once I decide to deploy)

**Files:**
- Modify: `wrangler.jsonc` (`database_id`), `docs/build-log.md`, `README.md` (live URL), `tests/fixtures/uaeu/` (refresh if a page changed)

No code in this task beyond configuration. Every step below is a checklist item with a recorded outcome in `docs/build-log.md`; stop at any failure and write down what happened.

- [ ] **Step 1: Deploy only after Groundwork's demo dossiers are made** (the two builds share the account's Agent runs).
- [ ] **Step 2: Create the remote D1 (`wrangler d1 create falaj`, write the id), `npm run migrate:remote`, put the three secrets (`TINYFISH_API_KEY` from `.dev.vars`; `ADMIN_TOKEN` and `WEBHOOK_SECRET` freshly generated with `openssl rand -hex 24`, stored only in `.dev.vars`), `wrangler deploy`.** Use the `CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare.env | cut -d= -f2- | tr -d '\r')` prefix on every remote wrangler command.
- [ ] **Step 3: `npm run health https://falaj.<account>.workers.dev`** → four green lines. Record the URL and the four timings.
- [ ] **Step 4: `POST /api/admin/program-map`** (75 + 1 Fetch URLs, free) → `programs: 75`. Then `POST /api/admin/health-run` → every Fetch/Search tool `ok`; calendar and profile show "no cached data yet".
- [ ] **Step 5: After a look at the wallet and the other builds' Agent runs: `POST /api/admin/calendar-read` for the current year** (one Agent run, about $0.06–$0.19); wait for the webhook; `get_academic_calendar` via `npm run health`-style call returns ≥ 5 dated items. Record steps and spend. Then one `get_faculty_profile` read on a profile URL I pick (leadership only), same check.
- [ ] **Step 6: After a count of the account's Monitors: `POST /api/admin/monitors-init`** → two monitor ids in `/api/health`; record them. Total account monitors must stay ≤ 50; the two paused spike monitors are not Falaj's and are never deleted.
- [ ] **Step 7: Add the server to Claude Code on this machine: `claude mcp add --transport http falaj <url>/mcp`, run `tools/list` from Claude Code, and one real `search_courses` call.** Record the result. The demo transcript itself is recorded separately.
- [ ] **Step 8: Commit the configuration and the build log; push; write the live URL, `/api/stats` and the spend lines into the build log.**

---

## Notes on coverage

- Spec coverage: section 4.1 reads → Tasks 2, 4, 5, 6 (programme map in 4 and 8); 4.2 tools → Tasks 1, 4, 5, 6, 8; 4.3 errors → Task 1 types, exercised in 4, 6, 7, 8; 4.4 canaries and Monitors → Tasks 8, 9; 4.5 caps and budget → Tasks 6, 7; 4.6 the site → second plan; 4.7 read API → Task 10; section 5 data model → Task 1; section 6 secrets, validation, masking, people rule → Tasks 1, 3, 4, 6, 7, 10; section 7 demo → Task 11; section 8 testing → every task; section 9 order → Tasks 1–11; section 10 open points → settled in Global Constraints (transport) and Task 8 (canary topic).
- Type consistency: `ToolContext`, `ToolDef`, `stamp`, `ENVELOPE`, `ToolError`, `runTool`, `requestRead`, `finalizeRun`, `runCanaries`, `countFetch`, `bump`/`today` are named once and used by those names in later tasks. The `Method` enum includes `"status"` from Task 1 so `health_check` fits the envelope.
- Proportion: the plan carries signatures, test names and assertions, and the exact values the spec pins; bodies are left open except the two Agent goals and the fuzzy-match rule, which the tests do not determine.
