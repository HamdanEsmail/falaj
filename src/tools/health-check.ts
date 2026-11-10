// health_check: Falaj's own view of its tools from tool_status, monitors and spend.
// It reads no UAEU page.
import { z } from "zod";
import { BUDGET_PAUSE_USD, BUDGET_SHARE_USD } from "../core/limits";
import { totalSpend } from "../core/spend";
import { allToolStatus } from "../db/toolStatus";
import { ENVELOPE, stamp } from "./envelope";
import { defineTool, type ToolName } from "./types";

const TOOL_KEYS: readonly ToolName[] = [
  "health_check",
  "search_courses",
  "get_course",
  "list_programs",
  "get_program",
  "list_events",
  "academic_deadlines",
  "find_faculty",
  "get_faculty_profile",
  "get_academic_calendar",
];

const TOOL_ROW = z.object({
  status: z.enum(["ok", "degraded", "broken"]),
  last_ok_at: z.string().nullable(),
  last_checked_at: z.string().nullable(),
  detail: z.string().nullable(),
});

export const healthCheck = defineTool({
  name: "health_check",
  title: "Health check",
  description:
    "Reports whether each Falaj tool is currently working against uaeu.ac.ae (ok, degraded or broken, " +
    "from the nightly canaries), when UAEU last changed a watched page, and the page monitors' last checks. " +
    "Reads no UAEU page. Example: health_check({})",
  input: {},
  output: {
    checked_at: z.string(),
    tools: z.record(z.string(), TOOL_ROW),
    site_changed_at: z.string().nullable(),
    monitors: z.array(
      z.object({
        page: z.string(),
        last_check_at: z.string().nullable(),
        last_outcome: z.string().nullable(),
      }),
    ),
    spend: z.object({
      used_usd: z.number(),
      share_usd: z.number(),
      paused: z.boolean(),
    }),
    ...ENVELOPE,
  },
  async run(_args, t) {
    const checked_at = t.now.toISOString();
    const statuses = await allToolStatus(t.env.DB);
    const tools: Record<string, z.infer<typeof TOOL_ROW>> = {};
    for (const name of TOOL_KEYS) {
      if (name === "health_check") {
        tools[name] = {
          status: "ok",
          last_ok_at: checked_at,
          last_checked_at: checked_at,
          detail: null,
        };
        continue;
      }
      const row = statuses.get(name);
      tools[name] = row
        ? {
            status: row.status,
            last_ok_at: row.last_ok_at,
            last_checked_at: row.last_checked_at,
            detail: row.detail,
          }
        : { status: "ok", last_ok_at: null, last_checked_at: null, detail: null };
    }

    const { results: monitors } = await t.env.DB.prepare(
      "SELECT page, last_check_at, last_outcome FROM monitors ORDER BY page",
    ).all<{ page: string; last_check_at: string | null; last_outcome: string | null }>();
    const changed = await t.env.DB.prepare("SELECT MAX(site_changed_at) AS at FROM monitors").first<{
      at: string | null;
    }>();
    const used = await totalSpend(t.env.DB);
    return stamp(
      {
        checked_at,
        tools,
        site_changed_at: changed?.at ?? null,
        monitors,
        spend: { used_usd: used, share_usd: BUDGET_SHARE_USD, paused: used >= BUDGET_PAUSE_USD },
      },
      { source_url: `${t.env.PUBLIC_BASE_URL}/api/health`, method: "status", cached: false, read_at: t.now },
    );
  },
});
