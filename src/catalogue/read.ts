// The page reads, all in one place: every TinyFetch call the Fetch-backed tools make goes through
// `readPage` below (the events and refunds reads in ../pages/read.ts use it too), and every page
// they fetch is checked against the UAEU host first. Each URL is counted against the daily cap
// before the request is sent.
import { ToolError } from "../core/errors";
import { FETCH_TTL_SECONDS } from "../core/limits";
import { parseCatalogue } from "../parsers/catalogue";
import { parseCoursePage, type Course } from "../parsers/course";
import { NON_PROGRAMME_SLUGS, parseProgramIndex, parseProgramPage, type Program } from "../parsers/program";
import { countFetch, fetchPage } from "../tinyfish/fetch";
import type { ToolContext } from "../tools/types";

const UAEU_HOST = "www.uaeu.ac.ae";
export const CATALOGUE_URL = `https://${UAEU_HOST}/en/catalog/courses/`;
export const PROGRAM_INDEX_URL = `https://${UAEU_HOST}/en/catalog/undergraduate/programs/`;

const COURSE_PATH = /^\/en\/catalog\/courses\/course_\d+\.shtml$/;
const PROGRAM_PATH = /^\/en\/catalog\/undergraduate\/programs\/([A-Za-z0-9_-]+)\.shtml$/;

export const SITE_CHANGED_FIX = "UAEU changed this page; health_check shows when it was last seen working, so try again later";

/** The envelope fields every Fetch-backed result carries. */
export function fetchMeta(source_url: string, read_at: Date) {
  return { source_url, method: "fetch" as const, cached: false, read_at, ttl_seconds: FETCH_TTL_SECONDS };
}

/** True when `u` is a plain https URL on the UAEU website (no port, no credentials). */
function onUaeuHost(u: URL): boolean {
  return u.protocol === "https:" && u.hostname === UAEU_HOST && u.port === "" && u.username === "" && u.password === "";
}

