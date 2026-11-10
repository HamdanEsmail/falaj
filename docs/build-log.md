# Falaj build log

My running record of build checks, transport decisions and live TinyFish calls, oldest first.

## 2026-11-03 · Statelessness check under `wrangler dev`

- **Transport:** MCP SDK 1.32.2 `WebStandardStreamableHTTPServerTransport` (`@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js`), stateless (`sessionIdGenerator: undefined`), JSON responses (`enableJsonResponse: true`), a new transport and a new server per request. The server is the SDK's low-level `Server` with Falaj's own `tools/list` and `tools/call` handlers (see `src/mcp/server.ts`). No fallback needed: `@hono/mcp` and `agents` `McpAgent` were not used.
- **Setup:** `npx wrangler d1 migrations apply falaj --local` (0001_init.sql, 13 commands OK), then `npx wrangler dev --port 8787`.
- **Requests:** four separate `curl -s -i -X POST http://localhost:8787/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream'` calls, no session header on any of them, in this order:

  | # | Method | Status | Content-Type | `mcp-session-id` header |
  |---|---|---|---|---|
  | 1 | `initialize` (protocol 2025-06-18) | 200 | application/json | none |
  | 2 | `tools/list` (no initialize on that request) | 200 | application/json | none |
  | 3 | `tools/list` (no initialize on that request) | 200 | application/json | none |
  | 4 | `initialize` | 200 | application/json | none |

  Both `initialize` answers: `serverInfo: {name: "falaj", version: "0.1.0"}`, `capabilities: {tools: {}}`. Both `tools/list` answers name `health_check` with `inputSchema.type` and `outputSchema.type` `"object"` and the four annotations (`readOnlyHint`, `idempotentHint`, `openWorldHint` true, `destructiveHint` false).
- **Extra checks, same run of `wrangler dev`:** `tools/call health_check {}` answered 200 with `structuredContent` `{checked_at, tools: {}, monitors: [], source_url: "http://localhost:8787/api/health", read_at, method: "status", cached: false}`; `GET /mcp` answered 405 with `Allow: POST` and the install JSON.
- **Bundling:** no `nodejs_compat` flag needed. `wrangler deploy --dry-run` bundles the SDK at 1283.56 KiB (224.41 KiB gzip).
- wrangler dev stopped afterwards (process tree killed, no `workerd` left).

Live TinyFish calls: 0 URLs so far (running count: 0 of the 60-URL build allowance).

## 2026-11-03 · Fixture recording and cache-indicator probe

- **Recording (2026-11-03 13:52 UTC):** `node scripts/record-fixtures.mjs`, one `POST https://api.fetch.tinyfish.ai` with the six UAEU URLs, `format: "markdown"`, `links: true`, `ttl: 0`. 6 Fetch URLs, $0. HTTP 200, 6 results, 0 errors; each result written as `{ results: [<result>], errors: [] }` to `tests/fixtures/uaeu/{catalogue-index,course-hsr140,programs-index,program-mds,events,refunds}.json`. The key was read in-process from `.dev.vars` and is in no file or log.
- **Probe, same run:** the refunds page fetched twice in a row with `ttl: 3600`, `links: false` (2 more Fetch URLs, $0). Reply fields: top level `results`, `errors`; per result `url, final_url, title, description, language, text, author, published_date, latency_ms, format`. The two replies had identical text (same SHA-256) and differed only in `latency_ms` (1116 ms, then 1017 ms) and in the `date`, `x-amz-cf-id`, `x-ratelimit-remaining` and `x-request-id` headers. The only cache-looking header was `x-cache: Miss from cloudfront` (plus `via: ... (CloudFront)`) on both calls, which is the CDN in front of the TinyFish API, not a statement about the page. The API also reports `x-ratelimit-limit: 150` with a one-minute reset. **No cache indicator, so `upstream_cached: null`** on every `fetchPages`/`fetchPage` result.
- **Fixtures not recorded live:** `tests/fixtures/tinyfish/search-faculty.json` (the real TinySearch reply shape, built from the spike's "uaeu faculty" results; names and email local parts are placeholders and the file says so in `_note`), `agent-run-calendar.json` (the spike's calendar run with `streaming_url`, `screenshot` and `html` set to null), `monitor-create.json` (copied unchanged from Fineprint; its `webhook_url` is null).

