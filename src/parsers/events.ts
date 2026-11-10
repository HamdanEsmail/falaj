// The highlighted events on https://www.uaeu.ac.ae/en/events/, as TinyFetch returns the page.
// Each card is a three-line date (`28<nbsp>`, `Feb<nbsp>`, `2026`), a `###### Title` heading and the
// words DISCOVER MORE; the cards stop at the `## Video Highlights` heading, whose own dates
// (`17 Feb  2026`, inside headings) belong to videos. Pure and tolerant: unrecognised text gives [].
import { parseMonthDate } from "./dates";

export type EventItem = { date: string; title: string; url: string | null };

const DAY = /^\d{1,2}$/;
const MONTH = /^[A-Za-z]{3,9}\.?$/;
const YEAR = /^\d{4}$/;
const ONE_LINE_DATE = /^\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{4}$/;
const TITLE_HEADING = /^#{1,6}\s+(\S.*?)\s*$/;
const VIDEO_HIGHLIGHTS = /^#{1,6}\s*video\s+highlights\b/i;
// `/en/events/<slug>.shtml` is one event's page; `/en/events/` itself, its `index.shtml`, `#` anchors and other sections are not.
const EVENT_PAGE = /^https:\/\/www\.uaeu\.ac\.ae\/en\/events\/(?!index\.shtml$)[^/?#\s]+\.shtml$/;

/** The events' own pages from the page's links, in page order, each once. */
function eventPages(links: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of links) {
    if (typeof raw !== "string") continue;
    const link = raw.trim();
    if (EVENT_PAGE.test(link) && !seen.has(link)) {
      seen.add(link);
      out.push(link);
    }
  }
  return out;
}

/**
 * The events in page order, each with its ISO date (`YYYY-MM-DD`), title and page. The text carries
 * no addresses (DISCOVER MORE is plain text), so `url` comes from `links`, the page's link list: the
 * events' own pages in page order, matched to the events by position. They are used only when there
 * are exactly as many pages as events; otherwise every `url` is null rather than a guess.
 */
export function parseEvents(text: string, links: string[] = []): EventItem[] {
  const lines = typeof text === "string" ? text.split(/\r?\n/).map((l) => l.trim()) : [];
  const end = lines.findIndex((l) => VIDEO_HIGHLIGHTS.test(l));
  const body = end < 0 ? lines : lines.slice(0, end);

  const found: { date: string; title: string }[] = [];
  /** The index of the next line with text at or after `from`, or -1. */
  const next = (from: number) => {
    for (let i = from; i < body.length; i++) if (body[i] !== "") return i;
    return -1;
  };

  for (let i = 0; i < body.length; i++) {
    let date: string | null = null;
    let after = -1; // the line after the date
    if (ONE_LINE_DATE.test(body[i]!)) {
      const [day, month, year] = body[i]!.split(/\s+/);
      date = parseMonthDate(day!, month!, year!);
      after = i + 1;
    } else if (DAY.test(body[i]!)) {
      const m = next(i + 1);
      const y = m < 0 ? -1 : next(m + 1);
      if (m >= 0 && y >= 0 && MONTH.test(body[m]!) && YEAR.test(body[y]!)) {
        date = parseMonthDate(body[i]!, body[m]!, body[y]!);
        after = y + 1;
      }
    }
    if (date === null) continue;
    const t = next(after);
    const title = t < 0 ? null : TITLE_HEADING.exec(body[t]!)?.[1];
    if (title === null || title === undefined) continue;
    found.push({ date, title: title.replace(/\s+/g, " ") });
    i = t;
  }

  const pages = eventPages(Array.isArray(links) ? links : []);
  const zip = pages.length === found.length;
  return found.map((e, i) => ({ ...e, url: zip ? pages[i]! : null }));
}
