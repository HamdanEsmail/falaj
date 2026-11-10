# Falaj

Falaj is a remote MCP server that turns United Arab Emirates University's public website into ten typed, read-only tools. An assistant can search the course catalogue, read a course or programme page, list events and withdrawal deadlines, find faculty profile pages, and read a cached faculty profile or academic calendar. Pages are read through TinyFish (Fetch, Search, Agent and two Page monitors). The same Worker serves a page where a visitor can try a tool, and a small JSON API.

Live: **https://falaj.falaj.workers.dev** is the page, and `https://falaj.falaj.workers.dev/mcp` is the address an assistant is given. To run it yourself, see "Run locally" below.

## Install

Replace `<url>` with the live address (or `http://localhost:8787` for a local `wrangler dev`). The MCP endpoint is `POST <url>/mcp`. A GET to that path returns 405 and this install JSON.

**Claude Code**

```bash
claude mcp add --transport http falaj <url>/mcp
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "falaj": { "url": "<url>/mcp" }
  }
}
```

**Cursor** (MCP settings / `mcp.json`)

```json
{
  "mcpServers": {
    "falaj": { "url": "<url>/mcp" }
  }
}
```

**ChatGPT** (custom connector / MCP server): `<url>/mcp`

**mcp-remote** (stdio bridge for clients that do not speak Streamable HTTP)

```bash
npx mcp-remote <url>/mcp
```

```json
{
  "mcpServers": {
    "falaj": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "<url>/mcp"]
    }
  }
}
```

## The page

The same Worker serves one page at `/`. It shows the address to give an assistant, the ten tools with the arguments their schemas take, each tool's last nightly check, the latest calls and what is left of the day's share.

A visitor can try three of the tools on the page itself (`search_courses`, `get_course`, `academic_deadlines`). The form posts to `/try`, which runs the real tool through the same gate, call log and Fetch cap as an assistant's call, with its own limit of 6 questions a minute and 60 a day for one visitor. A pressed button says it is reading, a clock counts, and the answer shows where it was read, when, how and how long it took (2 to 11 seconds in my tests).

The look is described in `DESIGN.md`. The photographs are of the falaj and gardens of Al Ain Oasis, from Wikimedia Commons under CC BY-SA, unchanged and credited in the page's footer.

## Tools

Every success includes `source_url`, `read_at` (ISO), `method` (`fetch` | `search` | `agent_cached` | `status`) and `cached`. Fetch-backed results also include `ttl_seconds: 3600`.

| Tool | What it answers | TinyFish | Cost |
|---|---|---|---|
| `search_courses` | Courses matching a code, prefix or title words | Fetch, catalogue index (1 URL) | $0 |
| `get_course` | One course by code (description, credit hours, outcomes) | Fetch, catalogue then the course page (2 URLs) | $0 |
| `list_programs` | Undergraduate offerings (bachelor, doctorate, minor, micro-credential) | Fetch, programmes index (1 URL) | $0 |
| `get_program` | One programme page (plan, objectives, credit hours) | Fetch, that programme page (1 URL) | $0 |
| `list_events` | Highlighted events on the events page | Fetch (1 URL) | $0 |
| `academic_deadlines` | Withdrawal dates and tuition refund percentages | Fetch (1 URL) | $0 |
| `find_faculty` | Faculty profile URLs matching a name or topic | Search, restricted to uaeu.ac.ae | $0 |
| `get_faculty_profile` | One profile (cached; a first read starts an Agent run and answers `{status: "reading"}`) | Agent, then cache | $0.016 per Agent step |
| `get_academic_calendar` | Dated items for one academic-year tab (cached the same way) | Agent, then cache | $0.016 per Agent step |
| `health_check` | Per-tool status, monitors, spend; reads no UAEU page | none | $0 |

## How TinyFish is used

| Product | Where Falaj uses it |
|---|---|
| Fetch | Every catalogue, course, programme, events and deadlines read. Batches of at most 10 URLs. |
| Search | `find_faculty` only, restricted to uaeu.ac.ae. |
| Agent | `get_faculty_profile` and `get_academic_calendar`. At most one run in flight, 12 steps, 10 new reads per UTC day. A tool call never waits for the run: it starts it (or serves the cache) and returns. |
| Monitor | Two Page monitors, on the course catalogue index and the undergraduate programmes index, every 12 hours. A `changed` webhook records `site_changed_at` and runs the canaries. Falaj never lists, pauses, edits, resumes or deletes any other Monitor on the account. |

## Error contract

A failed tool call is `isError: true` with a JSON text body `{code, message, fix?, retry_after_seconds?, scope?, source_url?, near_matches?}`. `code` is one of:

