// One fixture per tool (except health_check). A check that fails marks the tool
// broken; slower than CANARY_SLOW_MS, or a stale calendar, is degraded.
import { CATALOGUE_URL, PROGRAM_INDEX_URL } from "../catalogue/read";
import { ToolError } from "../core/errors";
import { EVENTS_URL, REFUNDS_URL } from "../pages/read";
import { CALENDAR_URL } from "../parsers/calendar";
import { FACULTY_DIRECTORY_URL } from "../tools/find-faculty";
import type { ToolName } from "../tools/types";

export const HSR140_URL = "https://www.uaeu.ac.ae/en/catalog/courses/course_2924.shtml?id=HSR140";
export const MDS_URL = `${PROGRAM_INDEX_URL}bachelor-of-science-in-the-mathematics-of-data-science.shtml`;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export type CanaryLevel = "ok" | "degraded" | "broken";

export type Canary = {
  tool: ToolName;
  args: unknown;
  check(result: unknown): { level: CanaryLevel; detail: string };
  costs: "fetch" | "search" | "agent_cached";
  /** UAEU page named in SITE_CHANGED when this tool is broken. */
  page: string;
  /** Parser file named in the SITE_CHANGED fix. */
  parser: string;
};

function rec(result: unknown): Record<string, unknown> | null {
  return result !== null && typeof result === "object" ? (result as Record<string, unknown>) : null;
}

function len(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}

export const CANARIES: readonly Canary[] = [
  {
    tool: "get_course",
    args: { code: "HSR140" },
    costs: "fetch",
    page: HSR140_URL,
    parser: "course.ts",
    check(result) {
      const r = rec(result);
      if (!r || r.credit_hours !== 3 || typeof r.description !== "string" || r.description === "") {
        return { level: "broken", detail: "HSR140 credit hours missing or description empty" };
      }
      return { level: "ok", detail: "HSR140 credit hours 3" };
    },
  },
  {
    tool: "search_courses",
    args: { query: "ECON" },
    costs: "fetch",
    page: CATALOGUE_URL,
    parser: "catalogue.ts",
    check(result) {
      const n = Number(rec(result)?.total_matches ?? 0);
      if (n < 10) return { level: "broken", detail: `ECON matches ${n}, need ≥ 10` };
      return { level: "ok", detail: `ECON matches ${n}` };
    },
  },
  {
    tool: "list_programs",
    args: {},
    costs: "fetch",
    page: PROGRAM_INDEX_URL,
    parser: "program.ts",
    check(result) {
      const n = Number(rec(result)?.total ?? 0);
      if (n < 70) return { level: "broken", detail: `programmes ${n}, need ≥ 70` };
      return { level: "ok", detail: `programmes ${n}` };
    },
  },
  {
    tool: "get_program",
    args: { name_or_url: "Mathematics of Data Science" },
    costs: "fetch",
    page: MDS_URL,
    parser: "program.ts",
    check(result) {
      const n = len(rec(result)?.degree_plan);
      if (n < 80) return { level: "broken", detail: `degree_plan ${n}, need ≥ 80` };
      return { level: "ok", detail: `degree_plan ${n}` };
    },
  },
  {
    tool: "list_events",
    args: {},
    costs: "fetch",
    page: EVENTS_URL,
    parser: "events.ts",
    check(result) {
      const dated = Array.isArray(rec(result)?.events)
        ? (rec(result)!.events as { date?: unknown }[]).filter((e) => typeof e.date === "string" && ISO_DAY.test(e.date))
            .length
        : 0;
      if (dated < 1) return { level: "broken", detail: "no event with an ISO date" };
      return { level: "ok", detail: `${dated} dated events` };
    },
  },
  {
    tool: "academic_deadlines",
    args: {},
    costs: "fetch",
    page: REFUNDS_URL,
    parser: "deadlines.ts",
    check(result) {
      const n = len(rec(result)?.deadlines);
      if (n < 3) return { level: "broken", detail: `deadlines ${n}, need ≥ 3` };
      return { level: "ok", detail: `deadlines ${n}` };
    },
  },
  {
    tool: "find_faculty",
    args: { query: "mathematics" },
    costs: "search",
    page: FACULTY_DIRECTORY_URL,
    parser: "faculty.ts",
    check(result) {
      const n = len(rec(result)?.people);
      if (n < 1) return { level: "broken", detail: "no faculty profile for mathematics" };
      return { level: "ok", detail: `people ${n}` };
    },
  },
  {
    tool: "get_academic_calendar",
    args: {},
    costs: "agent_cached",
    page: CALENDAR_URL,
    parser: "calendar.ts",
    check(result) {
      const r = rec(result);
      const items = Array.isArray(r?.semesters)
        ? (r!.semesters as { items?: unknown }[]).reduce((n, s) => n + len(s.items), 0)
        : 0;
      if (items < 5) return { level: "broken", detail: `dated items ${items}, need ≥ 5` };
      if (r?.stale === true) return { level: "degraded", detail: `dated items ${items}, stale` };
      return { level: "ok", detail: `dated items ${items}` };
    },
  },
  {
    tool: "get_faculty_profile",
    args: {},
    costs: "agent_cached",
    page: FACULTY_DIRECTORY_URL,
    parser: "calendar.ts",
    check(result) {
      const r = rec(result);
      if (!r || typeof r.name !== "string" || r.name === "") {
        return { level: "broken", detail: "cached profile missing a name" };
      }
      return { level: "ok", detail: "cached profile readable" };
    },
  },
];

export function canaryByTool(tool: string): Canary | undefined {
  return CANARIES.find((c) => c.tool === tool);
}

/** SITE_CHANGED body for a tool whose canary is currently broken. */
export function brokenGateError(tool: string, detail: string | null, lastCheckedAt: string | null): ToolError {
  const canary = canaryByTool(tool);
  const page = canary?.page ?? CATALOGUE_URL;
  const parser = canary?.parser ?? "catalogue.ts";
  const when = lastCheckedAt ?? "unknown";
  return new ToolError("SITE_CHANGED", `${page} changed: ${detail ?? "canary failed"} (canary failed at ${when})`, {
    source_url: page,
    fix: `See /api/health; the parser in src/parsers/${parser} needs updating`,
  });
}