/** `raw` as a course page URL on the UAEU website, or null when it is anything else. Relative links resolve against the site. */
export function courseUrlOnSite(raw: string): string | null {
  try {
    const u = new URL(raw, `https://${UAEU_HOST}/`);
    return onUaeuHost(u) && COURSE_PATH.test(u.pathname) ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * `raw` as a programme page URL, rebuilt from its parts (a query string or fragment is dropped), or
 * null unless it is `https://www.uaeu.ac.ae/en/catalog/undergraduate/programs/<slug>.shtml` for a
 * slug that is a programme.
 */
export function programUrlOnSite(raw: string): string | null {
  try {
    const u = new URL(raw);
    const slug = onUaeuHost(u) ? PROGRAM_PATH.exec(u.pathname)?.[1] : undefined;
    return slug !== undefined && !NON_PROGRAMME_SLUGS.includes(slug) ? `https://${UAEU_HOST}${u.pathname}` : null;
  } catch {
    return null;
  }
}

/**
 * True when two URLs name the same page. Only a trailing slash on the path, the case of the host and
 * a #fragment are forgiven: a different path or query string is a different page.
 */
function samePage(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    const path = (u: URL) => (u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname);
    return x.protocol === y.protocol && x.host === y.host && path(x) === path(y) && x.search === y.search;
  } catch {
    return false;
  }
}

/**
 * What a read is for, so a redirect can be reported in words: `page` names the kind of page ("programme
 * page"), `callerSupplied` is true when the caller chose the URL (a redirect then means the caller gave
 * the wrong address: NOT_FOUND) and false when Falaj chose it (a redirect then means the site changed:
 * SITE_CHANGED).
 */
export type PageIntent = { page: string; callerSupplied?: boolean };

/**
 * One TinyFetch URL. A page TinyFish could not read is UPSTREAM_TIMEOUT, like a failed request. A page
 * TinyFish reached by redirecting somewhere else (its `final_url` is not the URL asked for) is not the
 * page asked for and is never parsed as if it were: NOT_FOUND for a caller-supplied URL, SITE_CHANGED
 * for any other.
 */
export async function readPage(t: ToolContext, url: string, links: boolean, intent: PageIntent) {
  await countFetch(t, 1);
  const r = await fetchPage(t.env, url, { links });
  if (!r.ok) {
    throw new ToolError("UPSTREAM_TIMEOUT", `TinyFish could not read ${url}`, {
      retry_after_seconds: 30,
      source_url: url,
    });
  }
  if (!samePage(url, r.finalUrl)) {
    if (intent.callerSupplied) {
      throw new ToolError("NOT_FOUND", `${url} redirects to ${r.finalUrl}; it is not a ${intent.page}`, {
        source_url: url,
        fix: "Pass the page's own address; list_programs shows the programme pages",
      });
    }
    throw new ToolError("SITE_CHANGED", `The ${intent.page} ${url} now redirects to ${r.finalUrl}`, {
      source_url: url,
      fix: SITE_CHANGED_FIX,
    });
  }
  return { text: r.text, links: r.links, read_at: new Date(), upstream_cached: r.upstream_cached };
}

/**
 * The course catalogue index with its links: the courses by college and the code -> page URL map.
 * One Fetch URL. A page with no courses on it is SITE_CHANGED.
 */
export async function readCatalogue(t: ToolContext): Promise<{
  parsed: ReturnType<typeof parseCatalogue>;
  source_url: string;
  read_at: Date;
  upstream_cached: boolean | null;
}> {
  const page = await readPage(t, CATALOGUE_URL, true, { page: "course catalogue page" });
  const parsed = parseCatalogue(page.text, page.links);
  if (parsed.colleges.length === 0) {
    throw new ToolError("SITE_CHANGED", `No courses found on the UAEU course catalogue page ${CATALOGUE_URL}`, {
      source_url: CATALOGUE_URL,
      fix: SITE_CHANGED_FIX,
    });
  }
  return { parsed, source_url: CATALOGUE_URL, read_at: page.read_at, upstream_cached: page.upstream_cached };
}

/**
 * One course's page. `url` is the catalogue's link for `code`; it must be a course page on
 * https://www.uaeu.ac.ae/, else the catalogue changed shape (SITE_CHANGED naming the catalogue). A
 * page without the course's heading is SITE_CHANGED naming that page. One Fetch URL.
 */
export async function readCoursePage(
  t: ToolContext,
  code: string,
  url: string,
): Promise<{ course: Course; source_url: string; read_at: Date }> {
  const safe = courseUrlOnSite(url);
  if (safe === null) {
    throw new ToolError(
      "SITE_CHANGED",
      `The course catalogue links ${code} to an address that is not a course page on https://${UAEU_HOST}/`,
      { source_url: CATALOGUE_URL, fix: SITE_CHANGED_FIX },
    );
  }
  const page = await readPage(t, safe, false, { page: "course page" });
  const course = parseCoursePage(page.text, code);
  if (course === null) {
    throw new ToolError("SITE_CHANGED", `The course page ${safe} has no heading for ${code}`, {
      source_url: safe,
      fix: SITE_CHANGED_FIX,
    });
  }
  return { course, source_url: safe, read_at: page.read_at };
}

/** The programmes index with its links: the programme page URLs in page order. One Fetch URL. */
export async function readProgramIndex(t: ToolContext): Promise<{ urls: string[]; source_url: string; read_at: Date }> {
  const page = await readPage(t, PROGRAM_INDEX_URL, true, { page: "programmes page" });
  const urls = parseProgramIndex(page.links);
  if (urls.length === 0) {
    throw new ToolError("SITE_CHANGED", `No programme links found on the UAEU programmes page ${PROGRAM_INDEX_URL}`, {
      source_url: PROGRAM_INDEX_URL,
      fix: SITE_CHANGED_FIX,
    });
  }
  return { urls, source_url: PROGRAM_INDEX_URL, read_at: page.read_at };
}

/**
 * One programme's page, from a URL that passes `programUrlOnSite` (else INVALID_INPUT). `origin` says who
 * chose the URL, the caller or Falaj's programme map (it decides what a redirect means). A page where
 * the parser recognises nothing (no name, description, objectives, degree plan, credit hours or
 * college) is SITE_CHANGED; any one of them makes it a programme page, possibly a sparse one.
 * One Fetch URL.
 */
export async function readProgramPage(
  t: ToolContext,
  url: string,
  origin: "caller" | "map",
): Promise<{ program: Program; source_url: string; read_at: Date }> {
  const safe = programUrlOnSite(url);
  if (safe === null) {
    throw new ToolError("INVALID_INPUT", "Not a UAEU undergraduate programme page URL", {
      fix: `Pass https://${UAEU_HOST}/en/catalog/undergraduate/programs/<slug>.shtml, or a name; list_programs shows both`,
    });
  }
  const page = await readPage(t, safe, false, { page: "programme page", callerSupplied: origin === "caller" });
  const program = parseProgramPage(page.text);
  // SITE_CHANGED only when nothing at all was recognised (a blank page, the language notice alone, a
  // page of navigation). A page that parses to any one part is a programme page in a layout the
  // parser knows less of (a minor or micro-credential): the caller gets a sparse result, with the
  // missing parts empty or null, and fills the name in from the map or the slug.
  const recognised =
    program.name !== "" ||
    program.description !== "" ||
    program.objectives.length > 0 ||
    program.degree_plan.length > 0 ||
    program.credit_hours !== null ||
    program.college !== null;
  if (!recognised) {
    throw new ToolError("SITE_CHANGED", `The programme page ${safe} has no programme content`, {
      source_url: safe,
      fix: SITE_CHANGED_FIX,
    });
  }
  return { program, source_url: safe, read_at: page.read_at };
}
