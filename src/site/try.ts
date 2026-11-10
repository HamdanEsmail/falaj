// The form on the page that runs a real tool. Three of the ten can be tried there: the ones a
// single free read answers. The call goes through runTool like an assistant's, so it is gated,
// logged and counted the same way; the page only adds its own limit per visitor.
import { TRY_PER_MINUTE, TRY_ROWS } from "../core/limits";
import { checkTry } from "../db/rate";
import type { Env } from "../env";
import { runTool } from "../mcp/server";
import { toolByName } from "../tools/registry";

export const TRYABLE = {
  search_courses: { tab: "Search courses", field: { name: "query", label: "A code, a title or a topic", sample: "machine learning" } },
  get_course: { tab: "Read a course", field: { name: "code", label: "A course code", sample: "HSR140" } },
  academic_deadlines: { tab: "Deadlines", field: null },
} as const;

export type TryTool = keyof typeof TRYABLE;
export const TRY_TOOLS = Object.keys(TRYABLE) as TryTool[];

export function isTryTool(s: unknown): s is TryTool {
  return typeof s === "string" && Object.hasOwn(TRYABLE, s);
}

export type Row = { a: string; b: string };

export type TryView =
  | { kind: "rest"; tool: TryTool; value: string }
  | {
      kind: "answer";
      tool: TryTool;
      value: string;
      /** The count in front of the heading, when the answer is a list. */
      num: number | null;
      head: string;
      /** Code rows set their first part strong; pair rows are label and value. */
      strong: boolean;
      rows: Row[];
      note: string | null;
      source_url: string;
      read_at: string;
      method: string;
      ms: number;
    }
  | { kind: "error"; tool: TryTool; value: string; title: string; message: string; fix: string | null };

const ERROR_TITLES: Record<string, string> = {
  NOT_FOUND: "Nothing found",
  INVALID_INPUT: "That does not look right",
  RATE_LIMITED: "The day's share is used up",
  SITE_CHANGED: "The university changed this page",
  UPSTREAM_TIMEOUT: "The read took too long",
  BUDGET_PAUSED: "Paused for now",
};

/** The arguments the form's one field becomes. */
export function argsOf(tool: TryTool, value: string): Record<string, unknown> {
  if (tool === "search_courses") return { query: value, limit: TRY_ROWS };
  if (tool === "get_course") return { code: value.replace(/\s+/g, "").toUpperCase() };
  return {};
}

/** The same call as an assistant sends it. */
export function callText(tool: TryTool, value: string): string {
  const { limit: _limit, ...args } = argsOf(tool, value) as { limit?: number };
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }, null, 2);
}

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

type Answer = Extract<TryView, { kind: "answer" }>;

function shape(tool: TryTool, r: any): Pick<Answer, "num" | "head" | "strong" | "rows" | "note"> {
  if (tool === "search_courses") {
    const rows: Row[] = (r.courses as { code: string; title: string }[]).map((c) => ({ a: c.code, b: c.title }));
    const total = Number(r.total_matches);
    return {
      num: total,
      head: total === 1 ? "course" : "courses",
      strong: true,
      rows,
      note: total > rows.length ? `The first ${rows.length} are shown here. An assistant can ask for up to 50.` : null,
    };
  }
  if (tool === "get_course") {
    const rows: Row[] = [{ a: "Code", b: String(r.code) }];
    if (r.credit_hours !== null && r.credit_hours !== undefined) rows.push({ a: "Credit hours", b: String(r.credit_hours) });
    if (r.college) rows.push({ a: "College", b: String(r.college) });
    rows.push({ a: "Learning outcomes", b: String((r.learning_outcomes as unknown[]).length) });
    return { num: null, head: String(r.title).trim(), strong: false, rows, note: r.description ? clip(String(r.description), 260) : null };
  }
  const all = r.deadlines as { label: string; date_or_rule: string }[];
  const rows: Row[] = all.slice(0, TRY_ROWS).map((d) => ({ a: clip(d.label, 90), b: clip(d.date_or_rule, 120) }));
  return {
    num: all.length,
    head: all.length === 1 ? "deadline" : "deadlines",
    strong: false,
    rows,
    note: all.length > rows.length ? `The first ${rows.length} are shown here.` : null,
  };
}

/**
 * Runs what the form sent. `status` is 200 when the tool ran (its own errors included), 400 for a
 * tool that is not on the page, 429 when this visitor has asked too often.
 */
export async function runTry(
  env: Env,
  ctx: ExecutionContext,
  callerKey: string,
  form: Record<string, unknown>,
  now: Date,
): Promise<{ status: 200 | 400 | 429; view: TryView }> {
  const tool = form.tool;
  if (!isTryTool(tool)) {
    return {
      status: 400,
      view: {
        kind: "error",
        tool: "search_courses",
        value: TRYABLE.search_courses.field.sample,
        title: "That tool cannot be tried on this page",
        message: "Three of the ten can be tried here. All ten work from an assistant.",
        fix: null,
      },
    };
  }
  const field = TRYABLE[tool].field;
  const typed = field ? form[field.name] : "";
  const value = typeof typed === "string" ? typed.trim().slice(0, 120) : "";
  if (field && value === "") {
    return { status: 200, view: { kind: "error", tool, value, title: "Nothing to look for", message: `Type ${field.label.toLowerCase()} first.`, fix: null } };
  }

  const gate = await checkTry(env.DB, callerKey, now);
  if (!gate.ok) {
    const wait = gate.retry_after_seconds <= 60 ? `Try again in ${gate.retry_after_seconds} seconds.` : "Try again tomorrow.";
    return {
      status: 429,
      view: { kind: "error", tool, value, title: "Slow down", message: `This page takes ${TRY_PER_MINUTE} questions a minute from one visitor. ${wait}`, fix: null },
    };
  }

  const def = toolByName(tool)!;
  const started = Date.now();
  const result = await runTool(def, argsOf(tool, value), { env, ctx, callerKey, now });
  const ms = Date.now() - started;
  if (result.isError) {
    const first = result.content[0];
    const body = JSON.parse(first && first.type === "text" ? first.text : "{}") as { code?: string; message?: string; fix?: string };
    return {
      status: 200,
      view: {
        kind: "error",
        tool,
        value,
        title: ERROR_TITLES[body.code ?? ""] ?? "That did not work",
        message: body.message ?? "The tool gave no reason.",
        fix: body.fix ?? null,
      },
    };
  }
  const r = result.structuredContent as any;
  return {
    status: 200,
    view: { kind: "answer", tool, value, ...shape(tool, r), source_url: String(r.source_url), read_at: String(r.read_at), method: String(r.method), ms },
  };
}
