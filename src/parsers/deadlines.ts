// The withdrawal deadlines and refund percentages page
// (https://www.uaeu.ac.ae/en/dvcsae/student_account_office/refunds.shtml) as TinyFetch returns it.
// Each deadline is one row of a `| Status | Start Date | End Date | Payment Refund % | ... |` table.
// Pure and tolerant: a missing part gives "", null or [], and nothing throws.
import { parseDateText } from "./dates";

export type Deadline = {
  label: string;
  date_or_rule: string;
  refund_percent: number | null;
  start_date: string | null;
  end_date: string | null;
};

const HEADING_MARKS = /^#{1,6}\s*/;
const TABLE_ROW = /^\|.*\|$/;
const SEPARATOR_ROW = /^\|[\s:|-]+\|$/;
// "Courses Under the Monthly System First Month" is the system ("... System") and a period ("First Month").
const SYSTEM_HEADING = /^(Courses Under the .*?\bSystem)\b\s*(.*)$/i;
const BLOCK_START = /^(?:#{1,6}\s|\||[*+-]\s|\d+[.)]\s)/;

/** A table row's cells, without the outer pipes. */
function cells(row: string): string[] {
  return row
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.replace(/\s+/g, " ").trim());
}

/** The page's title line, if short enough to be one: a table's caption, not a sentence. */
function caption(line: string): string | null {
  const t = line.replace(HEADING_MARKS, "").trim();
  return t !== "" && t.length <= 100 && !/[.:]$/.test(t) && !TABLE_ROW.test(t) && !/^note\b/i.test(t) ? t : null;
}

/**
 * The deadlines of every status table on the page, in page order. A deadline's `label` is where it
 * belongs plus its Status: the system heading above the table ("Courses Under the Full-Semester
 * System") and, when the table has a line of its own above it ("Second Month"), that line. The
 * columns are found by their header names (start, end, refund), so a reordered table still reads.
 * `date_or_rule` is the start and end text as written ("24 August 2026 to 18 September 2026"), so a
 * rule that is not a date ("Before the first class") is kept; `start_date` and `end_date` are ISO
 * when the text is a date and null when it is not.
 */
export function parseDeadlines(text: string): Deadline[] {
  const lines = typeof text === "string" ? text.split(/\r?\n/).map((l) => l.trim()) : [];
  const out: Deadline[] = [];
  let system: string | null = null; // the last "Courses Under the ... System" heading seen

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!TABLE_ROW.test(line)) {
      const s = line.length <= 120 ? SYSTEM_HEADING.exec(line.replace(HEADING_MARKS, "").trim()) : null;
      if (s) system = s[1]!;
      continue;
    }

    const header = cells(line);
    if (!/^status$/i.test(header[0] ?? "")) {
      // some other table: skip its rows
      while (i + 1 < lines.length && TABLE_ROW.test(lines[i + 1]!)) i++;
      continue;
    }
    const col = (re: RegExp, fallback: number) => {
      const at = header.findIndex((h) => re.test(h));
      return at >= 0 ? at : fallback;
    };
    const startAt = col(/start/i, 1);
    const endAt = col(/\bend\b/i, 2);
    const refundAt = col(/refund/i, 3);

    // The line above the table: the nearest one with text that is not a Note.
    let above = i - 1;
    while (above >= 0 && (lines[above] === "" || /^note\b/i.test(lines[above]!))) above--;
    const aboveText = above >= 0 ? lines[above]!.replace(HEADING_MARKS, "").trim() : "";
    const aboveSystem = SYSTEM_HEADING.exec(aboveText);
    let context: string;
    if (aboveSystem) context = [aboveSystem[1]!, aboveSystem[2]!].filter((p) => p !== "").join(": ");
    else {
      const own = above >= 0 && !TABLE_ROW.test(lines[above]!) ? caption(lines[above]!) : null;
      context = [system ?? "", own ?? ""].filter((p) => p !== "").join(": ");
    }

    for (let r = i + 1; r < lines.length && TABLE_ROW.test(lines[r]!); r++) {
      i = r;
      if (SEPARATOR_ROW.test(lines[r]!)) continue;
      const row = cells(lines[r]!);
      const status = row[0] ?? "";
      if (status === "") continue;
      const start = row[startAt] ?? "";
      const end = row[endAt] ?? "";
      const refund = /(\d+(?:\.\d+)?)\s*%/.exec(row[refundAt] ?? "");
      out.push({
        label: context === "" ? status : `${context}: ${status}`,
        date_or_rule: [start, end].filter((d) => d !== "").join(" to "),
        refund_percent: refund ? Number(refund[1]) : null,
        start_date: parseDateText(start),
        end_date: parseDateText(end),
      });
    }
  }
  return out;
}

/** The first paragraph after the page's title (its first `#` or `##` heading), lines joined with spaces; "" when there is none. */
export function policySummary(text: string): string {
  const lines = typeof text === "string" ? text.split(/\r?\n/).map((l) => l.trim()) : [];
  const title = lines.findIndex((l) => /^#{1,2}\s+\S/.test(l));
  const paragraph: string[] = [];
  for (const line of lines.slice(title + 1)) {
    if (line === "") {
      if (paragraph.length > 0) break;
      continue;
    }
    if (BLOCK_START.test(line)) {
      if (paragraph.length > 0) break;
      continue; // a heading, list or table before the first paragraph is not the summary
    }
    paragraph.push(line);
  }
  return paragraph.join(" ").replace(/\s+/g, " ");
}
