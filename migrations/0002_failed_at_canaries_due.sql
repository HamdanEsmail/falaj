-- When the row's last started run ended without a usable result. A new run for the same key is
-- refused until AGENT_FAILED_RETRY_HOURS has passed since then.
ALTER TABLE agent_cache ADD COLUMN failed_at TEXT;

-- Set when a Monitor reports a change. The canary pass that answers it is run by cron, which
-- clears the column once the pass is recorded.
ALTER TABLE monitors ADD COLUMN canaries_due_at TEXT;
