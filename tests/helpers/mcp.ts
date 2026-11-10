// JSON-RPC over POST /mcp, the way a stateless Streamable HTTP client sends it:
// one request per call, no session header, JSON answers.
import { callWorker } from "./app";

export async function rpc(
  method: string,
  params?: unknown,
  id = 1,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; headers: Headers; body: any }> {
  const res = await callWorker("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...extraHeaders,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text === "" ? null : JSON.parse(text) };
}

/** `tools/call`, returning the JSON-RPC `result` (a CallToolResult). */
export async function callTool(name: string, args: unknown, extraHeaders?: Record<string, string>): Promise<any> {
  return (await rpc("tools/call", { name, arguments: args }, 1, extraHeaders)).body.result;
}

/** `tools/list`, returning the tool definitions. */
export async function listTools(): Promise<any[]> {
  return (await rpc("tools/list", {})).body.result.tools;
}
