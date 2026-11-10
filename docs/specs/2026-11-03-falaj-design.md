# Falaj: design

*Working name (a falaj is the Emirati irrigation channel that brings water from the source to the fields; this brings UAEU's website to any agent). Submission for the TinyFish Student Bounty Drop 002 "Site to MCP" bounty. Written 2026-11-03. Deadline 2026-11-17. Site wrapped: United Arab Emirates University, uaeu.ac.ae, which has no public API.*

## 1. Intent

Most of the web has no API, so agents can't use it. Falaj turns UAEU's public website into a permanent agent tool: a remote MCP server with clear, typed tools, with TinyFish doing the reading and clicking underneath. A student's agent, a parent's agent or an advisor's agent can ask "which data science electives can a second-year take, who teaches the statistics one, and when is the last day to drop?" and get answers read live from the university's own pages, each with its source link and read time. A nightly health check and two TinyFish Monitors catch the day the site changes, and every affected tool then fails loudly with a structured error rather than returning stale or wrong data.

Judges weigh: tool design (clear names, typed inputs and outputs, actions an agent actually needs); working in a real agent conversation including multi-step use of several tools; robustness (clear errors, a health check that catches site changes); value (a useful site with no API that people would want their agent to use); easy install with a clear README. Approval criteria, verbatim: TinyFish does the real web work behind every tool; tools return clean structured data, not raw page dumps; works for different inputs, not one scripted call; breaks loudly, not silently, when the site changes; not licence checks or property records.

## 2. Goals, non-goals, anti-goals

**Goals**
- Eight tools with typed inputs and outputs (section 4.2), installable in Claude Code, Claude Desktop, Cursor and ChatGPT from one URL.
- Every tool call makes a TinyFish call (Fetch, Search or Agent) and returns `source_url`, `read_at` and `method`. No tool answers from a database Falaj built earlier.
- A health check that runs nightly and on Monitor change, with per-tool status, and a fixed error contract (`SITE_CHANGED`, `NOT_FOUND`, `RATE_LIMITED`, `BUDGET_PAUSED`, `UPSTREAM_TIMEOUT`).
- A Console-world website: install block, tool cards with live call log, health panel, and a real recorded conversation.
- A reproducible demo transcript produced with Claude Code against the deployed server, plus my own screen recording in Claude Desktop or ChatGPT.
- Budget about $3 of TinyFish wallet for build, demo and the live run.

**Non-goals**
- Anything behind UAEU's login (eServices, registration, grades, the library account). Public pages only.
- Arabic pages (the English site is the source; tool inputs are English).
- Writing actions. Every tool is read-only and annotated as such.
- A stdio package on npm. The remote URL is the product; a one-line `mcp-remote` bridge is documented for clients that need stdio.

**Anti-goals**
- A tool that returns a page dump. Every output is a typed object with named fields.
- A tool that returns a cached answer without saying so and without a TinyFish read behind it.
- A tool that depends on a live Agent run in the request path (clients time out). Agent-backed data is read ahead by the health canary or on first request with a clear "up to 90 seconds" note, then cached with its read time.
- Silent degradation: if a canary fails, the affected tools return `SITE_CHANGED`, never a guess.
- Wrapping licence or property records (those are the other two bounties).

## 3. Constraints and verified facts

Verified on 2026-11-03 with free TinyFish calls; scripts and responses in `../spikes/` (`spike-mcp-sites.mjs`, `out/mcp-sites.json`, `out/uaeu-pages.json`, `out/uaeu-faculty-calendar.json`).

**UAEU pages that TinyFetch reads (free, `format: "markdown"`)**
- Course catalogue index `https://www.uaeu.ac.ae/en/catalog/courses/`: 122,374 chars, every course by college as `CODE : Title`, **2,787 course links** of the form `https://www.uaeu.ac.ae/en/catalog/courses/course_<n>.shtml?id=<CODE>` where `<n>` is not derivable from the code. `get_course` therefore resolves the URL from this page's links (`links: true`), never by guessing.
- A course page (HSR140): title, description, `### Credit Hours : 3`, course learning outcomes (2,903 chars).
- Undergraduate programmes index `https://www.uaeu.ac.ae/en/catalog/undergraduate/programs/`: 76 programme-path links as bare URLs (75 offerings plus the General Education Requirements page, which is not a programme and is left out; the index text holds only college and department headings, no programme names). A programme page (Mathematics of Data Science): title, description, objectives, credit hours, the hosting department and college in prose, degree plan with 88 course links (10,300 chars). Programme names and colleges therefore come from the programme pages, not the index (see 4.1, the programme map).
- Events `https://www.uaeu.ac.ae/en/events/`: a short highlighted list (912 chars; five entries dated 26 Jan to 2 Mar 2026, all in the past on the design date) followed by video highlights; the full events listing at `/en/media-center/events/` is JavaScript-only. `list_events` returns exactly what this page lists, labelled as highlighted events that may be past; it is the least valuable tool and is not a Monitor target.
- Withdrawal deadlines `https://www.uaeu.ac.ae/en/dvcsae/student_account_office/refunds.shtml`: policy text with deadlines and refund percentages (4,063 chars).
- Faculty directory `https://www.uaeu.ac.ae/en/catalog/uaeu-faculty-directory.shtml`: college headings only; its college links go to contact pages. The directory is not usable by Fetch.
- Faculty profile pages (`/en/<college>/profile.shtml?email=…`) and the academic calendar `https://www.uaeu.ac.ae/en/calendar/` return only a language notice in both markdown and HTML (411 chars): JavaScript-rendered. These are Agent reads.
- **The calendar page is the student academic calendar** (verified by one Agent run, `out/uaeu-calendar-agent.json`, 4 steps, $0.06): title "UAEU Calendar", year tabs 2024-2025, 2025-2026, 2026-2027, and dated rows per semester such as "17 Aug Add and drop begins", "24 Aug Classes Begin", "28 Aug Last day to add courses", "18 Sep Last day to withdraw and drop without failure", "05 Oct Midterm Exams". Dates carry day and month; the year comes from the selected tab and the semester heading. The alternatives found by search are not substitutes: `calendar_components.shtml` is a placeholder template (lorem ipsum), the "Academic Affairs Calendar 2026-2027" PDF is the faculty-facing activities calendar (orientation, promotion workshops; Fetch does read it, 7,461 chars), and the registration-and-exam-schedule page is JavaScript-only. `get_academic_calendar` therefore reads the page with Agent, once a week per academic year tab, cached with its read time.
- Several guessed paths 404 (`/en/academics/academic_calendar.shtml`, `/en/directory/`, `/en/news/events/`); `library.uaeu.ac.ae` is rejected as invalid. Not used.

**TinySearch** (`include_domains=uaeu.ac.ae`, free): "faculty directory find a faculty member" returned five faculty profile URLs, each with the person's name and academic title. `find_faculty` is Search-backed: a name or topic query restricted to uaeu.ac.ae profile URLs, free and fast.

**TinyAgent**: verified behaviour from the sibling builds (explicit goals with field lists, `output_schema`, 60 to 120 s per run, $0.016 per step, 2 concurrent runs account-wide shared by four builds, so **Falaj keeps at most one Agent run in flight** and never in a tool's request path). Cap `max_steps: 12`.

**TinyFish Monitor**: Page monitors verified; webhooks on every scheduled run with `outcome`, `diff`, `judgment`; $0.005 per check; **Falaj may hold 2 monitors** (account allocation: Fineprint 24, Standing 10, Groundwork 10, Falaj 2, spare 4): the **catalogue index** and the **undergraduate programmes index**, the two pages every catalogue tool depends on. The calendar page gives Fetch nothing, so it cannot be monitored; it is canaried by Agent weekly instead. The withdrawal-deadlines page is canaried by Fetch nightly (free), not monitored.

**TinyFetch allowance**: free within 1,000 URLs per day **for the whole account**, shared by four builds; beyond that, calls need wallet balance. Falaj therefore caps its own Fetch use at 400 URLs per day (section 4.5) and `get_course` costs two URLs (catalogue page for the link map, then the course page).

**MCP transport, checked on npm on 2026-11-03**: `@hono/mcp` 0.3.5 (Hono middleware exposing `StreamableHTTPTransport`, peer `@modelcontextprotocol/sdk ^1.29`, `zod ^3.25 || ^4`), `@modelcontextprotocol/sdk` 1.32.2, `hono` 4.13.16, `zod` 4.6.7. Falaj uses `@hono/mcp` for a stateless Streamable HTTP endpoint at `POST /mcp` on the Worker. Fallback if it misbehaves on Workers: Cloudflare's `agents` 0.32.0 `McpAgent` on a Durable Object (free plan supports SQLite-backed Durable Objects). Clients: Claude Code (`claude mcp add --transport http falaj <url>/mcp`), Claude Desktop custom connector, Cursor (`mcpServers` URL), ChatGPT custom connector, and `npx mcp-remote <url>/mcp` for stdio-only clients.

**Cloudflare**: same stack and free-plan limits as the sibling builds; account ready; working token in `../.cloudflare.env`.

**Site terms**: UAEU's pages are public. Falaj reads at most a few pages per call, caches by TinyFish's own `ttl`, rate-limits callers, and never touches authenticated services. Stated on the site.

## 4. Architecture

One Cloudflare Worker (Hono) with D1 and R2: `POST /mcp` (Streamable HTTP MCP), the JSON read API for the site, the Monitor webhook, the nightly health cron, and the Console-world site as static assets plus a server-rendered status page.

```
MCP client ──POST /mcp──▶ Hono + @hono/mcp ──▶ tool handler
                                              │   Fetch-backed: TinyFetch(url, ttl 3600, links) → parse → typed result + source_url/read_at
                                              │   Search-backed: TinySearch(include_domains=uaeu.ac.ae) → typed result
                                              │   Agent-backed: serve the canary's cached read (read_at shown); first-ever read: one Agent run, cached 7 days
                                              └── every call: log row (tool, args, ms, status), spend row
nightly cron ──▶ canaries (one fixture per tool) ──▶ tool_status (ok | degraded | broken) ──▶ site + health_check tool
Monitor (catalogue index, programmes index) ──webhook──▶ changed? ──▶ canaries within 15 minutes ──▶ status + "site changed on <date>" banner
```

### 4.1 Reads

- **Fetch-backed tools** call `POST https://api.fetch.tinyfish.ai` on every invocation with `ttl: 3600` and `links: true` where links are needed. TinyFish's own cache makes repeated calls fast and still free; the result's `read_at` is the time of that call and every Fetch result carries `ttl_seconds: 3600` so the reader knows TinyFish may have served a copy up to an hour old (the first build step probes whether TinyFish exposes a cache indicator with a double fetch; if it does, it is passed through as `upstream_cached`). Falaj keeps exactly two derived structures, both "find a page" maps, never answers: the **course URL map** (`CODE → course page URL`, rebuilt from the catalogue page's links on each catalogue fetch) and the **programme map** (`URL → {name, college, kind}`, rebuilt nightly by the health canary from the programmes index plus each programme page's title and hosting-college line, 75 pages in 8 Fetch batches of at most 10, plus the index itself, free). `list_programs` fetches the index live on every call for the current link list and enriches each link with its name and college from the map, showing the map's `built_at`; a link not yet in the map gets its name from the URL slug and `college: null`.
- **Search-backed tool** (`find_faculty`) calls TinySearch with the query and `include_domains=uaeu.ac.ae`, filters results to `/profile.shtml?email=` URLs and college pages, and returns name, title (from the result title), college (from the URL path) and the profile URL.
- **Agent-backed data** (`get_faculty_profile`, `get_academic_calendar`): served from Falaj's own cache (`agent_cache` table, keyed by URL, with `read_at`; results carry `cached: true` and `read_at`). A profile that has never been read starts one Agent run (if the single slot is free and the daily cap allows) and the tool returns `{status: "reading", eta_seconds: 90, retry: "call again in 90 seconds"}` so no client times out; the second call returns the cached profile. The academic calendar is read by Agent **once a week** for the current and the next academic-year tab (about $0.06 to $0.19 each), and again after a Monitor change, so it is always served instantly with its `read_at`. A cached read older than 14 days marks the tool `degraded` (served, with a warning), never `broken`. A page or year whose read failed is not tried again for six hours, so one page that cannot be read does not use up the day's reads (added 2026-11-10).

### 4.2 Tools (names, typed inputs, typed outputs)

All tools are annotated `readOnlyHint: true`, `idempotentHint: true`. Every success includes `source_url`, `read_at` (ISO), `method` (`fetch` | `search` | `agent_cached`), and `cached: boolean`. Inputs are zod schemas; the descriptions below are the text the model sees, each with an example.

| Tool | Input | Output |
|---|---|---|
| `search_courses` | `{query: string (code, title words or topic, e.g. "machine learning" or "CSBP"), college?: string, limit?: number ≤ 50}` | `{courses: [{code, title, college, url}], total_matches, catalogue_read_at}` |
| `get_course` | `{code: string, e.g. "HSR140"}` | `{code, title, college, description, credit_hours, learning_outcomes: string[], prerequisites: string[] (when the page lists them), url}` |
| `list_programs` | `{college?: string, query?: string, kind?: one of bachelor, doctorate, minor, micro_credential, other}` | `{programs: [{name, college, kind, url}], total}` |
| `get_program` | `{name_or_url: string, e.g. "Mathematics of Data Science"}` | `{name, college, kind, credit_hours, description, objectives: string[], degree_plan: [{code, title, credit_hours?}], url}` |
| `list_events` | `{from?: date, to?: date, limit?: number ≤ 50}` | `{events: [{date, title, url}], total}` |
| `academic_deadlines` | `{}` | `{deadlines: [{label, date_or_rule, refund_percent?}], policy_summary, url}` |
| `find_faculty` | `{query: string (name, or topic like "robotics"), college?: string}` | `{people: [{name, title, college, profile_url}], total}` |
| `get_faculty_profile` | `{profile_url: string}` | `{name, title, college, department, email?, research_interests: string[], education: string[], profile_url}` or `{status: "reading", eta_seconds, retry}` |
| `get_academic_calendar` | `{academic_year?: string, e.g. "2026-2027" (default: the current one)}` | `{academic_year, semesters: [{name, items: [{date (ISO), title}]}], read_at, cached: true}` (from the weekly Agent read) |
| `health_check` | `{}` | `{checked_at, tools: {name: {status: "ok" | "degraded" | "broken", last_ok_at, detail}}, site_changed_at?: ISO, monitors: [{page, last_check, outcome}]}` |

Ten tools; the bounty asks for three. `search_courses` matching: case-insensitive on code prefix and title words, ranked by code match first; `college` filter by the catalogue's own college headings. `get_program` accepts a name (fuzzy, best unique match from the programmes index; several matches → `NOT_FOUND` listing them) or a URL. `kind` comes from the name prefix (Bachelor of → bachelor, Doctor of or PhD → doctorate, Minor in or Minor of → minor, Credit-bearing Micro-credential in → micro_credential, else other); the programmes index lists 75 offerings of these kinds.

### 4.3 Error contract

Errors are MCP tool results with `isError: true` and a JSON body `{code, message, fix?, retry_after_seconds?, scope?, source_url?}` with `code` in: `NOT_FOUND` (with what was searched and, for programmes, the near matches), `SITE_CHANGED` (names the page and the canary that failed, and the time), `RATE_LIMITED` (`scope: "caller"` for the per-caller limit, `scope: "global"` for Falaj's daily Fetch or Agent cap, both with `retry_after_seconds`), `BUDGET_PAUSED` (new Agent reads refused past the spend cap; cached Agent data and every Fetch and Search tool keep working), `UPSTREAM_TIMEOUT` (TinyFish did not answer in time; `retry_after_seconds`), `INVALID_INPUT`. Nothing else is ever returned on failure.

### 4.4 Health check, canaries, Monitors

- **Canaries** (one per tool, run nightly at 22:00 UTC, which is 02:00 Gulf time, and after any Monitor change; all free except the weekly calendar read): `get_course("HSR140")` must return credit hours 3 and a non-empty description; `search_courses("ECON")` ≥ 10 results; `list_programs()` ≥ 70 and the programme map rebuilt; `get_program("Mathematics of Data Science")` ≥ 80 degree-plan courses; `list_events()` ≥ 1 with a parsable date; `academic_deadlines()` ≥ 3 deadlines; `find_faculty(<the canary name from section 6>)` ≥ 1 profile URL; `get_academic_calendar()` ≥ 5 dated items for the current year (Agent, weekly, or after a Monitor change); `get_faculty_profile` on one cached URL (served from cache, checks the cache is readable). A canary that fails sets that tool `broken` with the detail; a canary that passes with warnings (fewer results than usual, slower than 20 s, a cached read older than 14 days) sets `degraded`. A canary that cannot run because of `BUDGET_PAUSED` or a TinyFish outage leaves the previous status and records why.
- **Monitors**: Page monitors on the catalogue index and the undergraduate programmes index, every 12 hours, `purpose`: "The page structure changed or the list of courses or programmes changed." On a `changed` webhook: record `site_changed_at`, mark the health pass as due (a job every quarter hour runs it, so the pass has the time it needs; changed 2026-11-10), and set the site banner "UAEU changed its catalogue page on 5 Nov; all tools re-verified at 09:14 UTC" (or the broken list).
- **Breaking loudly**: while a tool is `broken`, calls to it return `SITE_CHANGED` with the canary detail and the page URL. The site's health panel and `health_check` show the same thing. The README documents the fix path (update the parser, run `npm run health`).

### 4.5 Caps and budget

Per-caller limit on `/mcp`: the caller key is `cf-connecting-ip` alone (stateless mode issues no session id, so an `Mcp-Session-Id` a client sends is client-invented and is never a rate key; when one is sent, its hash is kept in the call log row for debugging); 120 calls per minute and 2,000 per day per IP (hosted clients such as claude.ai connectors and ChatGPT share an IP across all their users, which is why the limits are generous; the global caps below are the real bound). A POST that carries a JSON array (a batch) is refused with 400, so one request is always one counted call (added 2026-11-10). Global caps for Falaj: 400 TinyFetch URLs per day and 10 Agent reads per day across all callers, never more than one Agent run in flight; `RATE_LIMITED` with `scope: "global"` beyond. Spend: Falaj's share of the shared wallet is **$3.50**; `BUDGET_PAUSED` at $3.00 of Falaj spend refuses new Agent reads only. Expected: build and demo about $1.00 (a few calendar and profile reads), live run about $1.00 (weekly calendar reads, monitors at 4 checks per day ≈ $0.02 per day, a handful of profile reads). Fetch and Search are free inside the caps.

### 4.6 The site (`DESIGN.md`)

*Changed 2026-11-10: I built the page with a look of its own instead of the dark console planned below. One shape runs it, the round mouth of a falaj's wells: ten circles for the ten tools, photographs of the falaj in Al Ain in the same circle. It is one page (first screen with the address, a form that runs three of the tools for real, the ten tools, how it works, how to add it, the health board, the latest calls, the day's share), not three. `DESIGN.md` describes it. The plan below is kept as first written.*


- **Home**: hero line ("UAEU's website, as tools your agent can call."), the install block for Claude Code with Cursor, Codex, ChatGPT and `mcp-remote` collapsed beneath, then the ten tool cards (name, description, parameters table, a real sample result from the canaries, "last called … · … s · ok") in a 760px column, with the live call log and the health panel in a right rail on desktop and below on mobile.
- **Health**: the panel in full: each tool's status and last ok time, the two Monitors with their last outcome, the site-changed banner if any, and the canary log.
- **Conversation**: the recorded transcript (section 7) rendered as prose with tool calls as compact mono lines.
- **Footer**: the spend meter and the terms line.

### 4.7 Read API for the site

`GET /api/health`, `GET /api/log?limit=` (tool, args abbreviated, ms, status, never caller IPs), `GET /api/tools` (the tool list with schemas, generated from the same zod definitions), `GET /api/stats`. The MCP endpoint itself is `POST /mcp` (GET returns 405 with the install instructions as JSON).

## 5. Data model (D1)

```
calls        id, tool, args_abbrev, ms, status (ok|error), error_code, ip_hash, at
tool_status  tool PK, status, detail, last_ok_at, last_checked_at
agent_cache  url PK, kind (profile|calendar), data (json), read_at, run_id, spend_usd, failed_at
canary_runs  id, at, trigger (nightly|monitor|manual), results (json), duration_ms
monitors     page PK, monitor_id, last_check_at, last_outcome, site_changed_at, canaries_due_at
spend        id, kind, amount_usd, ref, at
rate         ip_hash, minute, day, count_minute, count_day
```

## 6. Security and safety

- Secrets as Worker secrets: `TINYFISH_API_KEY`, `ADMIN_TOKEN`, `WEBHOOK_SECRET`. The MCP endpoint is public and read-only; admin endpoints (`POST /api/admin/health-run`, `/api/admin/monitors-init`) need the token.
- Inputs validated by zod; course codes constrained to `^[A-Z]{2,5}\d{3,4}[A-Z]?$`; URLs for `get_faculty_profile` must be on `www.uaeu.ac.ae`.
- The call log stores arguments abbreviated to 80 chars and a hashed caller key only, and masks the local part of any email address in arguments or URLs (`profile.shtml?email=***@uaeu.ac.ae`) before storing.
- **People in the data.** Faculty are public professionals listed on the university's own public directory; the tools return what the directory shows, including an email address when the profile page shows it. What Falaj itself publishes is narrower: the canary name, the demo transcript, the tool-card sample results and the README name only academic leadership or faculty in public-facing roles (deans, department chairs, directors), sample results omit email, and I check every name before the README is written.
- No stealth profile; UAEU does not block the standard one in any spike.

## 7. Demo and proof

1. **Reproducible transcript** (made with Claude Code as the client, against the deployed server): `claude mcp add --transport http falaj <url>/mcp`, then this multi-step question, which the tools can fully answer: "What data science courses does UAEU offer, what does the probability and statistics course cover and how many credit hours is it, who at UAEU works on statistics, and when is the last day this semester to withdraw without failure?" It runs `search_courses` → `get_course` → `find_faculty` → `get_academic_calendar` (and `academic_deadlines` for the refund rule). Saved as `docs/demo-conversation.md` and rendered on the site. No tool returns who teaches a course (the catalogue does not list instructors), so the demo never asks that.
2. **My recording**: the same question in Claude Desktop or ChatGPT with the connector, screen-captured for the submission post.
3. **Health demo**: a deliberately wrong canary fixture run once to show `SITE_CHANGED` surfacing in the tool, the panel and the README, then reverted (documented, not left in place).

## 8. Testing

- Unit tests: every parser on the recorded UAEU markdown (`out/uaeu-pages.json`); the course URL map; `search_courses` ranking; `get_program` fuzzy matching with the "several matches" case; the error contract shapes; rate limit and daily Agent cap; canary evaluation (pass, degraded, broken); Monitor webhook → canary run.
- MCP protocol tests: `initialize`, `tools/list` (ten tools with schemas and annotations), `tools/call` for each tool with TinyFish mocked, an error call returning `isError: true` with the JSON body.
- Fixtures are real: the spike outputs, plus the first live reads recorded during the build.
- `npm run check` = typecheck, tests, `wrangler deploy --dry-run`; GitHub Actions on push.

## 9. Delivery order

1. Scaffold, MCP endpoint with `tools/list` and the four catalogue tools (search, get course, list and get programme), parsers, call log, error contract. Deploy. Add to Claude Code on this machine and run the first real call.
2. Events, deadlines, `find_faculty` (Search), Agent-backed profile and calendar with the cache and the single slot, health canaries, two Monitors and the webhook, `health_check` tool, read API.
3. The Console site, the demo transcript, the README (install for every client, tool table generated from the schemas, how TinyFish Fetch, Search, Agent and Monitor are used, the health story), my recording, the post drafts.

Live Agent calls wait until I have checked the wallet and what the other builds are running (the account allows two runs at once).

## 10. Left open in this design

- Exact zod schemas and description wording, as long as each has an example and the annotations.
- Parser details for the catalogue, programme and events markdown; the fuzzy programme match (a token overlap score is fine).
- Whether `@hono/mcp` runs statelessly on Workers without a session store (verify first, with `wrangler dev` and an `initialize` round trip); fall back to `agents` `McpAgent` if not, and record it.
- The nightly cron hour in UTC (02:00 Gulf is 22:00 UTC).

**Settled in the plan (2026-11-03):** the transport is the MCP SDK's own `WebStandardStreamableHTTPServerTransport` in stateless JSON mode (`@hono/mcp` is a thin wrapper over it with an extra peer dependency; it stays as the first fallback, `agents` `McpAgent` the second). Stateless means clients never get an `Mcp-Session-Id`, so the per-caller key is the IP alone (decided 2026-11-03: a client-sent session id is only logged, hashed). Fixtures, tests and docs in the repo name no real person: placeholders such as "Dr. Amal Example" and `a.example@uaeu.ac.ae` (decided 2026-11-03). The `find_faculty` canary uses a topic query ("mathematics"), not a person's name. The nightly cron is 22:00 UTC; the weekly calendar read is Sunday 21:00 UTC (written `0 21 * * SUN`: Cloudflare counts Sunday as 1 and refuses a 0). A third job runs every quarter hour and does nothing unless a Monitor change is waiting for its health pass (added 2026-11-10).

## 11. Repository conventions

Same as the sibling builds: TypeScript, ESM, exact pins, `npm run check`, `.dev.vars.example`, MIT, `docs/` with this design and the plan, `artifacts/` for screenshots and the demo recording, README opening with what it does, the live URL and the "How TinyFish is used" table. `DESIGN.md`, `design/tokens.css`, `design/PRINCIPLES.md` from `../family/mcp/` and `../family/`. Private on GitHub until submission day.
