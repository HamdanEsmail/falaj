// academic_deadlines: UAEU's course and university withdrawal deadlines and the refund percentage
// that applies up to each. One Fetch URL.
import { z } from "zod";
import { fetchMeta } from "../catalogue/read";
import { readDeadlines } from "../pages/read";
import { ENVELOPE, stamp } from "./envelope";
import { defineTool } from "./types";

export const academicDeadlines = defineTool({
  name: "academic_deadlines",
  title: "Academic deadlines",
  description:
    "Reads UAEU's withdrawal deadlines and tuition refund schedule (Student Account Office): for each payment " +
    "system (full-semester, monthly, quarterly) and period, the dates between which a course withdrawal " +
    "or registration suspension is refunded, and the refund percentage. After a row's end date the student " +
    "owes the full tuition. Dates are the semester the page currently describes. " +
    "Returns {deadlines: [{label (the system and period, then the status, e.g. \"Courses Under the " +
    "Full-Semester System: Course Withdrawal\"), date_or_rule (the dates as the page writes them), refund_percent, " +
    "start_date, end_date (ISO YYYY-MM-DD, null when the page gives a rule rather than a date)}], " +
    "policy_summary (the page's opening paragraph), url} plus source_url, read_at, method, cached and ttl_seconds. " +
    "Reads the live UAEU page with TinyFetch (1 URL; TinyFish may serve a copy up to an hour old). " +
    "Example: academic_deadlines({})",
  input: {},
  output: {
    deadlines: z.array(
      z.object({
        label: z.string(),
        date_or_rule: z.string(),
        refund_percent: z.number().nullable(),
        start_date: z.string().nullable(),
        end_date: z.string().nullable(),
      }),
    ),
    policy_summary: z.string(),
    url: z.string(),
    ...ENVELOPE,
  },
  async run(_args, t) {
    const page = await readDeadlines(t);
    return stamp(
      { deadlines: page.deadlines, policy_summary: page.policy_summary, url: page.source_url },
      fetchMeta(page.source_url, page.read_at),
    );
  },
});
