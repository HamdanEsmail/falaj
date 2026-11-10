// The ten tools as the page shows them: the order of the wells, a line of plain words for each,
// and the arguments read from the same schemas tools/list serves, so the page cannot drift from
// what an assistant is told.
import { toolJsonSchemas } from "../mcp/server";
import { toolByName } from "../tools/registry";
import type { ToolName } from "../tools/types";

export const PAGE_ORDER = [
  "search_courses",
  "get_course",
  "list_programs",
  "get_program",
  "list_events",
  "academic_deadlines",
  "find_faculty",
  "get_faculty_profile",
  "get_academic_calendar",
  "health_check",
] as const satisfies readonly ToolName[];

type Words = { says: string; gives: string; reads: string; example: string };

export const WORDS: Record<ToolName, Words> = {
  search_courses: {
    says: "find courses by code, title or topic",
    gives: "each course's code, title, college and link",
    reads: "the course catalogue, with TinyFish Fetch",
    example: 'search_courses({ "query": "machine learning" })',
  },
  get_course: {
    says: "one course: what it covers, credit hours",
    gives: "title, description, credit hours, learning outcomes",
    reads: "the catalogue, then the course's own page, with TinyFish Fetch",
    example: 'get_course({ "code": "HSR140" })',
  },
  list_programs: {
    says: "every programme, by college or kind",
    gives: "each programme's name, college, kind and link",
    reads: "the programmes index, with TinyFish Fetch",
    example: 'list_programs({ "kind": "minor" })',
  },
  get_program: {
    says: "one programme and its degree plan",
    gives: "description, objectives, credit hours, every course in the plan",
    reads: "the programme's own page, with TinyFish Fetch",
    example: 'get_program({ "name_or_url": "Mathematics of Data Science" })',
  },
  list_events: {
    says: "the university's highlighted events",
    gives: "each event's date, title and link",
    reads: "the events page, with TinyFish Fetch",
    example: "list_events({})",
  },
  academic_deadlines: {
    says: "withdrawal dates and refunds",
    gives: "each deadline, its date or rule, and the refund",
    reads: "the student accounts refund page, with TinyFish Fetch",
    example: "academic_deadlines({})",
  },
  find_faculty: {
    says: "people by name or field",
    gives: "name, title, college and profile link",
    reads: "the university's site, with TinyFish Search",
    example: 'find_faculty({ "query": "robotics" })',
  },
  get_faculty_profile: {
    says: "one person's public profile",
    gives: "title, department, research interests, education",
    reads: "the profile page, which needs a real browser: a TinyFish Agent reads it once and Falaj keeps the answer for a week",
    example: 'get_faculty_profile({ "profile_url": "https://www.uaeu.ac.ae/en/cit/profile.shtml?email=…" })',
  },
  get_academic_calendar: {
    says: "the year's dates by semester",
    gives: "every dated row of the academic year, by semester",
    reads: "the calendar page, which needs a real browser: a TinyFish Agent reads it once a week",
    example: 'get_academic_calendar({ "academic_year": "2026-2027" })',
  },
  health_check: {
    says: "what is working right now",
    gives: "each tool's state, the last check, the two page watches",
    reads: "Falaj's own record of last night's checks",
    example: "health_check({})",
  },
};

export type Param = { name: string; kind: string; about: string };

type Property = { type?: string; enum?: unknown[]; maximum?: number; description?: string };

function kindOf(p: Property): string {
  if (Array.isArray(p.enum)) return `one of ${p.enum.join(", ")}`;
  if (p.type === "number" || p.type === "integer") return p.maximum !== undefined ? `a number up to ${p.maximum}` : "a number";
  if (p.type === "boolean") return "yes or no";
  return "text";
}

/** The arguments of one tool, in the order its schema lists them. */
export function paramsOf(name: ToolName): Param[] {
  const def = toolByName(name);
  if (!def) return [];
  const schema = toolJsonSchemas(def).inputSchema as { properties?: Record<string, Property>; required?: string[] };
  const needed = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).map(([key, p]) => ({
    name: key,
    kind: needed.has(key) ? `${kindOf(p)}, needed` : kindOf(p),
    about: p.description ?? "",
  }));
}
