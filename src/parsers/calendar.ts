// Agent goals, output schemas and serve-time normalizers for the academic calendar
// and faculty profile pages. Both pages are JavaScript-rendered; Fetch returns
// only a language notice, so they are Agent reads. Raw Agent JSON is stored;
// these functions turn it into what the tools return. Null means the result is
// not usable (no name, no semesters) and the cache row is marked failed.

import { resolveCalendarDate } from "../core/dates";

export const CALENDAR_URL = "https://www.uaeu.ac.ae/en/calendar/";

export const CALENDAR_GOAL = (year: string): string =>
  `This is UAEU's academic calendar with academic-year tabs such as 2025-2026 and 2026-2027. Click the tab for ${year} if it is not already selected. Then list every dated row shown for that year, grouped under the semester heading it appears beneath (for example Fall Semester, Spring Semester, Summer). For each row return date exactly as shown (for example '17 Aug') and title exactly as shown. Do not navigate to other pages.`;

export const CALENDAR_SCHEMA = {
  type: "object",
  required: ["academic_year", "semesters"],
  properties: {
    academic_year: { type: "string" },
    semesters: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "items"],
        properties: {
          name: { type: "string" },
          items: {
            type: "array",
            items: {
              type: "object",
              required: ["date", "title"],
              properties: { date: { type: "string" }, title: { type: "string" } },
            },
          },
        },
      },
    },
  },
} as const;

export type CalendarItem = { date: string; date_text: string; title: string };
export type CalendarSemester = { name: string; items: CalendarItem[] };
export type CalendarData = { academic_year: string; semesters: CalendarSemester[]; dropped: number };

export function normalizeCalendar(result: unknown, year: string): CalendarData | null {
  if (result === null || typeof result !== "object") return null;
  const semestersIn = (result as { semesters?: unknown }).semesters;
  if (!Array.isArray(semestersIn) || semestersIn.length === 0) return null;
  let dropped = 0;
  const semesters: CalendarSemester[] = [];
  for (const raw of semestersIn) {
    if (raw === null || typeof raw !== "object") continue;
    const s = raw as { name?: unknown; items?: unknown };
    const name = typeof s.name === "string" ? s.name : "";
    if (!Array.isArray(s.items)) continue;
    const items: CalendarItem[] = [];
    for (const it of s.items) {
      if (it === null || typeof it !== "object") continue;
      const row = it as { date?: unknown; title?: unknown };
      const dateText = typeof row.date === "string" ? row.date : "";
      const title = typeof row.title === "string" ? row.title : "";
      const iso = resolveCalendarDate(dateText, year, name);
      if (iso === null) {
        dropped += 1;
        continue;
      }
      items.push({ date: iso, date_text: dateText, title });
    }
    if (items.length > 0) semesters.push({ name, items });
  }
  if (semesters.length === 0) return null;
  return { academic_year: year, semesters, dropped };
}

export const PROFILE_GOAL =
  "This is a UAEU faculty profile page. Return the person's full name, academic title, college, department, email address if shown on the page, research interests as a list of short phrases, and education as a list of degree lines, each exactly as shown. Leave out any field the page does not show. Do not navigate to other pages.";

// One plain type per field: TinyFish answers 400 INVALID_INPUT to a "type" that is a list, so a
// run with a ["string", "null"] field never starts. Only the name is required.
export const PROFILE_SCHEMA = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string" },
    title: { type: "string" },
    college: { type: "string" },
    department: { type: "string" },
    email: { type: "string" },
    research_interests: { type: "array", items: { type: "string" } },
    education: { type: "array", items: { type: "string" } },
  },
} as const;

export type ProfileData = {
  name: string;
  title: string | null;
  college: string | null;
  department: string | null;
  email: string | null;
  research_interests: string[];
  education: string[];
  profile_url: string;
};

function strOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function normalizeProfile(result: unknown, url: string): ProfileData | null {
  if (result === null || typeof result !== "object") return null;
  const o = result as Record<string, unknown>;
  if (typeof o.name !== "string" || o.name.trim() === "") return null;
  return {
    name: o.name.trim(),
    title: strOrNull(o.title),
    college: strOrNull(o.college),
    department: strOrNull(o.department),
    email: strOrNull(o.email),
    research_interests: strList(o.research_interests),
    education: strList(o.education),
    profile_url: url,
  };
}
