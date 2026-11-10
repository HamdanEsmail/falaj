// find_faculty: UAEU faculty profile pages found with TinySearch (restricted to uaeu.ac.ae). It
// reads no profile page: it returns what the Search results show. No Fetch URL.
import { z } from "zod";
import { ToolError } from "../core/errors";
import { facultyFromSearch } from "../parsers/faculty";
import { searchSite } from "../tinyfish/search";
import { ENVELOPE, stamp } from "./envelope";
import { defineTool } from "./types";

/** The human page for the search: UAEU's faculty directory. Every find_faculty result names it as its source. */
export const FACULTY_DIRECTORY_URL = "https://www.uaeu.ac.ae/en/catalog/uaeu-faculty-directory.shtml";

const NOT_FOUND_FIX =
  "Try the person's name as the UAEU website writes it, or a department or research area; " +
  "find_faculty lists only the faculty profile pages that TinySearch finds";

export const findFaculty = defineTool({
  name: "find_faculty",
  title: "Find faculty",
  description:
    "Finds UAEU faculty members by name, department or research topic with TinySearch, restricted to uaeu.ac.ae, " +
    "and returns the faculty profile pages it finds: for each, the name as the search result shows it " +
    "(a leading \"Dr.\" or \"Prof.\" moves to `title`), the college taken from the profile address, and the " +
    "profile page URL. It lists what the search returns (usually a handful of people), so a person who is not " +
    "among the results may still work at UAEU; try the name as the website writes it. " +
    "`college` keeps people whose college name contains that text (case-insensitive substring): \"medicine\" " +
    "matches the College of Medicine and Health Sciences, and the other colleges are named as in " +
    "list_programs. No match at all is NOT_FOUND. " +
    "Returns {people: [{name, title, college, profile_url}], total} plus source_url (UAEU's faculty directory), " +
    "read_at, method (search) and cached. " +
    "Searches with TinySearch (no page is fetched). " +
    "Example: find_faculty({\"query\": \"Amal Example\", \"college\": \"medicine\"})",
  input: {
    query: z.string().min(2).describe("A person's name, a department or a research topic, e.g. \"Amal Example\" or \"machine learning\""),
    college: z
      .string()
      .optional()
      .describe("Case-insensitive substring of the college name, e.g. \"engineering\" or \"College of Science\""),
  },
  output: {
    people: z.array(
      z.object({
        name: z.string(),
        title: z.string().nullable(),
        college: z.string().nullable(),
        profile_url: z.string(),
      }),
    ),
    total: z.number().int(),
    ...ENVELOPE,
  },
  async run({ query, college }, t) {
    const q = query.trim();
    // "faculty profile" steers the search to the profile pages, whose titles read "Faculty Profile - <name>".
    const hits = await searchSite(t.env, `${q} faculty profile`, "uaeu.ac.ae");
    const found = facultyFromSearch(hits);
    const filter = college?.trim().toLowerCase() ?? "";
    const people = filter === "" ? found : found.filter((p) => (p.college ?? "").toLowerCase().includes(filter));

    if (people.length === 0) {
      if (found.length > 0) {
        const colleges = [...new Set(found.map((p) => p.college ?? "unknown"))];
        throw new ToolError("NOT_FOUND", `No UAEU faculty profile matched ${q} in a college matching "${college!.trim()}"`, {
          source_url: FACULTY_DIRECTORY_URL,
          fix: `Drop the college filter or change it; the matches were in: ${colleges.join(", ")}`,
        });
      }
      throw new ToolError("NOT_FOUND", `No UAEU faculty profile matched ${q}`, {
        source_url: FACULTY_DIRECTORY_URL,
        fix: NOT_FOUND_FIX,
      });
    }
    return stamp({ people, total: people.length }, { source_url: FACULTY_DIRECTORY_URL, method: "search", cached: false });
  },
});
