// list_events: the highlighted events on the UAEU events page. One Fetch URL.
import { z } from "zod";
import { fetchMeta } from "../catalogue/read";
import { ToolError } from "../core/errors";
import { RESULT_LIMIT_DEFAULT, RESULT_LIMIT_MAX } from "../core/limits";
import { readEvents } from "../pages/read";
import { ENVELOPE, stamp } from "./envelope";
import { defineTool } from "./types";

const NOTE = "Highlighted events from uaeu.ac.ae/en/events; may include past events";

export const listEvents = defineTool({
  name: "list_events",
  title: "List events",
  description:
    "Lists the highlighted events on UAEU's events page (uaeu.ac.ae/en/events): a handful of featured events, " +
    "each with its date, title and its own page. This is the page's highlights, not a full calendar, and it may " +
    "include events that have already happened; the events come in the page's own order. " +
    "`from` and `to` (YYYY-MM-DD, both days included) keep the events in that range; `limit` is 1 to 50, default 20. " +
    "Returns {events: [{date (YYYY-MM-DD), title, url (null when the page's address cannot be matched)}], " +
    "total (after the date range, before the limit), note} plus source_url, read_at, method, cached and ttl_seconds. " +
    "Reads the live UAEU events page and its links with TinyFetch (1 URL; TinyFish may serve a copy up to an hour old). " +
    "Example: list_events({\"from\": \"2026-02-01\", \"to\": \"2026-02-28\"})",
  input: {
    from: z.string().date().optional().describe("First day to include, YYYY-MM-DD"),
    to: z.string().date().optional().describe("Last day to include, YYYY-MM-DD"),
    limit: z.number().int().min(1).max(RESULT_LIMIT_MAX).optional().describe(`How many events to return, default ${RESULT_LIMIT_DEFAULT}`),
  },
  output: {
    events: z.array(
      z.object({
        date: z.string(),
        title: z.string(),
        url: z.string().nullable(),
      }),
    ),
    total: z.number().int(),
    note: z.string(),
    ...ENVELOPE,
  },
  async run({ from, to, limit }, t) {
    if (from !== undefined && to !== undefined && from > to) {
      throw new ToolError("INVALID_INPUT", `from (${from}) is after to (${to})`, {
        fix: "Pass from on or before to, both as YYYY-MM-DD",
      });
    }
    const page = await readEvents(t);
    // ISO dates order as text, so a string comparison is a date comparison.
    const inRange = page.events.filter((e) => (from === undefined || e.date >= from) && (to === undefined || e.date <= to));
    // An empty answer to a date range says why: how many events the page lists and when they are dated,
    // so an assistant can tell "all of them are outside the range" from "the call was wrong".
    let note = NOTE;
    if (inRange.length === 0 && page.events.length > 0 && (from !== undefined || to !== undefined)) {
      const dates = page.events.map((e) => e.date).sort();
      note = `${NOTE}. The page lists ${page.events.length} events, dated ${dates[0]} to ${dates[dates.length - 1]}; none falls in the range asked for.`;
    }
    return stamp(
      { events: inRange.slice(0, limit ?? RESULT_LIMIT_DEFAULT), total: inRange.length, note },
      fetchMeta(page.source_url, page.read_at),
    );
  },
});
