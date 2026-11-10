// Agent and Monitor webhooks. TinyFish calls these when a run finishes; the URL
// carries a secret segment because the payload has no signature. The body is
// untrusted input: it is parsed and validated before anything is stored or run.
// An Agent callback only says which run to look at: the run's status, result and
// step count are read from TinyFish itself.
import { Hono } from "hono";
import { settleRun } from "../agent/reads";
import { safeEqual } from "../auth";
import { AGENT_ADOPT_AFTER_MS } from "../core/limits";
import { PRICES, recordSpend } from "../core/spend";
import { adoptRunId, getByRunId } from "../db/agentCache";
import { getByMonitorId, monitorCheckRecorded, recordMonitorCheck } from "../db/monitors";
import type { Env } from "../env";
import { isTerminal } from "../tinyfish/agent";

export const webhooksRouter = new Hono<{ Bindings: Env }>();

function secretMatches(given: string, expected: unknown): boolean {
  return typeof expected === "string" && expected !== "" && safeEqual(given, expected);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MAX_ID_LENGTH = 200;

/**
 * The run id and status of an Agent callback. They are looked for at the top level and inside a
 * `data` or `run` object; the run id is `run_id` or `id`, and the status is upper-cased.
 */
function readAgentPayload(data: unknown): { runId: string | null; status: string | null } {
  if (!isRecord(data)) return { runId: null, status: null };
  const layers = [data, data.data, data.run].filter(isRecord);
  const pick = (key: string): string | null => {
    for (const layer of layers) {
      const value = layer[key];
      if (typeof value === "string" && value !== "") return value;
    }
    return null;
  };
  const runId = pick("run_id") ?? pick("id");
  const status = pick("status");
  return {
    runId: runId !== null && runId.length <= MAX_ID_LENGTH ? runId : null,
    status: status === null ? null : status.toUpperCase(),
  };
}

webhooksRouter.post("/agent/:secret", async (c) => {
  if (!secretMatches(c.req.param("secret"), c.env.WEBHOOK_SECRET)) return c.body(null, 401);

  let data: unknown;
  try {
    data = JSON.parse(await c.req.text());
  } catch {
    return c.json({ ignored: true });
  }
  const { runId, status } = readAgentPayload(data);
  if (runId === null) return c.json({ ignored: true });

  // A run id no row holds is the run whose id could not be stored when it started, when such a
  // pending row exists. Any other unknown run id answers 200 and changes nothing.
  if ((await getByRunId(c.env.DB, runId)) === null) {
    const startedBefore = new Date(Date.now() - AGENT_ADOPT_AFTER_MS);
    if (!(await adoptRunId(c.env.DB, runId, startedBefore))) return c.json({ ignored: true });
  }
  // Only COMPLETED, FAILED and CANCELLED end a run. Any other status the callback names leaves the
  // row pending and the slot held.
  if (status !== null && !isTerminal(status)) return c.json({ ok: true });
  // The run is settled from TinyFish's own record of it. When that cannot be read, or says the run
  // is still in flight, the row stays pending and a later call reads the run again.
  if (!(await settleRun(c.env, runId))) return c.json({ ok: true, deferred: true });
  return c.json({ ok: true });
});

export type MonitorPayload = {
  id: string;
  monitorId: string;
  outcome: string;
  isBaseline: boolean;
};

/** Null unless the body is JSON with a run id and a monitor id. Other fields are read tolerantly. */
export function parseMonitorPayload(raw: string): MonitorPayload | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  const { id, fetch_monitor_id: monitorId } = data;
  if (typeof id !== "string" || id === "" || id.length > MAX_ID_LENGTH) return null;
  if (typeof monitorId !== "string" || monitorId === "" || monitorId.length > MAX_ID_LENGTH) return null;
  return {
    id,
    monitorId,
    outcome: typeof data.outcome === "string" ? data.outcome : "unknown",
    isBaseline: data.is_baseline === true || data.outcome === "baseline",
  };
}

webhooksRouter.post("/monitor/:secret", async (c) => {
  if (!secretMatches(c.req.param("secret"), c.env.WEBHOOK_SECRET)) return c.body(null, 401);

  const payload = parseMonitorPayload(await c.req.text());
  if (payload === null) return c.json({ ignored: true });

  const row = await getByMonitorId(c.env.DB, payload.monitorId);
  if (row === null) return c.json({ ignored: true });

  if (await monitorCheckRecorded(c.env.DB, payload.id)) return c.json({ duplicate: true });

  const now = new Date();
  const changed = payload.outcome === "changed" && !payload.isBaseline;
  await recordMonitorCheck(c.env.DB, payload.monitorId, payload.outcome, now, changed);
  await recordSpend(c.env.DB, "monitor_check", PRICES.monitor_check, payload.id);

  if (!changed) return c.json({ ok: true });

  // The health pass reads about 85 pages one after another, which takes longer than the 30 seconds a
  // request may keep working after its answer. The change is only marked here (recordMonitorCheck set
  // canaries_due_at); the quarter-hour job runs the pass, where it has 15 minutes.
  return c.json({ changed: true, canaries: "due" });
});