| Code | When |
|---|---|
| `NOT_FOUND` | No course, programme or person matched. Programmes that match several names list them in `near_matches` and do not pick the first. |
| `SITE_CHANGED` | That tool's canary is `broken`. The body names the page and the canary detail. No TinyFish call is made. |
| `RATE_LIMITED` | `scope: "caller"` (this IP) or `scope: "global"` (Falaj's daily Fetch or Agent cap, or TinyFish busy with other reads). Includes `retry_after_seconds`. |
| `BUDGET_PAUSED` | Agent spend has reached $3.00. Cached Agent data and every Fetch and Search tool keep working. |
| `UPSTREAM_TIMEOUT` | TinyFish did not answer in time, or would not start a browser read. The message says which, and that nothing was read or charged. |
| `INVALID_INPUT` | Arguments failed the tool's schema. |

Nothing else is returned on failure.

## Health

Nightly canaries (22:00 UTC) run each tool against recorded checks. A failure sets that tool `broken`; slower than 20 s, or a stale calendar, is `degraded`. While a tool is `broken`, calling it returns `SITE_CHANGED`. To rehearse that path: `POST /api/admin/tool-status` with `{tool: "get_course", status: "broken", detail: "…"}` (admin token), call `get_course`, then `POST /api/admin/health-run` to re-verify and clear. See [docs/runbook.md](docs/runbook.md).

`GET /api/health` is the same payload as `health_check`. `GET /mcp` on a browser is 405 with the install JSON.

## Limits and budget

All values live in `src/core/limits.ts` (raise them there).

- 120 MCP calls per minute and 2,000 per UTC day per client IP (`cf-connecting-ip`; `"anon"` when absent).
- 400 TinyFetch URLs per UTC day across all callers.
- 1 Agent run in flight, 10 new Agent reads per UTC day, 12 steps, 160 s, 5-minute pending timeout.
- Falaj's TinyFish share is $3.50; new Agent reads pause at $3.00 of Falaj spend. Fetch and Search stay free inside the caps. Monitor checks are $0.005 each. Agent steps are $0.016.
- At most 2 Page monitors, both created only into Falaj's own `monitors` table.
- Call-log arguments are masked (email local parts) and cut to 80 characters. No caller IP is stored in the clear.

## People

Tools return what UAEU's public pages show, including an email when a profile page shows one. What this repository itself carries (fixtures, tests, this README, sample results) names no real person and uses placeholders such as "Dr. Amal Example" and `a.example@uaeu.ac.ae`. Academic leadership in public-facing roles may appear only after I have checked each name. Sample results omit email.

## Read API

Public JSON, CORS `*`, `Cache-Control: public, max-age=30`:

| Path | Returns |
|---|---|
| `GET /api/health` | The `health_check` result |
| `GET /api/log?limit=` | Recent calls (default 50, max 200): tool, abbreviated args, ms, status. No `key_hash`, no IPs |
| `GET /api/tools` | The ten tools with the same schemas `tools/list` serves |
| `GET /api/stats` | Call count, spend, today's Fetch and Agent counters, monitors |

Admin (`Authorization: Bearer <ADMIN_TOKEN>`): `POST /api/admin/health-run`, `/program-map`, `/calendar-read`, `/tool-status`, `/monitors-init`.

## Run locally

Needs Node 24 or later.

```bash
npm install
cp .dev.vars.example .dev.vars    # then fill TINYFISH_API_KEY, ADMIN_TOKEN, WEBHOOK_SECRET
npm run migrate:local
npm run dev
```

```bash
npm test          # no network: every TinyFish call is intercepted
npm run check     # typecheck, tests, wrangler deploy --dry-run
npm run health    # MCP smoke against http://localhost:8787 (wrangler dev must be running)
```

Tests never call TinyFish or uaeu.ac.ae. Deploy steps are in [docs/runbook.md](docs/runbook.md).

## Demo transcript

A real conversation on 10 November 2026. I connected Claude (Sonnet) to the live server with nothing but the `/mcp` address and asked one question. It had never seen this repository.

> **Asked:** I am a student thinking about United Arab Emirates University. Is there a machine learning course there, what do I need to have passed before I can take it, and when do spring classes begin and what is the last day to withdraw without failing? Please tell me where each fact comes from.

| # | Tool call | What came back |
|---|---|---|
| 1 | `search_courses {"query": "machine learning"}` | CSBP411 Machine Learning (College of Information Technology), then CSBP478, ELEC709, MATH360, STAT380 and others |
| 2 | `get_academic_calendar {"academic_year": "2026-2027"}` | The 2026-2027 calendar from the cache: 43 dated rows in three semesters |
| 3 | `academic_deadlines {}` | The refund page's rows, all of them for Fall 2026 |
| 4 | `get_course {"code": "CSBP411"}` | 3 credit hours, prerequisite CSBP301 with a minimum grade of D, the description |

> **Answered, in 20 seconds (shortened):** Yes. **CSBP411 Machine Learning** is a 3-credit-hour course in the College of Information Technology. It requires **CSBP301 with a minimum grade of D**. **Spring classes begin on 4 January 2027**, and the **last day to withdraw and drop without failure is 5 February 2027**. The refund page shows only the Fall 2026 schedule, so it has no spring refund dates yet.

Each fact came with the UAEU page it was read from: the course's catalogue page, the academic calendar, and the Student Account Office's refunds page. The assistant also said what it could not find (the title of CSBP301, which the course page does not give) instead of guessing it.

A second one was told to be a hard tester, in 18 calls: a course code that does not exist, a malformed one, a programme name that matches several, an impossible date, searches that match nothing, a calendar year nobody has read. Its marks were 8 of 10 for the design of the tools, 7 for the answers and 9 for the errors, and two of the faults it reported are fixed (see the build log for 10 November).

## License

MIT. See [LICENSE](LICENSE).
