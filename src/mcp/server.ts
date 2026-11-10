// The MCP server for one request. It uses the SDK's low-level `Server`, not
// `McpServer`: `McpServer.registerTool` validates input itself and turns both
// validation failures and thrown errors into plain-text results, which would
// break Falaj's error contract (every failure is our JSON body). Here
// tools/list and tools/call are driven by TOOLS, and `runTool` owns
// validation and error mapping.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import pkg from "../../package.json";
import { ToolError } from "../core/errors";
import { logCall } from "../db/calls";
import { getToolStatus } from "../db/toolStatus";
import type { Env } from "../env";
import { brokenGateError } from "../health/canaries";
import { TinyFishError } from "../tinyfish/client";
import { TOOLS, toolByName } from "../tools/registry";
import type { ToolContext, ToolDef } from "../tools/types";

/** The same on every Falaj tool: it only reads UAEU's public website. */
export const ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: true,
} as const;

/**
 * A tool's input and output JSON Schemas, converted from its zod shapes the way
 * SDK 1.32.2's McpServer does for zod 4 (`toJSONSchema`, draft-7, `io: "input"`
 * for the input and `io: "output"` for the output). The one place schemas are
 * built: tools/list and GET /api/tools both use it, so they agree.
 */
export function toolJsonSchemas(def: ToolDef<any, any>): {
  inputSchema: Tool["inputSchema"];
  outputSchema: NonNullable<Tool["outputSchema"]>;
} {
  const inputSchema = z.toJSONSchema(z.object(def.input), { target: "draft-7", io: "input" });
  const outputSchema = z.toJSONSchema(z.object(def.output), { target: "draft-7", io: "output" });
  if (inputSchema.type !== "object" || outputSchema.type !== "object") {
    throw new Error(`${def.name}: tool schemas must be JSON Schema objects`);
  }
  return {
    inputSchema: inputSchema as Tool["inputSchema"],
    outputSchema: outputSchema as NonNullable<Tool["outputSchema"]>,
  };
}

/** A tool as tools/list shows it. */
export function toolListing(def: ToolDef<any, any>): Tool {
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    ...toolJsonSchemas(def),
    annotations: { ...ANNOTATIONS },
  };
}

function errorResult(err: ToolError): CallToolResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify(err.toBody()) }] };
}

/** True when `test` holds for the error itself or for anything on its cause chain. */
function inCauseChain(err: unknown, test: (e: object) => boolean): boolean {
  let e: unknown = err;
  for (let depth = 0; depth < 4 && typeof e === "object" && e !== null; depth++) {
    if (test(e)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** An abort or timeout, on the error itself or on its cause chain. */
function isTimeout(err: unknown): boolean {
  return inCauseChain(err, (e) => {
    const name = (e as { name?: unknown }).name;
    return name === "AbortError" || name === "TimeoutError";
  });
}

/** True when TinyFish failed or did not answer in time: the caller should retry later. */
function isUpstreamFailure(err: unknown): boolean {
  return isTimeout(err) || inCauseChain(err, (e) => e instanceof TinyFishError);
}

/**
 * Runs one tool call: validates the arguments with zod (INVALID_INPUT on
 * failure), runs the tool, parses its result through the output shape (unknown
 * keys are stripped), and maps errors onto the contract. A ToolError
 * becomes an `isError` result with its JSON body; a TinyFish failure or a
 * timeout becomes UPSTREAM_TIMEOUT; anything else is rethrown and answers as a
 * JSON-RPC internal error. Every call is written to the call log.
 */
export async function runTool(
  def: ToolDef<any, any>,
  args: unknown,
  t: ToolContext,
  opts?: { gate?: boolean },
): Promise<CallToolResult> {
  const started = Date.now();
  let status: "ok" | "error" = "ok";
  let errorCode: string | null = null;
  try {
    // Canaries pass gate: false so a broken tool can be re-verified and cleared.
    if (opts?.gate !== false && def.name !== "health_check") {
      const st = await getToolStatus(t.env.DB, def.name);
      if (st?.status === "broken") throw brokenGateError(def.name, st.detail, st.last_checked_at);
    }
    const parsed = z.object(def.input).safeParse(args ?? {});
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "arguments"}: ${issue.message}`)
        .join("; ");
      throw new ToolError("INVALID_INPUT", `Invalid arguments for ${def.name}: ${detail}`, {
        fix: `Check the arguments against ${def.name}'s inputSchema in tools/list`,
      });
    }
    // The emitted outputSchema says `additionalProperties: false`, so what leaves here is the
    // tool's result parsed through that same shape (zod strips keys it does not name). A result
    // that does not fit is a bug in the tool: the ZodError is not a ToolError, so it is rethrown
    // below and answers as a JSON-RPC internal error.
    const result = z.object(def.output).parse(await def.run(parsed.data, t)) as Record<string, unknown>;
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
  } catch (err) {
    status = "error";
    if (err instanceof ToolError) {
      errorCode = err.code;
      return errorResult(err);
    }
    if (isUpstreamFailure(err)) {
      errorCode = "UPSTREAM_TIMEOUT";
      return errorResult(
        new ToolError("UPSTREAM_TIMEOUT", "TinyFish did not answer in time while reading uaeu.ac.ae", {
          retry_after_seconds: 30,
        }),
      );
    }
    throw err;
  } finally {
    try {
      await logCall(t.env.DB, {
        tool: def.name,
        args,
        ms: Date.now() - started,
        status,
        error_code: errorCode,
        callerKey: t.callerKey,
        sessionId: t.sessionId ?? null,
      });
    } catch {
      console.error("call log write failed");
    }
  }
}

/**
 * The MCP server for one request (stateless: one per POST /mcp). Returns the
 * SDK's low-level `Server` rather than an `McpServer` (see the top of this file).
 */
export function buildServer(
  env: Env,
  ctx: ExecutionContext,
  callerKey: string,
  sessionId: string | null = null,
): Server {
  const server = new Server({ name: "falaj", version: pkg.version }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS.map(toolListing) }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const def = toolByName(request.params.name);
    if (!def) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`);
    return runTool(def, request.params.arguments ?? {}, { env, ctx, callerKey, sessionId, now: new Date() });
  });

  return server;
}
