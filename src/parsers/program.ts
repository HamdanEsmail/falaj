// The undergraduate programmes index (/en/catalog/undergraduate/programs/) and one programme page
// (/en/catalog/undergraduate/programs/<slug>.shtml), as TinyFetch returns them. Pure and tolerant:
// a missing section gives "", null or [], and nothing throws.

/**
 * College abbreviations as the catalogue writes them ("... hosted by the Department of
 * Mathematical Sciences, COS") mapped to the college names. The same abbreviations key the
 * faculty directory's URL segments.
 */
export const COLLEGE_BY_ABBREV: Readonly<Record<string, string>> = {
  COS: "College of Science",
  CIT: "College of Information Technology",
  CBE: "College of Business and Economics",
  CHSS: "College of Humanities and Social Sciences",
  CEDU: "College of Education",
  COE: "College of Engineering",
  CAVM: "College of Agriculture and Veterinary Medicine",
  CMHS: "College of Medicine and Health Sciences",
  COL: "College of Law",
};

/** Pages under /programs/ that are not programmes and so never reach the programme list. */
export const NON_PROGRAMME_SLUGS: readonly string[] = ["general-education-requirements"];

export const PROGRAM_KINDS = ["bachelor", "doctorate", "minor", "micro_credential", "other"] as const;
export type ProgramKind = (typeof PROGRAM_KINDS)[number];

// Prefixes of a name once lower-cased and stripped of everything but letters, so the page's
// "Credit-bearing Micro-credential in AI" and the slug's "Creditbearing Microcredential in AI" agree.
// "Minor of" is the site's wording for three minors (microwave, systems, combustion).
const KIND_PREFIXES: readonly (readonly [string, ProgramKind])[] = [
  ["bachelorof", "bachelor"],
  ["doctorof", "doctorate"],
  ["phd", "doctorate"],
  ["minorin", "minor"],
  ["minorof", "minor"],
  ["creditbearingmicrocredentialin", "micro_credential"],
];

/**
 * What a programme is, from its name prefix: "Bachelor of ..." is `bachelor`, "Doctor of ..." or
 * "PhD ..." `doctorate`, "Minor in ..." `minor`, "Credit-bearing Micro-credential in ..."
 * `micro_credential`, anything else `other`. Case, hyphens, spaces and punctuation do not matter,
 * so the page name and the name made from the URL slug give the same answer.
 */
export function programKind(nameOrSlugName: string): ProgramKind {
  const letters = (typeof nameOrSlugName === "string" ? nameOrSlugName : "").toLowerCase().replace(/[^\p{L}]/gu, "");
  for (const [prefix, kind] of KIND_PREFIXES) if (letters.startsWith(prefix)) return kind;
  return "other";
}

