// One course page (https://www.uaeu.ac.ae/en/catalog/courses/course_<n>.shtml?id=<CODE>) as markdown.
// The site's page for a department can carry several courses back to back, each opened by
// `# <Title> (<CODE>)`, so the parser reads only the section of the code it was asked for: from its
// heading to the next `# ` heading or the Arabic "sorry" notice (`### عفوا`). Pure and tolerant:
// a missing part gives "", null or [], and only a missing heading gives null.
import { COURSE_CODE } from "./catalogue";

export type Course = {
  code: string;
  title: string;
  description: string;
  credit_hours: number | null;
  learning_outcomes: string[];
  prerequisites: string[];
};

// Whitespace is allowed inside the parentheses: four catalogue codes (AERO485, SWEB698, PHYS501,
// PHYS502) carry a trailing space on the site, so their heading may read `(AERO485 )`.
const COURSE_HEADING = /^#\s+(.+?)\s*\(\s*([A-Za-z]{2,5}\d{3,4}[A-Za-z]?)\s*\)\s*$/;
const NEXT_HEADING = /^#\s/;
const ARABIC_NOTICE = /^#{1,6}\s*عفوا/;
const SUB_HEADING = /^#{2,6}\s/;
const CREDIT_HOURS = /^(?:#{1,6}\s*)?Credit\s+Hours?\s*:\s*(\d+(?:\.\d+)?)/i;
const OUTCOMES_HEADING = /^#{2,6}\s*Course\s+Learning\s+Outcomes/i;
const LIST_ITEM = /^\s*(?:\d+[.)]|[*+-])\s+(\S.*?)\s*$/;
const PREREQUISITE = /^(?:#{1,6}\s*|[*+-]\s+)?Pre-?requisites?\b(?:\s*\(s\))?\s*[:\-–]?\s*(.*?)\s*$/i;
const NO_PREREQUISITE = /^(?:none|nil|n\/a|na|-|–)\.?$/i;

function splitPrerequisites(s: string): string[] {
  return s
    .split(/[,;]/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p !== "" && !NO_PREREQUISITE.test(p));
}

/** The requested course's title, description, credit hours, outcomes and prerequisites, or null if its heading is absent. */
export function parseCoursePage(text: string, code: string): Course | null {
  const wanted = typeof code === "string" ? code.trim().toUpperCase() : "";
  if (!COURSE_CODE.test(wanted) || typeof text !== "string") return null;
  const lines = text.split(/\r?\n/);

  let start = -1;
  let title = "";
  for (let i = 0; i < lines.length; i++) {
    const m = COURSE_HEADING.exec(lines[i]!);
    if (m && m[2]!.toUpperCase() === wanted) {
      start = i;
      title = m[1]!.replace(/\s+/g, " ").trim();
      break;
    }
  }
  if (start < 0) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (NEXT_HEADING.test(lines[i]!) || ARABIC_NOTICE.test(lines[i]!)) {
      end = i;
      break;
    }
  }

  const description: string[] = [];
  const outcomes: string[] = [];
  const prerequisites: string[] = [];
  let creditHours: number | null = null;
  // "description" until the first sub-heading; then "credit", "outcomes", "prerequisite" or "other".
  let section: "description" | "credit" | "outcomes" | "prerequisite" | "other" = "description";

  for (const line of lines.slice(start + 1, end)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;

    const credit = CREDIT_HOURS.exec(trimmed);
    if (credit) {
      if (creditHours === null) creditHours = Number(credit[1]);
      if (trimmed.startsWith("#")) section = "credit";
      continue;
    }
    const prerequisite = PREREQUISITE.exec(trimmed);
    if (prerequisite) {
      prerequisites.push(...splitPrerequisites(prerequisite[1]!));
      if (prerequisite[1] === "") section = "prerequisite";
      continue;
    }
    if (SUB_HEADING.test(trimmed)) {
      if (/^#{2,6}\s*Credit\s+Hours?\b/i.test(trimmed)) section = "credit";
      else section = OUTCOMES_HEADING.test(trimmed) ? "outcomes" : "other";
      continue;
    }

    if (section === "description") description.push(trimmed);
    else if (section === "outcomes") {
      const item = LIST_ITEM.exec(line);
      if (item) outcomes.push(item[1]!.replace(/\s+/g, " "));
    } else if (section === "credit" && creditHours === null && /^\d+(?:\.\d+)?$/.test(trimmed)) {
      creditHours = Number(trimmed);
    } else if (section === "prerequisite") {
      const item = LIST_ITEM.exec(line);
      prerequisites.push(...splitPrerequisites(item ? item[1]! : trimmed));
    }
  }

  return {
    code: wanted,
    title,
    description: description.join("\n\n"),
    credit_hours: creditHours,
    learning_outcomes: outcomes,
    prerequisites,
  };
}
