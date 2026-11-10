// The reads behind list_events and academic_deadlines: one Fetch URL each, through the same
// `readPage` as the catalogue tools (one place turns a page TinyFish could not read into
// UPSTREAM_TIMEOUT and a redirect into SITE_CHANGED). Each URL is counted against the daily cap
// in readPage.
import { SITE_CHANGED_FIX, readPage } from "../catalogue/read";
import { ToolError } from "../core/errors";
import { parseDeadlines, policySummary, type Deadline } from "../parsers/deadlines";
import { parseEvents, type EventItem } from "../parsers/events";
import type { ToolContext } from "../tools/types";

export const EVENTS_URL = "https://www.uaeu.ac.ae/en/events/";
export const REFUNDS_URL = "https://www.uaeu.ac.ae/en/dvcsae/student_account_office/refunds.shtml";

/** The highlighted events on the UAEU events page, with their own pages from its links. One Fetch URL. A page with no event on it is SITE_CHANGED. */
export async function readEvents(t: ToolContext): Promise<{ events: EventItem[]; source_url: string; read_at: Date }> {
  const page = await readPage(t, EVENTS_URL, true, { page: "events page" });
  const events = parseEvents(page.text, page.links);
  if (events.length === 0) {
    throw new ToolError("SITE_CHANGED", `No events found on the UAEU events page ${EVENTS_URL}`, {
      source_url: EVENTS_URL,
      fix: SITE_CHANGED_FIX,
    });
  }
  return { events, source_url: EVENTS_URL, read_at: page.read_at };
}

/** The withdrawal deadlines and the policy summary on the UAEU refunds page. One Fetch URL. A page with no deadline table is SITE_CHANGED. */
export async function readDeadlines(
  t: ToolContext,
): Promise<{ deadlines: Deadline[]; policy_summary: string; source_url: string; read_at: Date }> {
  const page = await readPage(t, REFUNDS_URL, false, { page: "withdrawal deadlines page" });
  const deadlines = parseDeadlines(page.text);
  if (deadlines.length === 0) {
    throw new ToolError("SITE_CHANGED", `No withdrawal deadlines found on the UAEU page ${REFUNDS_URL}`, {
      source_url: REFUNDS_URL,
      fix: SITE_CHANGED_FIX,
    });
  }
  return { deadlines, policy_summary: policySummary(page.text), source_url: REFUNDS_URL, read_at: page.read_at };
}
