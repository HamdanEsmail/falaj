// Faculty from TinySearch results. A UAEU faculty profile lives at
// `https://www.uaeu.ac.ae/en/<college>/profile.shtml?email=<address>`; the result's title is the
// person's name (sometimes behind "Faculty Profile - " and a "Dr." or "Prof."). Nothing here reads
// the profile itself: only what the Search result shows. Pure and tolerant.
import { COLLEGE_BY_ABBREV } from "./program";

export type FacultyPerson = { name: string; title: string | null; college: string | null; profile_url: string };

/** The faculty directory's URL segment for each college. `eng` is the engineering college's segment (the catalogue's abbreviation for it is COE). */
const COLLEGE_BY_SEGMENT: Readonly<Record<string, string>> = {
  cmhs: COLLEGE_BY_ABBREV.CMHS!,
  eng: COLLEGE_BY_ABBREV.COE!,
  chss: COLLEGE_BY_ABBREV.CHSS!,
  cit: COLLEGE_BY_ABBREV.CIT!,
  cbe: COLLEGE_BY_ABBREV.CBE!,
  cos: COLLEGE_BY_ABBREV.COS!,
  col: COLLEGE_BY_ABBREV.COL!,
  cedu: COLLEGE_BY_ABBREV.CEDU!,
  cavm: COLLEGE_BY_ABBREV.CAVM!,
};

const PROFILE_PATH = /^\/en\/([A-Za-z0-9_-]+)\/profile\.shtml$/;
// Some of the site's own links leave the domain off (`?email=a.example`); both forms open the page.
const PROFILE_ADDRESS = /^[a-z0-9][a-z0-9._-]{0,63}(?:@uaeu\.ac\.ae)?$/;
const COLLEGE_SUFFIX = /\s+-\s+College of [A-Za-z ,&]+$/;
const PROFILE_PREFIX = /^Faculty Profile\s*-\s*/i;
const HONORIFICS = /^((?:(?:Dr|Prof)\.\s+)+)/;

/** The college segment of a faculty profile URL on the UAEU website, or null for any other address. */
function profileSegment(raw: string): string | null {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    if (u.protocol !== "https:" || (host !== "uaeu.ac.ae" && !host.endsWith(".uaeu.ac.ae"))) return null;
    if (!u.searchParams.get("email")) return null;
    return PROFILE_PATH.exec(u.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * The one address a faculty profile page is read and cached at, or null when `raw` is not such a
 * page. A profile page is on https://www.uaeu.ac.ae, at `/en/<college>/profile.shtml` for one of
 * the colleges above, with exactly one `email` parameter holding a uaeu.ac.ae address or its part
 * before the @, as the site itself links some people. The address is lower-cased, and any other
 * parameter and the fragment are left out, so every spelling of one page gives the same string.
 */
export function canonicalProfileUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.hostname !== "www.uaeu.ac.ae" || u.port !== "") return null;
  if (u.username !== "" || u.password !== "") return null;
  const segment = PROFILE_PATH.exec(u.pathname)?.[1]?.toLowerCase();
  if (segment === undefined || !Object.prototype.hasOwnProperty.call(COLLEGE_BY_SEGMENT, segment)) return null;
  const addresses = u.searchParams.getAll("email");
  if (addresses.length !== 1) return null;
  const address = addresses[0]!.trim().toLowerCase();
  if (!PROFILE_ADDRESS.test(address)) return null;
  return `https://www.uaeu.ac.ae/en/${segment}/profile.shtml?email=${address}`;
}

/**
 * The people among Search hits: only profile pages are kept (the faculty directory, news and other
 * pages are dropped, and so is a profile address seen twice). `name` is the result's title without a
 * leading "Faculty Profile - " and without a leading "Dr." or "Prof.", which moves to `title`;
 * `college` is named from the URL's path segment ("cmhs" is the College of Medicine and Health
 * Sciences), or is the segment itself when it is not one Falaj knows.
 */
export function facultyFromSearch(hits: { url: string; title: string; snippet: string }[]): FacultyPerson[] {
  const seen = new Set<string>();
  const people: FacultyPerson[] = [];
  for (const hit of Array.isArray(hits) ? hits : []) {
    if (hit === null || typeof hit !== "object" || typeof hit.url !== "string") continue;
    const segment = profileSegment(hit.url);
    if (segment === null || seen.has(hit.url)) continue;
    seen.add(hit.url);

    // "Faculty Profile - " in front and " - College of ..." behind are the page's furniture, not the name.
    const shown = (typeof hit.title === "string" ? hit.title : "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(PROFILE_PREFIX, "")
      .replace(COLLEGE_SUFFIX, "");
    const honorific = HONORIFICS.exec(shown)?.[1];
    const name = honorific === undefined ? shown : shown.slice(honorific.length);
    people.push({
      name: name.trim() === "" ? "Faculty profile" : name.trim(),
      title: honorific === undefined ? null : honorific.trim(),
      college: COLLEGE_BY_SEGMENT[segment.toLowerCase()] ?? segment,
      profile_url: hit.url,
    });
  }
  return people;
}
