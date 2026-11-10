// Academic-year helpers and calendar dates of the form "17 Aug" plus a year tab.

const MONTH_NUM: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const YEAR_PAIR = /^(\d{4})-(\d{4})$/;
const DAY_MONTH = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?$/;
const MONTH_DAY = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})$/;
/** "15-22 Dec": two days of one month. */
const DAYS_MONTH = /^(\d{1,2})\s*-\s*\d{1,2}\s+([A-Za-z]{3,9})\.?$/;
const WEEKDAY = /^(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?\.?,?\s+/i;

/** The day and month of one date as a calendar row writes it, with or without its weekday; null otherwise. */
function dayAndMonth(text: string): { day: number; month: number } | null {
  const plain = text.trim().replace(WEEKDAY, "");
  const dm = DAY_MONTH.exec(plain);
  const md = dm === null ? MONTH_DAY.exec(plain) : null;
  const dayText = dm?.[1] ?? md?.[2];
  const monthText = dm?.[2] ?? md?.[1];
  if (dayText === undefined || monthText === undefined) return null;
  const month = MONTH_NUM[monthText.toLowerCase()];
  return month === undefined ? null : { day: Number(dayText), month };
}

/**
 * The first day of what a calendar row gives as its date: one date ("17 Aug", "Sunday, 17 Aug",
 * "Aug 17") or a range ("15-22 Dec", "28 Dec - 02 Jan"). A range is read only when both of its ends
 * are dates; anything else (TBA, two dates joined by "or") is null.
 */
function firstDay(text: string): { day: number; month: number } | null {
  const t = text.trim().replace(/[\u2012-\u2015]/g, "-").replace(/\s+/g, " ");
  const sameMonth = DAYS_MONTH.exec(t);
  if (sameMonth !== null) {
    const month = MONTH_NUM[sameMonth[2]!.toLowerCase()];
    return month === undefined ? null : { day: Number(sameMonth[1]), month };
  }
  const ends = t.split(/\s-\s/);
  if (ends.length === 2) {
    const [from, to] = [dayAndMonth(ends[0]!), dayAndMonth(ends[1]!)];
    return from !== null && to !== null ? from : null;
  }
  return dayAndMonth(t);
}

/** UAEU's academic year starts in August. */
export function currentAcademicYear(now: Date): string {
  const y = now.getUTCFullYear();
  return now.getUTCMonth() >= 7 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}

/** The following academic-year tab, e.g. 2026-2027 → 2027-2028. */
export function nextAcademicYear(year: string): string {
  const m = YEAR_PAIR.exec(year);
  if (!m) return year;
  const start = Number(m[1]);
  return `${start + 1}-${start + 2}`;
}

/** The academic-year tab before `year`, e.g. 2026-2027 → 2025-2026. */
export function previousAcademicYear(year: string): string {
  const m = YEAR_PAIR.exec(year);
  if (!m) return year;
  const start = Number(m[1]);
  return `${start - 1}-${start}`;
}

/**
 * The academic-year tabs Falaj reads at `now`: the one before the current year (its Summer term
 * runs into August), the current one and the next. No other year is read.
 */
export function readableAcademicYears(now: Date): string[] {
  const current = currentAcademicYear(now);
  return [previousAcademicYear(current), current, nextAcademicYear(current)];
}

/** True when `s` is two consecutive calendar years, `YYYY-YYYY`. */
export function isAcademicYear(s: string): boolean {
  const m = YEAR_PAIR.exec(s);
  if (!m) return false;
  return Number(m[2]) === Number(m[1]) + 1;
}

/**
 * "17 Aug" on tab "2026-2027" is 2026-08-17: the year comes from the tab and the semester heading.
 * Aug to Dec take the tab's first year and Jan to Jul its second, except under a Summer heading, where
 * every row is in the second year (the Summer term of 2025-2026 runs into August 2026). A range gives
 * its first day. Unparsable input (TBA, a bad day) is null, never a guess.
 */
export function resolveCalendarDate(dayMonth: string, academicYear: string, semester = ""): string | null {
  const years = YEAR_PAIR.exec(academicYear);
  const first = firstDay(dayMonth);
  if (!years || first === null) return null;
  const { day, month } = first;
  const year = /summer/i.test(semester) || month < 8 ? Number(years[2]) : Number(years[1]);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Signed day count from `a` to `b` (UTC ms / 86400000). */
export function daysBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / 86_400_000;
}
