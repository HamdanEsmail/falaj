// What the page is drawn from: each tool's last check, what is left of the day's share, and the
// latest calls. All of it is Falaj's own record; drawing the page reads nothing from the university.
import { AGENT_READS_PER_DAY, FETCH_URLS_PER_DAY } from "../core/limits";
import { recentCalls } from "../db/calls";
import { today, utcDay } from "../db/counters";
import { allToolStatus } from "../db/toolStatus";
import type { ToolName } from "../tools/types";
import { atGulf, countWord } from "./format";
import { PAGE_ORDER } from "./tools";

export type ToolState = {
  name: ToolName;
  state: "running" | "warning" | "stopped" | "unchecked";
  line: string;
};

export type LoggedCall = { tool: string; args_abbrev: string | null; ms: number | null; status: string; error_code: string | null; at: string };

export type PageData = {
  base: string;
  now: Date;
  tools: ToolState[];
  /** "All ten are running", "Nine of ten are running" (the rest stopped or not checked yet), or null before any check. */
  verdict: string | null;
  pagesLeft: number;
  pagesUsed: number;
  readsLeft: number;
  readsUsed: number;
  calls: LoggedCall[];
};

/** The two tools whose page only a real browser can read. Until that first read they have nothing to check. */
const NEEDS_BROWSER: ReadonlySet<string> = new Set(["get_faculty_profile", "get_academic_calendar"]);

export async function pageData(db: D1Database, base: string, now: Date): Promise<PageData> {
  const day = utcDay(now);
  const [status, pagesUsed, readsUsed, calls] = await Promise.all([
    allToolStatus(db),
    today(db, "fetch_urls", day),
    today(db, "agent_reads", day),
    recentCalls(db, 8),
  ]);

  const tools: ToolState[] = PAGE_ORDER.map((name) => {
    const row = status.get(name);
    // health_check has no page that can change under it: once a health pass has run, it is running.
    if (!row && name === "health_check" && status.size > 0) return { name, state: "running", line: "Answers from Falaj's own record" };
    if (!row) return { name, state: "unchecked", line: NEEDS_BROWSER.has(name) ? "Not read yet: its first read needs a real browser" : "Not checked yet" };
    if (row.status === "broken") {
      const when = row.last_checked_at ? ` ${atGulf(row.last_checked_at, now)}` : "";
      return { name, state: "stopped", line: `Stopped${when}: ${row.detail ?? "the page it reads has changed"}` };
    }
    const answered = row.last_ok_at ? `Answered ${atGulf(row.last_ok_at, now)}` : "Answered";
    if (row.status === "degraded") return { name, state: "warning", line: `${answered}, with a warning: ${row.detail ?? "slower than usual"}` };
    return { name, state: "running", line: answered };
  });

  const stopped = tools.filter((t) => t.state === "stopped").length;
  const unchecked = tools.filter((t) => t.state === "unchecked").length;
  const total = tools.length;
  const answering = total - stopped - unchecked;
  const verdict =
    answering === total
      ? `All ${countWord(total).toLowerCase()} are running`
      : answering > 0 || stopped > 0
        ? `${countWord(answering)} of ${countWord(total).toLowerCase()} are running`
        : null;

  return {
    base: base.replace(/\/$/, ""),
    now,
    tools,
    verdict,
    pagesLeft: Math.max(FETCH_URLS_PER_DAY - pagesUsed, 0),
    pagesUsed,
    readsLeft: Math.max(AGENT_READS_PER_DAY - readsUsed, 0),
    readsUsed,
    calls,
  };
}
