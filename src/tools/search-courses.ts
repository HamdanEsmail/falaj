// search_courses: find courses in the UAEU catalogue by code or title words. One Fetch URL.
import { z } from "zod";
import { fetchMeta, readCatalogue } from "../catalogue/read";
import { RESULT_LIMIT_DEFAULT, RESULT_LIMIT_MAX } from "../core/limits";
import { ENVELOPE, stamp } from "./envelope";
import { defineTool } from "./types";

// Words that would match almost every title ("Principles of ...") and say nothing about the topic.
const FILLER = new Set(["a", "an", "and", "the", "of", "in", "on", "to", "for", "with", "at", "by", "from"]);

function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== "");
}

export const searchCourses = defineTool({
  name: "search_courses",
  title: "Search courses",
  description:
    "Searches the UAEU course catalogue by course code (ECON105), code prefix (ECON) or title words " +
    "(international finance). Best matches come first: exact code, then code prefix, then titles holding " +
    "every query word, then titles holding any of them; ties are ordered by code. " +
    "`college` keeps only courses listed under a catalogue heading that contains that text (case-insensitive " +
    "substring): \"College of Science\" gives that college, but \"science\" also matches \"College of Humanities " +
    "and Social Sciences\", and \"education\" matches both \"College of Education\" and \"General Education\" " +
    "(the catalogue's tenth group, which holds HSR140 and HSR150). `limit` is 1 to 50, default 20. " +
    "Returns {courses: [{code, title, college, url}], total_matches (before the limit), catalogue_read_at} " +
    "plus source_url, read_at, method, cached and ttl_seconds. " +
    "Reads the live UAEU course catalogue page with TinyFetch (1 URL; TinyFish may serve a copy up to an hour old). " +
    "Example: search_courses({\"query\": \"international finance\", \"college\": \"business\", \"limit\": 5})",
  input: {
    query: z.string().min(1).describe("A course code (ECON105), a code prefix (ECON) or title words (machine learning)"),
    college: z
      .string()
      .optional()
      .describe("Case-insensitive substring of the catalogue's college heading, e.g. \"College of Science\" or \"business\""),
    limit: z.number().int().min(1).max(RESULT_LIMIT_MAX).optional().describe(`How many courses to return, default ${RESULT_LIMIT_DEFAULT}`),
  },
  output: {
    courses: z.array(
      z.object({
        code: z.string(),
        title: z.string(),
        college: z.string(),
        url: z.string().nullable(),
      }),
    ),
    total_matches: z.number().int(),
    catalogue_read_at: z.string(),
    ...ENVELOPE,
  },
  async run({ query, college, limit }, t) {
    const { parsed, source_url, read_at } = await readCatalogue(t);

    const compact = query.replace(/\s+/g, "").toUpperCase();
    const queryWords = words(query);
    const topic = queryWords.filter((w) => !FILLER.has(w));
    const wanted = topic.length > 0 ? topic : queryWords;
    const collegeFilter = college?.trim().toLowerCase() ?? "";

    const scored: { code: string; title: string; college: string; url: string | null; score: number }[] = [];
    for (const group of parsed.colleges) {
      if (collegeFilter !== "" && !group.college.toLowerCase().includes(collegeFilter)) continue;
      for (const c of group.courses) {
        const title = c.title.toLowerCase();
        let score = 0;
        if (c.code === compact) score = 3;
        else if (compact.length >= 2 && c.code.startsWith(compact)) score = 2;
        else if (wanted.length > 0 && wanted.every((w) => title.includes(w))) score = 1;
        else if (wanted.some((w) => title.includes(w))) score = 0.5;
        if (score > 0) scored.push({ code: c.code, title: c.title, college: group.college, url: c.url, score });
      }
    }
    scored.sort((a, b) => b.score - a.score || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

    return stamp(
      {
        courses: scored.slice(0, limit ?? RESULT_LIMIT_DEFAULT).map(({ score: _score, ...course }) => course),
        total_matches: scored.length,
        catalogue_read_at: read_at.toISOString(),
      },
      fetchMeta(source_url, read_at),
    );
  },
});
