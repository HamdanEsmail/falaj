# Falaj deploy runbook

How to take Falaj from this repo to a live Worker. Written for Git Bash on Windows. Do this only once I have decided to deploy. Each block stands alone: `cd` into the repo at the top. `STOP` means fix that and re-run the block.

Falaj runs on its own Cloudflare account: the free plan allows five scheduled jobs for one account, my other builds use them, and Falaj needs three. Every remote wrangler command is prefixed with that account's token and id from `../.cloudflare2.env` (never echo that file). Falaj's own secrets are Worker secrets; locally they live in `.dev.vars`. Never print a key, token or webhook URL.

## 0. Checks

```bash
cd "/c/Tinyfish Bounties/falaj" || exit 1
npm run check || { echo "STOP: npm run check failed"; exit 1; }
test -f .dev.vars && echo ".dev.vars present" || { echo "STOP: .dev.vars is missing"; exit 1; }
test -f ../.cloudflare2.env && echo ".cloudflare2.env present" || { echo "STOP: ../.cloudflare2.env is missing"; exit 1; }
CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare2.env | cut -d= -f2- | tr -d '\r\n') CLOUDFLARE_ACCOUNT_ID=$(grep -m1 '^CLOUDFLARE_ACCOUNT_ID=' ../.cloudflare2.env | cut -d= -f2- | tr -d '\r\n') npx wrangler whoami
```

## 1. Create the D1 database

```bash
cd "/c/Tinyfish Bounties/falaj" || exit 1
CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare2.env | cut -d= -f2- | tr -d '\r\n') CLOUDFLARE_ACCOUNT_ID=$(grep -m1 '^CLOUDFLARE_ACCOUNT_ID=' ../.cloudflare2.env | cut -d= -f2- | tr -d '\r\n') npx wrangler d1 create falaj
```

Paste the printed `database_id` into `wrangler.jsonc`, replacing `TBD-after-create`.

```bash
cd "/c/Tinyfish Bounties/falaj" || exit 1
DB_ID=<paste the database_id here>
[[ $DB_ID =~ ^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$ ]] || { echo "STOP: DB_ID is not a UUID"; exit 1; }
grep -q 'TBD-after-create' wrangler.jsonc || { echo "STOP: wrangler.jsonc has no TBD-after-create left to replace"; exit 1; }
sed -i "s/TBD-after-create/$DB_ID/" wrangler.jsonc
grep -n database_id wrangler.jsonc
```

## 2. Apply the migration remotely

```bash
cd "/c/Tinyfish Bounties/falaj" || exit 1
CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare2.env | cut -d= -f2- | tr -d '\r\n') CLOUDFLARE_ACCOUNT_ID=$(grep -m1 '^CLOUDFLARE_ACCOUNT_ID=' ../.cloudflare2.env | cut -d= -f2- | tr -d '\r\n') npm run migrate:remote
```

Success: `0001_init.sql` and `0002_failed_at_canaries_due.sql` applied.

## 3. First deploy, then secrets

Deploy once so `secret put` has a Worker to attach to, then put the three secrets without printing them. Generate `ADMIN_TOKEN` and `WEBHOOK_SECRET` with `openssl rand -hex 24` (48 hex characters). Store those two only in `.dev.vars`. Pipe each value into `wrangler secret put` so it never appears on the terminal.

```bash
cd "/c/Tinyfish Bounties/falaj" || exit 1
CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare2.env | cut -d= -f2- | tr -d '\r\n') CLOUDFLARE_ACCOUNT_ID=$(grep -m1 '^CLOUDFLARE_ACCOUNT_ID=' ../.cloudflare2.env | cut -d= -f2- | tr -d '\r\n') npm run deploy
```

Write down the printed URL (`https://falaj.<account>.workers.dev`). Then:

```bash
cd "/c/Tinyfish Bounties/falaj" || exit 1
# Each line pipes a value in; nothing is echoed.
grep -m1 '^WEBHOOK_SECRET=' .dev.vars | cut -d= -f2- | tr -d '\n' | CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare2.env | cut -d= -f2- | tr -d '\r\n') CLOUDFLARE_ACCOUNT_ID=$(grep -m1 '^CLOUDFLARE_ACCOUNT_ID=' ../.cloudflare2.env | cut -d= -f2- | tr -d '\r\n') npx wrangler secret put WEBHOOK_SECRET &&
grep -m1 '^ADMIN_TOKEN=' .dev.vars | cut -d= -f2- | tr -d '\n' | CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare2.env | cut -d= -f2- | tr -d '\r\n') CLOUDFLARE_ACCOUNT_ID=$(grep -m1 '^CLOUDFLARE_ACCOUNT_ID=' ../.cloudflare2.env | cut -d= -f2- | tr -d '\r\n') npx wrangler secret put ADMIN_TOKEN &&
grep -m1 '^TINYFISH_API_KEY=' .dev.vars | cut -d= -f2- | tr -d '\n' | CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare2.env | cut -d= -f2- | tr -d '\r\n') CLOUDFLARE_ACCOUNT_ID=$(grep -m1 '^CLOUDFLARE_ACCOUNT_ID=' ../.cloudflare2.env | cut -d= -f2- | tr -d '\r\n') npx wrangler secret put TINYFISH_API_KEY &&
CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare2.env | cut -d= -f2- | tr -d '\r\n') CLOUDFLARE_ACCOUNT_ID=$(grep -m1 '^CLOUDFLARE_ACCOUNT_ID=' ../.cloudflare2.env | cut -d= -f2- | tr -d '\r\n') npx wrangler secret list
```

Success: `secret list` shows `ADMIN_TOKEN`, `TINYFISH_API_KEY`, `WEBHOOK_SECRET`.

## 4. Point PUBLIC_BASE_URL at the Worker and deploy again

Webhook URLs are built from `PUBLIC_BASE_URL`. It must be the workers.dev address before any monitor is created. Local `wrangler dev` still uses localhost via `.dev.vars`.

```bash
cd "/c/Tinyfish Bounties/falaj" || exit 1
BASE=<url from step 3>        # https://falaj.<account>.workers.dev, no trailing slash
[[ $BASE =~ ^https://[^/]+$ ]] || { echo "STOP: BASE must look like https://falaj.<account>.workers.dev"; exit 1; }
sed -i "s#\"PUBLIC_BASE_URL\": \"[^\"]*\"#\"PUBLIC_BASE_URL\": \"$BASE\"#" wrangler.jsonc
grep -n PUBLIC_BASE_URL wrangler.jsonc
CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare2.env | cut -d= -f2- | tr -d '\r\n') CLOUDFLARE_ACCOUNT_ID=$(grep -m1 '^CLOUDFLARE_ACCOUNT_ID=' ../.cloudflare2.env | cut -d= -f2- | tr -d '\r\n') npm run deploy
```

## 5. Smoke the MCP endpoint

```bash
cd "/c/Tinyfish Bounties/falaj" || exit 1
npm run health -- https://falaj.<account>.workers.dev
```

Success: four lines (`initialize`, `tools/list`, `health_check`, `search_courses`), each HTTP 200, exit 0. `search_courses` uses one free Fetch URL.

## 6. Programme map, then canaries

Admin calls need `Authorization: Bearer <ADMIN_TOKEN>`. Do not print the token; keep it in a shell variable from `.dev.vars`.

```bash
cd "/c/Tinyfish Bounties/falaj" || exit 1
BASE=$(grep -o '"PUBLIC_BASE_URL": *"[^"]*"' wrangler.jsonc | cut -d'"' -f4)
ADMIN_TOKEN=$(grep -m1 '^ADMIN_TOKEN=' .dev.vars | cut -d= -f2- | tr -d '\n')
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$BASE/api/admin/program-map"; echo
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$BASE/api/admin/health-run"; echo
```

