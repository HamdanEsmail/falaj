// get_academic_calendar: the student academic calendar, served from agent_cache
// (one row per academic-year tab). Dates are stored as shown ("17 Aug") and
// turned into ISO at serve time from the tab.
import { z } from "zod";
import { requestCalendarRead } from "../agent/reads";
import { currentAcademicYear, daysBetween, isAcademicYear, readableAcademicYears } from "../core/dates";
import { ToolError } from "../core/errors";
import { STALE_DAYS } from "../core/limits";
import { CALENDAR_URL, normalizeCalendar } from "../parsers/calendar";
import { ENVELOPE, stamp } from "./envelope";
import { defineTool } from "./types";

const OPTIONAL = {
  source_url: ENVELOPE.source_url.optional(),
  read_at: ENVELOPE.read_at.optional(),
  method: ENVELOPE.method.optional(),
  cached: ENVELOPE.cached.optional(),
  ttl_seconds: ENVELOPE.ttl_seconds,
};

export const getAcademicCalendar = defineTool({
  name: "get_academic_calendar",
  title: "Get the academic calendar",
  description:
    "Reads UAEU's student academic calendar for one academic-year tab (default: the current year, " +
    "which flips in August). Each dated row is returned under its semester heading with an ISO date " +
    "(the year comes from the tab: August–December the first year, January–July the second). " +
    "The page is JavaScript-rendered, so a first read starts a capped TinyAgent run and answers " +
    "{status: \"reading\", eta_seconds: 90} until that run finishes; call again then. " +
    "Cached reads older than 14 days set stale true. " +
    "Example: get_academic_calendar({\"academic_year\": \"2026-2027\"})",
  input: {
    academic_year: z
      .string()
      .optional()
      .describe("An academic year tab such as \"2026-2027\"; omitted uses the current one"),
  },
  output: {
    academic_year: z.string().optional(),
    semesters: z
      .array(
        z.object({
          name: z.string(),
          items: z.array(z.object({ date: z.string(), date_text: z.string(), title: z.string() })),
        }),
      )
      .optional(),
    dropped: z.number().optional(),
    stale: z.boolean().optional(),
    status: z.literal("reading").optional(),
    eta_seconds: z.number().optional(),
    retry: z.string().optional(),
    ...OPTIONAL,
  },
  async run({ academic_year: given }, t) {
    // The year is the cache key, so it is taken without spaces and must be a tab Falaj reads.
    const year = (given ?? "").replace(/\s+/g, "") || currentAcademicYear(t.now);
    if (!isAcademicYear(year)) {
      throw new ToolError("INVALID_INPUT", `academic_year must be two consecutive years such as "2026-2027"`, {
        fix: "Pass YYYY-YYYY with the second year one after the first, or omit it for the current year",
      });
    }
    const tabs = readableAcademicYears(t.now);
    if (!tabs.includes(year)) {
      throw new ToolError("INVALID_INPUT", `academic_year must be one of ${tabs.join(", ")}`, {
        fix: "Pass one of those years, or omit it for the current year",
      });
    }
    const r = await requestCalendarRead(t, year);
    if (r.status === "reading") {
      return {
        status: "reading" as const,
        eta_seconds: r.eta_seconds,
        retry: `call again in ${r.eta_seconds} seconds`,
      };
    }
    const cal = normalizeCalendar(r.data, year);
    if (cal === null) {
      throw new ToolError("SITE_CHANGED", `The academic calendar for ${year} could not be read`, {
        source_url: CALENDAR_URL,
        fix: "UAEU changed this page; health_check shows when it was last seen working, so try again later",
      });
    }
    const stale = daysBetween(new Date(r.read_at), t.now) > STALE_DAYS;
    return stamp(
      { ...cal, stale },
      { source_url: CALENDAR_URL, method: "agent_cached", cached: true, read_at: new Date(r.read_at) },
    );
  },
});
