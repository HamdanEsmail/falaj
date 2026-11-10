// list_programs: every undergraduate offering on the programmes index. One Fetch URL; names and
// colleges come from the programme map, never from reading the programme pages.
import { z } from "zod";
import { fetchMeta, readProgramIndex } from "../catalogue/read";
import { slugToName } from "../core/text";
import { getProgramMap } from "../db/programMap";
import { PROGRAM_KINDS, programKind } from "../parsers/program";
import { ENVELOPE, stamp } from "./envelope";
import { defineTool } from "./types";

export const listPrograms = defineTool({
  name: "list_programs",
  title: "List programmes",
  description:
    "Lists the offerings on UAEU's undergraduate programmes page (about 75: bachelor's degrees, a doctorate, " +
    "minors and credit-bearing micro-credentials), each with its name, college, kind and page URL. " +
    "`kind` is bachelor, doctorate, minor, micro_credential or other, from the name's prefix. " +
    "Names and colleges come from Falaj's programme map, which the nightly health run rebuilds from the " +
    "programme pages (map_built_at says when); a programme not in the map yet has its name made from its URL " +
    "and college null, and a `college` filter does not match it. " +
    "`college` keeps programmes whose college name contains that text (case-insensitive substring): " +
    "\"College of Science\" gives that college, but \"science\" also matches \"College of Humanities and Social " +
    "Sciences\". `query` keeps names that contain every word given. " +
    "Returns {programs: [{name, college, kind, url}], total (after the filters), map_built_at} plus source_url, " +
    "read_at, method, cached and ttl_seconds. " +
    "Reads the live UAEU programmes page and its links with TinyFetch (1 URL; no programme page is read). " +
    "Example: list_programs({\"kind\": \"bachelor\", \"college\": \"College of Science\"})",
  input: {
    college: z
      .string()
      .optional()
      .describe("Case-insensitive substring of the college name, e.g. \"College of Science\""),
    query: z.string().optional().describe("Words that must all appear in the programme name, e.g. \"data science\""),
    kind: z.enum(PROGRAM_KINDS).optional().describe("bachelor, doctorate, minor, micro_credential or other"),
  },
  output: {
    programs: z.array(
      z.object({
        name: z.string(),
        college: z.string().nullable(),
        kind: z.enum(PROGRAM_KINDS),
        url: z.string(),
      }),
    ),
    total: z.number().int(),
    map_built_at: z.string().nullable(),
    ...ENVELOPE,
  },
  async run({ college, query, kind }, t) {
    const index = await readProgramIndex(t);
    const map = await getProgramMap(t.env.DB);

    const collegeFilter = college?.trim().toLowerCase() ?? "";
    const queryWords = (query ?? "").toLowerCase().split(/\s+/).filter((w) => w !== "");

    const programs = [];
    for (const url of index.urls) {
      const mapped = map.rows.get(url);
      const name = mapped?.name ?? slugToName(/\/([^/]+)\.shtml$/.exec(url)?.[1] ?? url);
      const row = { name, college: mapped?.college ?? null, kind: mapped?.kind ?? programKind(name), url };
      if (kind !== undefined && row.kind !== kind) continue;
      if (collegeFilter !== "" && !(row.college ?? "").toLowerCase().includes(collegeFilter)) continue;
      const lower = name.toLowerCase();
      if (!queryWords.every((w) => lower.includes(w))) continue;
      programs.push(row);
    }

    return stamp(
      { programs, total: programs.length, map_built_at: map.built_at },
      fetchMeta(index.source_url, index.read_at),
    );
  },
});
