// The course catalogue index (https://www.uaeu.ac.ae/en/catalog/courses/) as TinyFetch returns it:
// one `## <College>` heading per college, then a markdown list of `+ CODE : Title` lines (the
// first item of each list reads `* + CODE : Title`), with `* ### <Department>` sub-headings in
// between. The links come back as a separate list, one per course, each ending `?id=<CODE>`.
// Pure: string and array in, plain objects out.

/** A course code: two to five capitals, three or four digits, an optional capital suffix. */
export const COURSE_CODE = /^[A-Z]{2,5}\d{3,4}[A-Z]?$/;

export type CatalogueCourse = { code: string; title: string; url: string | null };
export type CatalogueCollege = { college: string; courses: CatalogueCourse[] };
export type Catalogue = { colleges: CatalogueCollege[]; courseMap: Map<string, string> };

const COLLEGE_HEADING = /^##\s+(?!#)(.+?)\s*$/;
// `* + ECON105 : Title`, `  + ECON110 : Title`, and the two lines the site writes `AERO485  : Title`.
const COURSE_LINE = /^\s*(?:[*+-]\s+){1,2}([A-Z]{2,5}\d{3,4}[A-Z]?)\s*:\s*(\S.*?)\s*$/;
const COURSE_PATH = /\/en\/catalog\/courses\/course_\d+\.shtml$/;

/**
 * The code a course link points at, read from its `id` query parameter, or null when the link is
 * not a course page or the id is not a course code. Link text never decides this.
 */
function courseIdOf(link: string): string | null {
  let url: URL;
  try {
    url = new URL(link, "https://www.uaeu.ac.ae");
  } catch {
    return null;
  }
  if (!COURSE_PATH.test(url.pathname)) return null;
  const id = url.searchParams.get("id");
  return id !== null && COURSE_CODE.test(id) ? id : null;
}

/**
 * Colleges (every `## ` heading that lists courses, in page order, including "General Education")
 * with their courses, and a map from course code to its page URL. Links are trimmed first: the
 * recorded page has four whose id ends in a space (`?id=AERO485 `), matching the double space the
 * text has before the colon on the same four lines.
 */
export function parseCatalogue(text: string, links: string[]): Catalogue {
  const courseMap = new Map<string, string>();
  for (const raw of Array.isArray(links) ? links : []) {
    if (typeof raw !== "string") continue;
    const link = raw.trim();
    const id = courseIdOf(link);
    if (id !== null && !courseMap.has(id)) courseMap.set(id, link);
  }

  const byName = new Map<string, CatalogueCourse[]>();
  let current: CatalogueCourse[] | null = null;
  for (const line of typeof text === "string" ? text.split(/\r?\n/) : []) {
    const heading = COLLEGE_HEADING.exec(line);
    if (heading) {
      const name = heading[1]!.replace(/\s+/g, " ");
      current = byName.get(name) ?? [];
      byName.set(name, current);
      continue;
    }
    const course = COURSE_LINE.exec(line);
    if (course && current) {
      const code = course[1]!;
      current.push({ code, title: course[2]!.replace(/\s+/g, " "), url: courseMap.get(code) ?? null });
    }
  }

  const colleges: CatalogueCollege[] = [];
  for (const [college, courses] of byName) if (courses.length > 0) colleges.push({ college, courses });
  return { colleges, courseMap };
}
