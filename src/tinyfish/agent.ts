// TinyAgent: a capped run that reads one page with a browser and answers a goal as structured
// data. A run is started here and never awaited in a tool's request path: its result arrives
// by webhook (or a later getRun). Steps are billed when the run finishes, not at start.
import { AGENT_MAX_DURATION_SECONDS, AGENT_MAX_STEPS } from "../core/limits";
import { PRICES } from "../core/spend";
import type { Env } from "../env";
import { TinyFishError, tinyfishFetch } from "./client";

const RUN_ASYNC_API = "https://agent.tinyfish.ai/v1/automation/run-async";
const RUNS_API = "https://agent.tinyfish.ai/v1/runs";

/** What an Agent run looks like to the rest of the Worker. */
export type AgentRun = { status: string; result: unknown; num_of_steps: number | null; error: string | null };

/**
 * Starts one run. There is no retry loop: the account allows two concurrent runs, shared with
 * other projects, so a 429 comes back as a TinyFishError (status 429) and the caller answers
 * RATE_LIMITED with scope "global".
 */
export async function startRun(
  env: Env,
  p: { url: string; goal: string; outputSchema: object; webhookUrl: string },
): Promise<{ runId: string }> {
  const res = await tinyfishFetch(env, RUN_ASYNC_API, {
    method: "POST",
    body: JSON.stringify({
      url: p.url,
      goal: p.goal,
      browser_profile: "lite",
      agent_config: { max_steps: AGENT_MAX_STEPS, max_duration_seconds: AGENT_MAX_DURATION_SECONDS },
      output_schema: p.outputSchema,
      webhook_url: p.webhookUrl,
    }),
  });
  const json = (await res.json()) as { run_id?: unknown };
  if (typeof json.run_id !== "string" || json.run_id === "") {
    throw new TinyFishError(502, "no_run_id", "TinyFish accepted the Agent run but returned no run_id");
  }
  return { runId: json.run_id };
}

/** True for the three statuses that end a run. Any other status is a run still in flight. */
export function isTerminal(status: string): boolean {
  return status === "COMPLETED" || status === "FAILED" || status === "CANCELLED";
}

function runError(v: unknown): string | null {
  if (typeof v === "string" && v !== "") return v;
  if (v !== null && typeof v === "object") {
    const o = v as { message?: unknown; code?: unknown };
    if (typeof o.message === "string" && o.message !== "") return o.message;
    if (typeof o.code === "string" && o.code !== "") return o.code;
  }
  return null;
}

export async function getRun(env: Env, runId: string): Promise<AgentRun> {
  const res = await tinyfishFetch(env, `${RUNS_API}/${encodeURIComponent(runId)}?screenshots=none&html=none`, {
    method: "GET",
  });
  const json = (await res.json()) as { status?: unknown; result?: unknown; num_of_steps?: unknown; error?: unknown };
  return {
    status: typeof json.status === "string" ? json.status.toUpperCase() : "UNKNOWN",
    result: json.result ?? null,
    num_of_steps:
      typeof json.num_of_steps === "number" && Number.isSafeInteger(json.num_of_steps) && json.num_of_steps >= 0
        ? json.num_of_steps
        : null,
    error: runError(json.error),
  };
}

/** What `n` Agent steps cost, in US dollars. */
export function stepsCost(n: number): number {
  return n * PRICES.agent_step;
}
