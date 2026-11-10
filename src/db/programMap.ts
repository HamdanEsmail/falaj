// The programme map: programme page URL -> name, college and kind. It is a "find a page" map, never
// an answer: the nightly canaries rebuild it from the programme pages, and list_programs and
// get_program use it to put names and colleges on the index's bare links and to turn a name into a URL.
import { PROGRAM_KINDS, type ProgramKind } from "../parsers/program";

export type ProgramMapRow = { name: string; college: string | null; kind: ProgramKind };

/** D1 takes a batch in one round trip; this many statements at a time keeps each one small. */
const UPSERT_CHUNK = 50;

/** Inserts or updates one row per URL, all stamped with `builtAt`. Rows for other URLs are left alone. */
export async function upsertProgramMap(
  db: D1Database,
  rows: { url: string; name: string; college: string | null; kind: ProgramKind }[],
  builtAt: Date,
): Promise<void> {
  const stmt = db.prepare(
    `INSERT INTO program_map (url, name, college, kind, built_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (url) DO UPDATE SET
       name = excluded.name, college = excluded.college, kind = excluded.kind, built_at = excluded.built_at`,
  );
  const stamp = builtAt.toISOString();
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    await db.batch(
      rows.slice(i, i + UPSERT_CHUNK).map((r) => stmt.bind(r.url, r.name, r.college ?? null, r.kind, stamp)),
    );
  }
}

/** Every row, keyed by URL, and the latest `built_at` (null when the map is empty). */
/** Drops map rows whose URL is no longer on the programmes index. */
export async function pruneProgramMap(db: D1Database, keepUrls: string[]): Promise<void> {
  if (keepUrls.length === 0) return;
  const placeholders = keepUrls.map(() => "?").join(",");
  await db
    .prepare(`DELETE FROM program_map WHERE url NOT IN (${placeholders})`)
    .bind(...keepUrls)
    .run();
}

export async function getProgramMap(db: D1Database): Promise<{ rows: Map<string, ProgramMapRow>; built_at: string | null }> {
  const { results } = await db
    .prepare("SELECT url, name, college, kind, built_at FROM program_map ORDER BY url")
    .all<{ url: string; name: string; college: string | null; kind: string; built_at: string }>();
  const rows = new Map<string, ProgramMapRow>();
  let builtAt: string | null = null;
  for (const r of results) {
    const kind = (PROGRAM_KINDS as readonly string[]).includes(r.kind) ? (r.kind as ProgramKind) : "other";
    rows.set(r.url, { name: r.name, college: r.college, kind });
    if (builtAt === null || r.built_at > builtAt) builtAt = r.built_at;
  }
  return { rows, built_at: builtAt };
}

export type ProgramMatch =
  | { match: "one"; url: string }
  | { match: "many"; names: string[] }
  | { match: "none"; nearest: string[] };

/** Lower case, "&" read as "and", every other run of non-letters and non-digits a single space. */
function plain(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Words that join a name together and say nothing about the programme. They never count towards a match. */
const FILLER = new Set(["a", "an", "and", "at", "for", "in", "of", "on", "the", "to", "with"]);

function wordSet(s: string): Set<string> {
  return new Set(s.split(" ").filter((w) => w !== "" && !FILLER.has(w)));
}

/** The words that name a programme: the degree phrases ("bachelor of science in") and filler words dropped. */
function shortWords(s: string): Set<string> {
  return wordSet(plain(s).replace(/\bbachelor of (?:science|arts)(?: in)?\b|\bbachelor of\b/g, " "));
}

/** Every naming word of the name, degree words included (the fallback for a query that is only degree words). */
function rawWords(s: string): Set<string> {
  return wordSet(plain(s));
}

/** The whole name, lower case and without punctuation or "the": two names that read alike are equal. */
function fullName(s: string): string {
  return plain(s).replace(/\bthe\b/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Finds the programme a name means. A map URL given as is, or a name that equals exactly one
 * programme's name (ignoring case, punctuation and "the"), is `one`. Otherwise both sides are
 * shortened to their naming words and scored by `|query words in the name| / |query words|`; names
 * scoring 0.6 or more are candidates, and the top score decides: alone is `one`, shared is `many`
 * (every tied full name), no candidate is `none` with the three nearest names. A query that is only
 * degree words ("Bachelor of Science") has no naming words left: it matches the names that begin
 * with it, else it is scored on all its words. Nothing divides by zero.
 */
export function matchProgram(map: ReadonlyMap<string, { name: string }>, nameOrUrl: string): ProgramMatch {
  const input = typeof nameOrUrl === "string" ? nameOrUrl.trim() : "";
  if (map.has(input)) return { match: "one", url: input };

  const full = fullName(input);
  if (full !== "") {
    const exact = [...map].filter(([, row]) => fullName(row.name) === full);
    if (exact.length === 1) return { match: "one", url: exact[0]![0] };
  }

  let query = shortWords(input);
  let wordsOf = shortWords;
  if (query.size === 0) {
    if (full !== "") {
      const begins = [...map].filter(([, row]) => `${fullName(row.name)} `.startsWith(`${full} `));
      if (begins.length === 1) return { match: "one", url: begins[0]![0] };
      if (begins.length > 1) return { match: "many", names: [...new Set(begins.map(([, row]) => row.name))].sort((a, b) => a.localeCompare(b)) };
    }
    query = rawWords(input);
    wordsOf = rawWords;
  }
  if (query.size === 0) return { match: "none", nearest: [] };

  const scored = [...map].map(([url, row]) => {
    const words = wordsOf(row.name);
    let hits = 0;
    for (const w of query) if (words.has(w)) hits++;
    return { url, name: row.name, hits };
  });
  // hits / |query| >= 0.6, as integers.
  const candidates = scored.filter((s) => s.hits * 5 >= query.size * 3);

  if (candidates.length === 0) {
    const nearest = scored
      .filter((s) => s.hits > 0)
      .sort((a, b) => b.hits - a.hits || a.name.localeCompare(b.name))
      .slice(0, 3)
      .map((s) => s.name);
    return { match: "none", nearest };
  }
  const top = Math.max(...candidates.map((s) => s.hits));
  const best = candidates.filter((s) => s.hits === top);
  if (best.length === 1) return { match: "one", url: best[0]!.url };
  return { match: "many", names: [...new Set(best.map((s) => s.name))].sort((a, b) => a.localeCompare(b)) };
}
