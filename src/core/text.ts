// Small string helpers shared by the parsers and the call log. All pure, none throws.
import { ARGS_ABBREV_CHARS } from "./limits";

/** Words kept lower-case inside a name made from a URL slug (never the first word). */
const SMALL_WORDS = new Set(["of", "in", "the", "and"]);

/**
 * "bachelor-of-science-in--the-mathematics-of-data-science" ->
 * "Bachelor of Science in the Mathematics of Data Science". Runs of hyphens count as one
 * separator (the site's slugs carry a double hyphen).
 */
export function slugToName(slug: string): string {
  return slug
    .split(/-+/)
    .filter((w) => w !== "")
    .map((w, i) => (i > 0 && SMALL_WORDS.has(w.toLowerCase()) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

// Linear time on any input. Two things keep it so:
// - the lookbehind lets a match start only at the beginning of a run of local-part characters,
//   so a long run with no `@` is scanned once instead of once from every position in it (the
//   quadratic case), while a long local part is still masked in full;
// - the domain's labels, label count and top-level domain are bounded (RFC 1035 sizes), so a
//   long domain-like run after an `@` cannot backtrack without limit.
// The @ may be written %40, as a URL carries it: an address in a query string is masked the same.
const EMAIL =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+?(?:@|%40)([A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,20}\.[A-Za-z]{2,63})/g;

// Some of the university's own profile links name their person without a domain (`?email=a.example`).
// What follows `email=` in a query string is masked too. The run is bounded, so this stays linear.
const EMAIL_PARAM = /([?&]email=)[A-Za-z0-9._%+-]{1,128}(?![A-Za-z0-9._%+@-])/g;

/**
 * `local@domain` -> `***@domain`, wherever it appears (plain text, JSON, a query string). Cost is
 * linear in the length of `s`, but it still reads all of it and it runs over caller-supplied
 * arguments, so a caller that can should abbreviate very large input first, with a limit well
 * above what it finally keeps (cutting inside an address would leave part of it unmasked), then
 * mask, then abbreviate to the final length.
 */
export function maskEmails(s: string): string {
  return s.replace(EMAIL, "***@$1").replace(EMAIL_PARAM, "$1***");
}

/** Cuts `s` to at most `n` characters, ending in an ellipsis when something was cut. */
export function abbrev(s: string, n: number = ARGS_ABBREV_CHARS): string {
  if (s.length <= n) return s;
  if (n <= 1) return s.slice(0, Math.max(n, 0));
  return `${s.slice(0, n - 1)}…`;
}

/** SHA-256 of `s` as hex, first 16 characters: enough to group calls, not to recover the input. */
export async function hashKey(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
  return hex.slice(0, 16);
}