const PROGRAM_LINK =/^(?:https?:\/\/(?:www\.)?uaeu\.ac\.ae)?\/en\/catalog\/undergraduate\/programs\/([^/?#\s]+)\.shtml$/;

/**
 * The programme page links on the index: every unique `/en/catalog/undergraduate/programs/<slug>.shtml`
 * link in page order, minus NON_PROGRAMME_SLUGS. The index itself, `#` anchors and paths such as
 * `/programs/en/university-leadership/` do not match. A `#fragment` or `?query` on a programme link
 * is dropped, so one page is listed once.
 */
export function parseProgramIndex(links: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of Array.isArray(links) ? links : []) {
    if (typeof raw !== "string") continue;
    const link = raw.trim().replace(/[?#].*$/, "");
    const m = PROGRAM_LINK.exec(link);
    if (!m || NON_PROGRAMME_SLUGS.includes(m[1]!) || seen.has(link)) continue;
    seen.add(link);
    out.push(link);
  }
  return out;
}

export type DegreePlanCourse = { code: string; title: string; credit_hours: number | null };
export type Program = {
  name: string;
  college: string | null;
  credit_hours: number | null;
  description: string;
  objectives: string[];
  degree_plan: DegreePlanCourse[];
};

const NAME_HEADING = /^##\s+(?!#)(.+?)\s*$/;
const ANY_HEADING = /^#{1,6}\s/;
const SUB_HEADING = /^#{3,6}\s/;
const OBJECTIVES_HEADING = /^#{2,6}\s*.*\bobjectives?\b/i;
const BULLET = /^\s*(?:[*+-]|\d+[.)])\s+(\S.*?)\s*$/;
const REQUIRED_CH = /(?:Required|Total)\s+Credit\s+Hours?\s*:\s*(?:[A-Za-z.]+\s+)?(\d+(?:\.\d+)?)/i;
// `| MATH105 | Calculus I | 3 |`; the footnote and header rows of the same tables do not match.
const PLAN_ROW = /^\|\s*([A-Z]{2,5}\d{3,4}[A-Z]?)\s*\|\s*(.+?)\s*\|\s*(\d+(?:\.\d+)?)?\s*\|\s*$/;
const HOSTED_BY = /hosted\s+by\s+([^.]*?)(?:\.(?:\s|$)|$)/i;

function collegeFromSentence(text: string): string | null {
  const sentence = HOSTED_BY.exec(text)?.[1];
  if (!sentence) return null;
  // The college named in words wins ("..., College of Business and Economics").
  const lower = sentence.toLowerCase();
  for (const name of Object.values(COLLEGE_BY_ABBREV)) if (lower.includes(name.toLowerCase())) return name;
  // Otherwise the last abbreviation in the sentence: the department comes first, the college last.
  let found: string | null = null;
  for (const token of sentence.split(/[^A-Za-z]+/)) {
    const name = COLLEGE_BY_ABBREV[token];
    if (name !== undefined) found = name;
  }
  return found;
}

/** A programme page: its name (the first `## ` heading), hosting college, credit hours, description, objectives and degree plan. */
export function parseProgramPage(text: string): Program {
  const lines = typeof text === "string" ? text.split(/\r?\n/) : [];

  const nameAt = lines.findIndex((l) => NAME_HEADING.test(l));
  const name = nameAt < 0 ? "" : NAME_HEADING.exec(lines[nameAt]!)![1]!.replace(/\s+/g, " ");

  // Description: the paragraphs between the name and the first sub-heading.
  const description: string[] = [];
  if (nameAt >= 0) {
    for (const line of lines.slice(nameAt + 1)) {
      if (SUB_HEADING.test(line) || NAME_HEADING.test(line)) break;
      if (line.trim() !== "") description.push(line.trim());
    }
  }

  // Objectives: the bullets under the first heading that mentions objectives.
  const objectives: string[] = [];
  const objectivesAt = lines.findIndex((l) => OBJECTIVES_HEADING.test(l));
  if (objectivesAt >= 0) {
    for (const line of lines.slice(objectivesAt + 1)) {
      if (ANY_HEADING.test(line)) break;
      const item = BULLET.exec(line);
      if (item) objectives.push(item[1]!.replace(/\s+/g, " "));
    }
  }

  // Degree plan: the course rows of the plan's tables, first row wins when a code repeats.
  const degreePlan: DegreePlanCourse[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const row = PLAN_ROW.exec(line.trim());
    if (!row || seen.has(row[1]!)) continue;
    seen.add(row[1]!);
    degreePlan.push({
      code: row[1]!,
      title: row[2]!.replace(/\s+/g, " "),
      credit_hours: row[3] === undefined ? null : Number(row[3]),
    });
  }

  const required = REQUIRED_CH.exec(typeof text === "string" ? text : "");
  return {
    name,
    college: collegeFromSentence(typeof text === "string" ? text : ""),
    credit_hours: required ? Number(required[1]) : null,
    description: description.join("\n\n"),
    objectives,
    degree_plan: degreePlan,
  };
}
