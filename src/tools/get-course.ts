// get_course: one course by code. The catalogue (1 URL) says where the course's page is, then the page (1 URL).
import { z } from "zod";
import { fetchMeta, readCatalogue, readCoursePage } from "../catalogue/read";
import { ToolError } from "../core/errors";
import { ENVELOPE, stamp } from "./envelope";
import { defineTool } from "./types";

export const getCourse = defineTool({
  name: "get_course",
  title: "Get a course",
  description:
    "Reads one UAEU course by its code: title, college, description, credit hours, learning outcomes and " +
    "prerequisites (when the page lists them). UAEU's course pages carry the next course too; only the " +
    "requested one is returned. An unknown code is NOT_FOUND (search_courses finds codes). " +
    "Returns {code, title, college, description, credit_hours, learning_outcomes, prerequisites, url} " +
    "plus source_url (the course page), read_at, method, cached and ttl_seconds. " +
    "Reads the live UAEU course catalogue page and then the course's own page with TinyFetch (2 URLs; " +
    "TinyFish may serve copies up to an hour old). " +
    "Example: get_course({\"code\": \"HSR140\"})",
  input: {
    code: z
      .string()
      .regex(/^[A-Za-z]{2,5}\d{3,4}[A-Za-z]?$/)
      .describe("A course code such as HSR140 or ECON105 (any case)"),
  },
  output: {
    code: z.string(),
    title: z.string(),
    college: z.string().nullable(),
    description: z.string(),
    credit_hours: z.number().nullable(),
    learning_outcomes: z.array(z.string()),
    prerequisites: z.array(z.string()),
    url: z.string(),
    ...ENVELOPE,
  },
  async run({ code: given }, t) {
    const code = given.toUpperCase();
    const catalogue = await readCatalogue(t);
    const pageUrl = catalogue.parsed.courseMap.get(code);
    if (pageUrl === undefined) {
      // Listed but not linked is the page changing shape, not a course that does not exist.
      if (catalogue.parsed.colleges.some((c) => c.courses.some((x) => x.code === code))) {
        throw new ToolError("SITE_CHANGED", `The UAEU course catalogue lists ${code} but has no link to its page`, {
          source_url: catalogue.source_url,
          fix: "UAEU changed this page; health_check shows when it was last seen working, so try again later",
        });
      }
      throw new ToolError("NOT_FOUND", `No course ${code} in the UAEU catalogue`, {
        source_url: catalogue.source_url,
        fix: "Use search_courses to find the course code",
      });
    }
    const { course, source_url, read_at } = await readCoursePage(t, code, pageUrl);
    const college = catalogue.parsed.colleges.find((c) => c.courses.some((x) => x.code === code))?.college ?? null;
    return stamp(
      {
        code: course.code,
        title: course.title,
        college,
        description: course.description,
        credit_hours: course.credit_hours,
        learning_outcomes: course.learning_outcomes,
        prerequisites: course.prerequisites,
        url: source_url,
      },
      fetchMeta(source_url, read_at),
    );
  },
});