Live TinyFish URLs so far: 8 of the 60 allowed during the build (6 recording + 2 probe).

## 2026-11-03 · Four more fixtures (the `extra` batch)

- **Recording (2026-11-03 15:10 UTC):** `node scripts/record-fixtures.mjs --batch extra`, one `POST https://api.fetch.tinyfish.ai`, `format: "markdown"`, `links: true`, `ttl: 0`. 4 Fetch URLs, $0. HTTP 200, 4 results, 0 errors; no retry. Each result written as `{ results: [<result>], errors: [] }`. The key was read in-process from `.dev.vars` and is in no file or log. URLs 1 to 3 were derived from the recorded fixtures with the parsers (the first `minor` and the first `micro_credential` programme in the index's page order, and `parseCatalogue(...).courseMap.get("AERO485")`):
  1. `https://www.uaeu.ac.ae/en/catalog/undergraduate/programs/minor-in--statistics-and-data-analytics.shtml` -> `program-minor.json`
  2. `https://www.uaeu.ac.ae/en/catalog/undergraduate/programs/creditbearing-microcredential-in-accounting-foundations.shtml` -> `program-microcredential.json`
  3. `https://www.uaeu.ac.ae/en/catalog/courses/course_2945.shtml?id=AERO485` -> `course-aero485.json`
  4. `https://www.uaeu.ac.ae/en/catalog/undergraduate/programs/bachelor-of-science-in-the-mathematics-of-data-science.shtml` (the single hyphen, as the programmes index links it) -> `program-mds-single-hyphen.json`
- **MDS single-hyphen comparison:** the single-hyphen URL answers with the same programme page: no redirect (`final_url` equals the URL asked for), the same name, college (College of Science), 120 credit hours, description and 5 objectives, and 184 of 186 text lines identical. It is **not byte-identical**: two general-education rows of the degree plan differ between the 13:52 recording (double hyphen, `…-in--the-…`) and this one (single hyphen) - `HSR120` and `HSR130` there, `HIS105` and `LNG105` here, with the same course titles ("Introduction to Heritage & Culture", "Introduction to Language & Communication"). The newer codes (`HIS105`, `LNG105`) are in the recorded course catalogue and the older ones are not, so the single-hyphen page looks current and the double-hyphen copy looks stale. That is not "identical apart from trivial whitespace", in the text or in the parsed `degree_plan` (88 rows each, two codes differ), so I kept both recordings (`program-mds.json` is still the double-hyphen one, `program-mds-single-hyphen.json` the new one) and left the MDS tests as they were. Checked: with `program-mds-single-hyphen.json` copied over `program-mds.json`, all 98 tests in `tests/parsers-catalogue.test.ts` and `tests/tools-catalogue.test.ts` pass, and no test mentions `HSR120`, `HSR130`, `HIS105` or `LNG105`, so adopting the single-hyphen recording would break nothing.
- **New layouts:** the minor and the micro-credential open at `## <name>` and carry admission requirements, objectives, learning outcomes and a degree-requirements table like a bachelor page, but neither has the "hosted by" sentence (college `null` from the page). The AERO485 page is the aerospace/mechanical department page with 100+ courses (150 KB); `# Internship I (AERO485 )` has the trailing space. No parser change was needed.
- **No other live call for the next three tools.** `list_events`, `academic_deadlines` and `find_faculty` were built and tested against the recorded `events.json`, `refunds.json` and `search-faculty.json`. The TinySearch query `find_faculty` sends (`<query> faculty profile`) has not been tried live; check it at the first real client call.

Live TinyFish URLs so far: 12 of the 60 allowed during the build (8 + 4 in this batch).

## 2026-11-03 · Where I stopped

I stopped here for five days to finish my other builds first. The state I left:

- **Built and checked against the design:** the scaffold, D1 schema and stateless MCP endpoint; the TinyFish clients, the fetch mock and the recorded fixtures; the catalogue, course and programme parsers; `search_courses`, `get_course`, `list_programs` and `get_program`, with programme `kind`.
- **Built, still to be read again against the design:** four more recorded pages with the redirect check, kind-safe names and the near_matches cap; `list_events`, `academic_deadlines` and the Search-backed `find_faculty`; the corrected programme counts, map shape, kind sentence and matchProgram rules in the spec and plan. `npm run check` is green: typecheck, 173 tests in 8 files, `wrangler deploy --dry-run`.
- **Uncommitted on disk:** nothing.
- **Live TinyFish use so far:** 12 free Fetch URLs of the 60 I allowed myself during the build; no Search, Agent, Monitor or Browser call; $0.
- **Next:** read that last piece again and fix what I find, then the Agent-backed profile and calendar reads (single slot claimed atomically, pending-row timeout, daily cap, budget pause, cache rows that keep their last good data, canaries and cron never starting a first read), then the call log and limits, the canaries, the Monitors and the read API. Deploying comes after Groundwork is live.

## 2026-11-09 · Agent-backed profile and academic calendar

- `get_faculty_profile` and `get_academic_calendar` serve `agent_cache`. A first read claims the single Agent slot atomically (conditional INSERT/UPSERT while pending rows < 1), starts `run-async` with `browser_profile: "lite"` and `max_steps: 12`, and answers `{status: "reading", eta_seconds: 90}`. A second call while pending starts no run. A pending row older than 5 minutes is marked `failed` with error `timeout` and frees the slot. Daily cap 10 → `RATE_LIMITED scope global`. Spend ≥ $3.00 → `BUDGET_PAUSED`; Fetch tools still work. Cache rows keep last-good `data`/`read_at` through pending and failed. Calendar cache key is `https://www.uaeu.ac.ae/en/calendar/#<year>`; 15-day-old data is served with `stale: true` and ISO dates from the year tab. `POST /api/webhooks/agent/:secret` compares the secret in constant time (wrong secret 401, unknown `run_id` 200 `{ignored: true}`) and finalizes spend on COMPLETED.
- Tools never auto-start a refresh when last-good data exists; `requestRead(..., { force: true })` is for cron/admin. `ToolContext.allowAgentStart === false` never starts a first read (canaries).
- Live TinyFish calls: 0. Running total still 12 of 60.

## 2026-11-09 · Call log, caller rate limits, Fetch cap, masking

- Every tool call writes a `calls` row: `args_abbrev = abbrev(maskEmails(JSON.stringify(args)))`, `key_hash` of the IP (16 hex), `session_hash` of a client-sent `Mcp-Session-Id` or null. The caller key is `cf-connecting-ip` alone (`anon` when absent). The 121st POST `/mcp` in a minute from one IP is HTTP 429 with the `RATE_LIMITED scope caller` body as plain JSON (transport bypassed). The 401st Fetch URL of the UTC day is `RATE_LIMITED scope global` and does not call TinyFish (`countFetch` in `readPage` before `fetchPage`). `calls.session_hash` added to `0001_init.sql` (nothing deployed).
- Live TinyFish calls: 0. Running total still 12 of 60.

## 2026-11-09 · Canaries, tool status, SITE_CHANGED, health_check, cron

- Nightly canaries (`runCanaries`) rebuild the programme map (index + pages in batches of 10, keyed by the requested URL, stale map rows pruned), then run each tool through `runTool` with `callerKey: "canary"`, `allowAgentStart: false` and `gate: false`. A failing check sets `tool_status` to `broken`; slower than 20 s, or a stale calendar, is `degraded`. `BUDGET_PAUSED` / `RATE_LIMITED` / `UPSTREAM_TIMEOUT` leave the previous status. Agent canaries with no cached row are skipped (`no cached data yet` / `no cached profile yet`); they never start a first Agent read.
- While a tool is `broken`, `runTool` returns `SITE_CHANGED` with the canary page URL and detail and makes no TinyFish call. `health_check` reports every tool, `site_changed_at`, monitors and spend; envelope `method: "status"`.
- Cron: `0 22 * * *` runs the canaries, then force-refreshes the next-year calendar only if that cache row already exists and is older than 7 days. `0 21 * * 0` force-refreshes the current-year calendar only if that row exists. wrangler.jsonc already had both triggers; it was not changed.
- Admin (bearer token): `/api/admin/health-run`, `/program-map`, `/calendar-read`, `/tool-status`.
- Live TinyFish calls: 0. Running total still 12 of 60.

## 2026-11-09 · Monitors and the Monitor webhook

- Two Page monitors (catalogue index and programmes index), every 12 hours, purpose as specified. `POST /api/admin/monitors-init` creates them only while the `monitors` table has fewer than `MAX_MONITORS` rows, then upserts by page. It never lists, pauses, edits, resumes or deletes any other Monitor on the account.
- `POST /api/webhooks/monitor/:secret`: wrong secret 401; unknown `fetch_monitor_id` 200 `{ignored: true}`; body parsed then validated (`id`, `fetch_monitor_id`) before use; one `monitor_check` spend row per payload `id` (retry `{duplicate: true}`); `changed` and not baseline sets `site_changed_at` and `waitUntil(runCanaries(..., "monitor"))`.
- Live TinyFish calls: 0. Running total still 12 of 60.

## 2026-11-09 · Read API, install JSON, smoke script, docs

- Public GET `/api/health` (same payload as `health_check`), `/api/log?limit=` (default 50, max 200; `recentCalls`, no `key_hash` or `session_hash`), `/api/tools` (ten tools via `toolListing`, same schemas as `tools/list`), `/api/stats` (existing counters plus `monitors`). All four send `Cache-Control: public, max-age=30` and `Access-Control-Allow-Origin: *`.
- `GET /mcp` 405 install JSON now also names Claude Desktop and ChatGPT beside Claude Code, Cursor and mcp-remote.
- `scripts/mcp-smoke.mjs` (`npm run health`): initialize, tools/list (the ten names), `health_check`, `search_courses {query:"ECON"}`; one line per step (status and ms); exit 1 on failure. Written, not run against a live address.
- `README.md` and `docs/runbook.md`: live URL left as a placeholder; no measured production figures. Runbook covers D1, secrets, deploy, `program-map`, `health-run`, the Agent and Monitor steps (each after a look at the wallet), the health demo, key rotation and the caps in `src/core/limits.ts`.
- Live TinyFish calls: 0. Running total still 12 of 60.

## 2026-11-10 · Faults I found reading the code again

I read the whole server again before building its page. Each fault below got a test that failed first, then the fix. No live TinyFish call; the running total is still 12 of 60.

- **Agent runs and money.** A finished run is booked exactly once, by its run id, whichever of the callback or the next tool call sees it first, and whether or not its result was usable. A run that reports no step count is booked at the cap of 12 steps, never at nothing. A callback no longer carries the result: it only names the run, and Falaj asks TinyFish for that run itself, so a made-up callback cannot write a profile or a calendar.
- **A page that cannot be read.** A profile or calendar year whose read failed is not tried again for six hours. Before, every call started a new paid run on the same page until the day's ten reads were gone.
- **Profile addresses.** `get_faculty_profile` reduces a profile address to one form (https, www, the college path, one `email` parameter in lower case), so one person asked for under two spellings is one cache row and one paid read.
- **Calendar years.** `get_academic_calendar` reads only last year's, this year's and next year's tab. A far-off year used to start a paid read that could never succeed.
- **The daily Fetch cap** is counted before the read and given back when the read is refused, in one statement, so calls that arrive together cannot pass the 400th URL together.
- **Batches.** A POST to `/mcp` that carries a JSON array is refused with 400. One request is one counted call; before, one request could carry many calls past the per-caller limit.
- **Making the Monitors again.** `/api/admin/monitors-init` stores each Monitor as it is made and, run again after a failure, makes only the missing one. It answers 502 with what failed, not 200.
- **The health pass after a change.** A Monitor change used to start the full pass in the 30 seconds a Worker has left after it answers a webhook, which a pass over 75 programme pages does not fit in. The webhook now only marks the pass as due; a job every quarter hour runs it and clears the mark once the pass has run.
- **Calendar dates.** A row takes its year from the tab and the semester heading: every Summer row is in the tab's second year, August included. A range ("15-22 Dec", "28 Dec - 02 Jan") or a date with its weekday is read at its first day, not dropped.
- **Email addresses in the log.** An address whose @ is written `%40`, as a URL carries it, is masked in the public call log like any other.

`npm run check` is green: typecheck, 259 tests in 14 files, `wrangler deploy --dry-run`. The design and the plan now live in `docs/specs` and `docs/plans`.

## 2026-11-10 · The page

- **What it is.** One page at `/`, drawn on the server from Falaj's own record (tool status, counters, the call log), so opening it reads nothing from the university. `POST /try` runs one of three tools for real (`search_courses`, `get_course`, `academic_deadlines`) through `runTool`, so a try is gated, logged and counted like an assistant's call, with its own limit of 6 a minute and 60 a day for one visitor. `GET /try` goes back to the form.
- **The look.** One shape, the round mouth of a falaj's wells: ten circles for the ten tools, real photographs of the falaj in Al Ain inside the same circle. `DESIGN.md` has the whole of it. Five photographs from Wikimedia Commons (CC BY-SA), unchanged, credited in the footer.
- **Waiting.** A pressed button reads "Reading uaeu.ac.ae…", a clock counts from 0:00 and the usual time is stated. Checked in a real browser: the button went busy at once and the answer came back with its source line.
- **Headers.** The page is sent with a content security policy (this site's files and the two font hosts only, no inline script or style, no framing), `nosniff` and a referrer policy. The four fonts loaded under it.
- **Faults found on the way.** A long code line widened the phone page by 150px (grid children now may shrink). The square for an answer cut off its source line at narrow widths (it grows now). The tiles overflowed at tablet width (two across there, a plain list on a phone). My local test database was older than the schema and refused the call log write; rebuilt from the migrations, it writes.
- **Live TinyFish calls:** 11 free Fetch URLs from the local page (nine tries: five searches, one course read twice at two pages each, the refunds page twice). Measured: 10.7 s for the first read of the catalogue, then 1.7 to 8.8 s. Running total 23 of 60. No Search, Agent, Monitor or Browser call; $0.
- `npm run check` is green: typecheck, 273 tests in 15 files, `wrangler deploy --dry-run`. A measured check of the layout in a real browser passes with no failure at 1440, 768 and 390 pixels.

## 2026-11-10 · Live

- **Deployed** to its own Cloudflare account as `falaj`, at https://falaj.falaj.workers.dev. D1 database `falaj` created, both migrations applied, the three secrets set from `.dev.vars` without printing them, `PUBLIC_BASE_URL` set to the live address.
- **A fault the first deploy found.** Cloudflare refused the Sunday trigger `0 21 * * 0`: it counts Sunday as 1 and takes day names. The trigger is now `0 21 * * SUN`, and the handler knows the 21:00 trigger by its hour and minute however the day is written. The test that used the old string failed first. All three triggers are set.
- **Smoke** (`npm run health`): initialize 200 in 1.6 s, tools/list 200 in 0.3 s, health_check 200 in 0.5 s, search_courses 200 in 3.6 s.
- **Programme map:** 74 programmes read in 54 s (the index listed 75 on 3 November).
- **Health pass, 49 s:** every Fetch and Search tool passed against the live site: 51 ECON courses, HSR140 with 3 credit hours, 74 programmes, 88 courses in the Mathematics of Data Science plan, 5 dated events, 7 deadlines, 9 people for "mathematics". The two tools that need a browser read were skipped, because nothing has been read for them yet.
- **The page, live.** It says "Eight of ten are running" and shows the two unread tools as empty wells: a tool nothing has checked is neither running nor stopped, so I gave it a third state (with a test first). `health_check` reads Falaj's own record and counts as running once a pass has run. The security headers are sent, the files are served, and a try from the page returned 27 courses in 4.8 s and again in 4.2 s.
- **Live TinyFish use today:** free calls only. 158 Fetch URLs by Falaj's own counter (the map, the pass, the smoke and the tries), 11 more from my computer earlier, 1 Search. No Agent, Monitor or Browser call; $0.
- `npm run check` is green: typecheck, 274 tests in 15 files, `wrangler deploy --dry-run`.

## 2026-11-10 · The first paid read and the page watches

- **Calendar read.** One TinyFish Agent run: 7 steps, $0.112, under a minute and a half. `get_academic_calendar` now answers for 2026-2027 with 43 dated rows (Fall 15, Spring 17, Summer 11), every date resolved, none dropped.
- **Two Monitors made** (the course catalogue index and the programmes index), every 12 hours. Their first checks cost $0.01. Falaj's spend stands at $0.122, against the $3.00 line where new Agent reads pause.
- **Health pass again:** eight tools pass against the live site, the calendar among them, and the page says "Nine of ten are running". `get_faculty_profile` still waits for its first read.
- **Two faults the live search showed me.** Some of the university's own profile links leave the domain off the address (`?email=a.example`), and `get_faculty_profile` refused them, so a link `find_faculty` had just returned could not be read. It takes both forms now, and the public call log masks what follows `email=` in such a link, so the log never shows who was looked up. A search result titled "<name> - College of ..." kept the college in the name; it is cut off now. A failing test came first for each.
- `npm run check` is green: typecheck, 276 tests in 15 files, `wrangler deploy --dry-run`.

## 2026-11-10 · An assistant from outside, and the tenth tool

- **A real conversation.** I connected Claude (Sonnet) to the live `/mcp` address with nothing else: no notes, no repository. I asked what a student would ask: is there a machine learning course, what must I pass first, when do spring classes begin and what is the last day to withdraw without failing. It listed the ten tools, called four (`search_courses`, `get_academic_calendar`, `academic_deadlines`, `get_course`) and answered in 20 seconds: CSBP411 Machine Learning, College of Information Technology, 3 credit hours, needs CSBP301 with a minimum grade of D; spring classes begin 4 January 2027; last day to withdraw and drop without failure 5 February 2027. It named the page behind each fact and said the refund page only shows Fall 2026. The README carries the exchange.
- **A hard tester.** A second one was told to break it in at most 25 calls and used 18: a course code that does not exist, a malformed one, a programme name that matches several, an impossible date, searches that match nothing, a calendar year nobody has read. Its marks: 8 of 10 for the design of the tools, 7 for the answers, 9 for the errors.
- **What it found and I fixed.** A browser read that TinyFish would not start came back as a bare timeout. It now says whether TinyFish was busy (`RATE_LIMITED`, try in a minute) or refused the request, with what TinyFish answered, and that nothing was read or charged. An empty `list_events` answer for a date range now says how many events the page lists and between which dates, so "nothing in that range" cannot be mistaken for a broken call. A failing test came first for each.
- **What it found and I left.** `list_programs` gives no college for minors and micro-credentials, because the university's index gives none. `get_program` returns the degree plan as one list. `academic_deadlines` shows only the rows the refund page shows, which today are all Fall 2026.
- **Why the profile read never started.** With TinyFish's answer in the message, the next call showed it: 400 INVALID_INPUT. The profile schema gave four optional fields the type `["string", "null"]`, and TinyFish refuses a type that is a list. Every field names one plain type now, and a field the page does not show is left out. A test walks both schemas and failed first.
- **The tenth tool, live.** The first profile read then ran: 9 steps, $0.144, about a minute. Name, title, college, department, email, three research interests and one education line came back, and the second call served them from the cache. I name nobody here, and the public call log masks the address that was read.
- **Spend.** Falaj's total is $0.266: the calendar $0.112, the Monitors' first checks $0.01, the profile $0.144. The page still says "Nine of ten" until tonight's 22:00 UTC check reads the profile tool for the first time.
- `npm run check` is green: typecheck, 280 tests in 16 files, `wrangler deploy --dry-run`.
