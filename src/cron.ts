// Cron triggers: nightly canaries at 22:00 UTC; Sunday 21:00 UTC force-refreshes
// the current-year calendar only when that cache row already exists; every quarter
// hour, the health pass a Monitor change is waiting for. Cron never starts a first
// Agent read.
import { requestCalendarRead } from "./agent/reads";
import { currentAcademicYear, daysBetween, nextAcademicYear } from "./core/dates";
import { CALENDAR_REFRESH_DAYS } from "./core/limits";
import { getCached } from "./db/agentCache";
import { canariesDue, clearCanariesDue } from "./db/monitors";
import type { Env } from "./env";
import { runCanaries } from "./health/run";
import { CALENDAR_URL } from "./parsers/calendar";
import type { ToolContext } from "./tools/types";

function cronContext(env: Env, ctx: ExecutionContext, now: Date): ToolContext {
  return { env, ctx, callerKey: "cron", now };
}

async function refreshCurrentYearIfExists(env: Env, ctx: ExecutionContext, now: Date): Promise<void> {
  const year = currentAcademicYear(now);
  if ((await getCached(env.DB, `${CALENDAR_URL}#${year}`)) === null) return;
  await requestCalendarRead(cronContext(env, ctx, now), year, { force: true });
}

async function refreshNextYearIfDue(env: Env, ctx: ExecutionContext, now: Date): Promise<void> {
  const year = nextAcademicYear(currentAcademicYear(now));
  const row = await getCached(env.DB, `${CALENDAR_URL}#${year}`);
  if (row === null || row.read_at === null) return;
  if (daysBetween(new Date(row.read_at), now) <= CALENDAR_REFRESH_DAYS) return;
  await requestCalendarRead(cronContext(env, ctx, now), year, { force: true });
}

export async function scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  const now = new Date();
  try {
    if (controller.cron === "0 22 * * *") {
      await runCanaries(env, ctx, "nightly");
      try {
        await refreshNextYearIfDue(env, ctx, now);
      } catch {
        // Slot busy or gated; the next nightly pass retries.
      }
    } else if (controller.cron.startsWith("0 21 * * ")) {
      // The Sunday trigger. Cloudflare counts Sunday as 1 and may report the day by name or by
      // number, so only the hour is matched: no other trigger fires at 21:00.
      await refreshCurrentYearIfExists(env, ctx, now);
    } else if (controller.cron === "*/15 * * * *") {
      // A Monitor reported a change: the pass runs here, where it has 15 minutes, and the mark is
      // cleared only once the pass has run. A pass that throws leaves the mark for the next run.
      if (await canariesDue(env.DB)) {
        await runCanaries(env, ctx, "monitor");
        await clearCanariesDue(env.DB, now);
      }
    }
  } catch (err) {
    console.error("cron failed", err instanceof Error ? err.message.slice(0, 200) : "unknown");
  }
}