`program-map` reads the programmes index plus each programme page (about 76 free Fetch URLs) and answers `{programs: 75, …}`. `health-run` should mark every Fetch/Search tool `ok`. `get_academic_calendar` and `get_faculty_profile` stay skipped (`no cached data yet` / `no cached profile yet`) until step 7; they must not start a first Agent read.

## 7. First Agent reads (these cost money: look at the wallet first)

```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{}' "$BASE/api/admin/calendar-read"; echo
```

That starts one Agent run (about $0.06–$0.19). Wait for `POST /api/webhooks/agent/<secret>`. Then `get_academic_calendar` should return at least five dated items. A faculty profile read uses a URL named for academic leadership only, via `get_faculty_profile`.

## 8. Monitors (count the account's Monitors first)

```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$BASE/api/admin/monitors-init"; echo
curl -s "$BASE/api/health"; echo
```

Success: two monitor ids in `/api/health`. The handler creates a Monitor only while Falaj's `monitors` table has fewer than 2 rows, then upserts by page. It never lists, pauses, edits, resumes or deletes any other Monitor on the account. The two paused spike monitors already on the account are not Falaj's; leave them alone. Account total must stay ≤ 50.

## 9. Add to Claude Code

```bash
claude mcp add --transport http falaj https://falaj.<account>.workers.dev/mcp
```

Then `tools/list` from Claude Code and one `search_courses` call. Record the result in `docs/build-log.md`.

## Health demo

Deliberately mark `get_course` broken, call it, then clear:

```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"tool":"get_course","status":"broken","detail":"health demo"}' "$BASE/api/admin/tool-status"; echo
# Then tools/call get_course {code:"HSR140"} → SITE_CHANGED, no TinyFish call.
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$BASE/api/admin/health-run"; echo
# get_course is ok again if the live page still parses.
```

## Key rotation

```bash
cd "/c/Tinyfish Bounties/falaj" || exit 1
grep -m1 '^TINYFISH_API_KEY=' .dev.vars | cut -d= -f2- | tr -d '\n' | \
  CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' ../.cloudflare2.env | cut -d= -f2- | tr -d '\r\n') CLOUDFLARE_ACCOUNT_ID=$(grep -m1 '^CLOUDFLARE_ACCOUNT_ID=' ../.cloudflare2.env | cut -d= -f2- | tr -d '\r\n') \
  npx wrangler secret put TINYFISH_API_KEY
```

Rotate `ADMIN_TOKEN` or `WEBHOOK_SECRET` the same way. After rotating `WEBHOOK_SECRET`, deploy so `PUBLIC_BASE_URL` plus the new secret is what new monitors get, then re-run `monitors-init` only if the table is empty; otherwise update the two known monitors' webhook URLs through TinyFish by id (the ids in Falaj's `monitors` table). Never list the account's other monitors to find them.

## Caps (where to raise them)

All in `src/core/limits.ts`:

| Constant | Default | Meaning |
|---|---|---|
| `CALLER_PER_MINUTE` / `CALLER_PER_DAY` | 120 / 2000 | Per client IP on `POST /mcp` |
| `FETCH_URLS_PER_DAY` | 400 | TinyFetch URLs per UTC day |
| `AGENT_SLOTS` | 1 | Agent runs in flight |
| `AGENT_READS_PER_DAY` | 10 | New Agent reads per UTC day |
| `AGENT_MAX_STEPS` / `AGENT_MAX_DURATION_SECONDS` | 12 / 160 | Per Agent run |
| `BUDGET_SHARE_USD` / `BUDGET_PAUSE_USD` | 3.5 / 3.0 | Share of the wallet; pause new Agent reads |
| `MAX_MONITORS` | 2 | Rows Falaj will create |
| `CALENDAR_REFRESH_DAYS` / `PROFILE_CACHE_DAYS` / `STALE_DAYS` | 7 / 7 / 14 | Cache windows |
| `CANARY_SLOW_MS` | 20000 | Canary slower than this is `degraded` |

Prices are in `src/core/spend.ts`: `agent_step` 0.016, `monitor_check` 0.005, `fetch` 0, `search` 0.
