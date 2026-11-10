// get_program: one undergraduate programme, by name (through the programme map) or by page URL.
import { z } from "zod";
import { PROGRAM_INDEX_URL, fetchMeta, programUrlOnSite, readProgramPage } from "../catalogue/read";
import { ToolError } from "../core/errors";
import { slugToName } from "../core/text";
import { getProgramMap, matchProgram } from "../db/programMap";
import { PROGRAM_KINDS, programKind } from "../parsers/program";
import { ENVELOPE, stamp } from "./envelope";
import { defineTool } from "./types";

const LIST_PROGRAMS_FIX = "Pass one of the names or a programme URL from list_programs as name_or_url";

/** How many names a "several programmes match" answer lists. */
const NEAR_MATCHES_MAX = 10;

/** True when the caller meant a URL, so it is checked as one and never taken for a name. */
function looksLikeUrl(s: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /uaeu\.ac\.ae/i.test(s);
}

export const getProgram = defineTool({
  name: "get_program",
  title: "Get a programme",
  description:
    "Reads one UAEU undergraduate programme page: name, college, kind (bachelor, doctorate, minor, " +
    "micro_credential or other), required credit hours, description, objectives and the degree plan " +
    "(every course with its code, title and credit hours; lists are empty when a page has no such section). " +
    "`name_or_url` is a programme name, matched fuzzily against Falaj's programme map (case, punctuation and a " +
    "leading \"Bachelor of Science in\" do not matter), or a programme page URL from list_programs " +
    "(https://www.uaeu.ac.ae/en/catalog/undergraduate/programs/<slug>.shtml; any other URL is INVALID_INPUT). " +
    "A name that fits several programmes (\"Bachelor of Science\") is NOT_FOUND with near_matches listing " +
    "them, never the first one: call again with one of them. " +
    "Returns {name, college, kind, credit_hours, description, objectives, degree_plan: [{code, title, credit_hours}], url} " +
    "plus source_url, read_at, method, cached and ttl_seconds. " +
    "Reads the live programme page with TinyFetch (1 URL; TinyFish may serve a copy up to an hour old). " +
    "Example: get_program({\"name_or_url\": \"Mathematics of Data Science\"})",
  input: {
    name_or_url: z
      .string()
      .min(2)
      .describe("A programme name (\"Mathematics of Data Science\") or a programme page URL from list_programs"),
  },
  output: {
    name: z.string(),
    college: z.string().nullable(),
    kind: z.enum(PROGRAM_KINDS),
    credit_hours: z.number().nullable(),
    description: z.string(),
    objectives: z.array(z.string()),
    degree_plan: z.array(
      z.object({
        code: z.string(),
        title: z.string(),
        credit_hours: z.number().nullable(),
      }),
    ),
    url: z.string(),
    ...ENVELOPE,
  },
  async run({ name_or_url }, t) {
    const input = name_or_url.trim();
    const map = await getProgramMap(t.env.DB);

    let url: string;
    let origin: "caller" | "map";
    if (looksLikeUrl(input)) {
      origin = "caller";
      const safe = programUrlOnSite(input);
      if (safe === null) {
        throw new ToolError("INVALID_INPUT", "name_or_url is a URL that is not a UAEU undergraduate programme page", {
          fix: "Pass https://www.uaeu.ac.ae/en/catalog/undergraduate/programs/<slug>.shtml, or a programme name; list_programs shows both",
        });
      }
      url = safe;
    } else {
      origin = "map";
      if (map.rows.size === 0) {
        throw new ToolError("NOT_FOUND", `No programme matches "${input}": the programme map has no programmes yet`, {
          fix: "The programme map is not built yet; pass a programme URL from list_programs",
        });
      }
      const m = matchProgram(map.rows, input);
      if (m.match === "many") {
        // Every name here ties for the best score and is already in name order, so the first ten are
        // as good as any ten. A degree-only query ("Bachelor of") ties 54 of them.
        const shown = m.names.slice(0, NEAR_MATCHES_MAX);
        const message =
          m.names.length > shown.length
            ? `${m.names.length} programmes match "${input}"; the first ${shown.length} are listed; add words from the programme name to narrow it`
            : `"${input}" matches ${m.names.length} programmes; say which one`;
        throw new ToolError("NOT_FOUND", message, { near_matches: shown, fix: LIST_PROGRAMS_FIX });
      }
      if (m.match === "none") {
        throw new ToolError("NOT_FOUND", `No UAEU programme matches "${input}"`, {
          ...(m.nearest.length > 0 ? { near_matches: m.nearest } : {}),
          fix: LIST_PROGRAMS_FIX,
        });
      }
      const mapUrl = programUrlOnSite(m.url);
      if (mapUrl === null) {
        throw new ToolError("SITE_CHANGED", "The programme map holds an address that is not a programme page", {
          source_url: PROGRAM_INDEX_URL,
          fix: "The map is rebuilt nightly; pass a programme URL from list_programs meanwhile",
        });
      }
      url = mapUrl;
    }

    const { program, source_url, read_at } = await readProgramPage(t, url, origin);
    const mapped = map.rows.get(url);
    // The page's own heading names the programme only when it reads like a programme name (it begins
    // with a kind prefix: "Minor in ...", "Bachelor of ..."). On a layout Falaj does not know, the first
    // "## " heading may be a section title; the map's name, then the URL's, stand in, so the kind agrees
    // with list_programs.
    const slugName = slugToName(/\/([^/]+)\.shtml$/.exec(url)?.[1] ?? url);
    const name =
      [program.name, mapped?.name ?? "", slugName].find((n) => n !== "" && programKind(n) !== "other") ??
      (program.name || mapped?.name || slugName);
    return stamp(
      {
        name,
        college: program.college ?? mapped?.college ?? null,
        kind: programKind(name) !== "other" ? programKind(name) : (mapped?.kind ?? "other"),
        credit_hours: program.credit_hours,
        description: program.description,
        objectives: program.objectives,
        degree_plan: program.degree_plan,
        url: source_url,
      },
      fetchMeta(source_url, read_at),
    );
  },
});
