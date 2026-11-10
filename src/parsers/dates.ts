// Dates as UAEU's pages write them ("28 Feb 2026", "24 August 2026"), read into ISO `YYYY-MM-DD`.
// Pure; an unreadable date is null, never a throw and never a guess.

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/** 1 to 12 for a month's full name or its first three letters ("Sept" too), else 0. */
function monthNumber(name: string): number {
  const m = name.toLowerCase().replace(/\.$/, "");
  if (m.length < 3) return 0;
  const i = MONTHS.findIndex((full) => full === m || (m.length === 3 && full.startsWith(m)) || (m === "sept" && full === "september"));
  return i + 1;
}

/** `YYYY-MM-DD` for a real calendar day, else null. */
export function isoDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** A day number, a month name (full or abbreviated) and a year, as three strings. */
export function parseMonthDate(day: string, month: string, year: string): string | null {
  return isoDate(Number(year), monthNumber(month), Number(day));
}

/** "24 August 2026", "6 Sep 2026" or "September 6, 2026" (non-breaking spaces count as spaces); anything else is null. */
export function parseDateText(text: string): string | null {
  const t = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
  const dmy = /^(\d{1,2}) ([A-Za-z]{3,9})\.?,? (\d{4})$/.exec(t);
  if (dmy) return parseMonthDate(dmy[1]!, dmy[2]!, dmy[3]!);
  const mdy = /^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})$/.exec(t);
  if (mdy) return parseMonthDate(mdy[2]!, mdy[1]!, mdy[3]!);
  return null;
}
