// Times on the page are told in Al Ain's time (UTC+4, no summer time), as the university keeps it.
const GULF_OFFSET_MS = 4 * 3_600_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function gulf(iso: string): Date {
  return new Date(new Date(iso).getTime() + GULF_OFFSET_MS);
}

/** "02:00" */
export function gulfClock(iso: string): string {
  return gulf(iso).toISOString().slice(11, 16);
}

/** "9 Nov" */
export function gulfDay(iso: string): string {
  const d = gulf(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "at 02:00" within the last day, "at 02:00 on 9 Nov" before that. */
export function atGulf(iso: string, now: Date): string {
  const recent = now.getTime() - new Date(iso).getTime() < 24 * 3_600_000;
  return recent ? `at ${gulfClock(iso)}` : `at ${gulfClock(iso)} on ${gulfDay(iso)}`;
}

/** "14:02:11", the UTC clock a read is stamped with. */
export function utcClock(iso: string): string {
  return new Date(iso).toISOString().slice(11, 19);
}

/** "2.1" */
export function seconds(ms: number): string {
  return (Math.max(ms, 0) / 1000).toFixed(1);
}

const COUNT_WORDS = ["None", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

/** "Nine" for 9; the figure itself past ten. */
export function countWord(n: number): string {
  return COUNT_WORDS[n] ?? String(n);
}

/** A web address without its scheme and "www.", for showing. */
export function shortUrl(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
}
