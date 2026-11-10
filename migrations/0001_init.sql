-- Falaj D1 schema (spec section 5).

-- One row per MCP tool call. Arguments are stored abbreviated and with email
-- local parts masked; the caller key is stored hashed, never as an IP.
CREATE TABLE calls (
  id TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  args_abbrev TEXT,
  ms INTEGER,
  status TEXT NOT NULL,
  error_code TEXT,
  key_hash TEXT,
  session_hash TEXT,
  at TEXT NOT NULL
);
CREATE INDEX calls_at ON calls (at);
CREATE INDEX calls_tool_at ON calls (tool, at);

-- The canaries' verdict per tool: ok | degraded | broken.
CREATE TABLE tool_status (
  tool TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  detail TEXT,
  last_ok_at TEXT,
  last_checked_at TEXT
);

-- Agent-backed reads (faculty profiles, the academic calendar), one row per URL.
CREATE TABLE agent_cache (
  url TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'ok', 'failed')),
  data TEXT,
  read_at TEXT,
  run_id TEXT,
  started_at TEXT,
  error TEXT,
  spend_usd REAL
);
CREATE INDEX agent_cache_kind_read_at ON agent_cache (kind, read_at);

CREATE TABLE canary_runs (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  trigger TEXT NOT NULL,
  results TEXT,
  duration_ms INTEGER
);

-- The two TinyFish Page monitors on the catalogue indexes.
CREATE TABLE monitors (
  page TEXT PRIMARY KEY,
  monitor_id TEXT,
  url TEXT,
  last_check_at TEXT,
  last_outcome TEXT,
  site_changed_at TEXT
);

-- The spend ledger: one row per TinyFish charge.
CREATE TABLE spend (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  amount_usd REAL NOT NULL,
  ref TEXT,
  at TEXT NOT NULL
);
CREATE INDEX spend_at ON spend (at);

-- Counters: per-caller limits (key_hash = hashed caller key) and global daily
-- caps (key_hash = 'global:<key>'), bucketed by 'm:<minute>' or 'd:<day>'.
CREATE TABLE rate (
  key_hash TEXT NOT NULL,
  bucket TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_hash, bucket)
);

-- Programme URL -> name, college and kind (bachelor, doctorate, minor,
-- micro_credential or other), rebuilt by the canaries.
CREATE TABLE program_map (
  url TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  college TEXT,
  kind TEXT NOT NULL DEFAULT 'other',
  built_at TEXT NOT NULL
);
