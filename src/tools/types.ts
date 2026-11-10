import type { z } from "zod";
import type { Env } from "../env";

/** How a result was read: TinyFetch, TinySearch, a cached Agent read, or Falaj's own status (health_check only). */
export type Method = "fetch" | "search" | "agent_cached" | "status";

export type ToolName =
  | "search_courses"
  | "get_course"
  | "list_programs"
  | "get_program"
  | "list_events"
  | "academic_deadlines"
  | "find_faculty"
  | "get_faculty_profile"
  | "get_academic_calendar"
  | "health_check";

/** What a tool's `run` gets besides its arguments. */
export type ToolContext = {
  env: Env;
  ctx: ExecutionContext;
  /** The per-caller key: cf-connecting-ip, or "anon" when absent. Never a client-sent session id. */
  callerKey: string;
  now: Date;
  /** Client-sent Mcp-Session-Id, hashed into the call log only; never a rate key. */
  sessionId?: string | null;
  /** When false, requestRead never starts an Agent run (canaries; default true). */
  allowAgentStart?: boolean;
};

/**
 * One tool: its MCP listing (name, title, description, zod input and output
 * shapes) and its `run`. tools/list, the call wrapper and GET /api/tools all
 * come from these definitions.
 */
export type ToolDef<I extends z.ZodRawShape, O extends z.ZodRawShape> = {
  name: ToolName;
  title: string;
  /** The text the model sees; includes one example call. */
  description: string;
  input: I;
  output: O;
  run(args: z.infer<z.ZodObject<I>>, t: ToolContext): Promise<z.infer<z.ZodObject<O>>>;
};

/** Identity helper that infers the shapes, so `run` is typed against them. */
export function defineTool<I extends z.ZodRawShape, O extends z.ZodRawShape>(def: ToolDef<I, O>): ToolDef<I, O> {
  return def;
}
