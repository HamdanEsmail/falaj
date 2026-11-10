// POST /mcp: Streamable HTTP in stateless JSON mode. Every request gets a new
// transport and a new server, no session id is ever issued, and the answer is
// a single JSON body (no SSE stream).
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { checkCaller } from "../db/rate";
import type { Env } from "../env";
import { buildServer } from "./server";

export const mcpRouter = new Hono<{ Bindings: Env }>();

mcpRouter.post("/mcp", async (c) => {
  // The caller key is the client IP alone: stateless mode issues no session id,
  // so a client-sent Mcp-Session-Id is never a rate key, only logged hashed.
  const callerKey = c.req.header("cf-connecting-ip") ?? "anon";
  const sessionId = c.req.header("mcp-session-id") ?? null;
  // One JSON-RPC message per request. A batch would carry up to a hundred tool calls past the
  // caller limit, which is counted per request, so an array body is refused before anything runs.
  const raw = await c.req.text();
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    message = undefined;
  }
  if (Array.isArray(message)) {
    return c.json(
      {
        code: "INVALID_INPUT",
        message: "Send one JSON-RPC message per request; Falaj does not take batches",
        fix: "Post each call on its own",
      },
      400,
    );
  }
  const gated = await checkCaller(c.env.DB, callerKey, new Date());
  if (!gated.ok) {
    // Bypass the transport so the body is the error contract, not JSON-RPC.
    return c.json(
      {
        code: "RATE_LIMITED",
        message: "Too many calls from this caller",
        scope: "caller",
        retry_after_seconds: gated.retry_after_seconds,
      },
      429,
    );
  }
  // Hono types executionCtx with its own narrower interface; the object is the
  // platform's ExecutionContext.
  const server = buildServer(c.env, c.executionCtx as ExecutionContext, callerKey, sessionId);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  // The body was read above, so the transport gets the same request with the same body.
  return transport.handleRequest(new Request(c.req.raw.url, { method: "POST", headers: c.req.raw.headers, body: raw }));
});

mcpRouter.get("/mcp", (c) => {
  const url = `${c.env.PUBLIC_BASE_URL}/mcp`;
  c.header("Allow", "POST");
  return c.json(
    {
      error: "use POST",
      install: {
        claude_code: `claude mcp add --transport http falaj ${url}`,
        claude_desktop: { mcpServers: { falaj: { url } } },
        cursor: { mcpServers: { falaj: { url } } },
        chatgpt: { url },
        mcp_remote: `npx mcp-remote ${url}`,
      },
    },
    405,
  );
});
