import { describe, expect, it } from "vitest";
import { listTools, rpc } from "./helpers/mcp";

describe("MCP endpoint (stateless, JSON)", () => {
  it("initialize answers JSON without a session id", async () => {
    const r = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "t", version: "0" },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("mcp-session-id")).toBeNull();
    expect(r.body.result.serverInfo.name).toBe("falaj");
  });

  it("tools/list works with no prior initialize (stateless) and lists health_check with annotations and schemas", async () => {
    const tools = await listTools();
    const hc = tools.find((t: any) => t.name === "health_check");
    expect(hc.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true, destructiveHint: false });
    expect(hc.inputSchema.type).toBe("object");
    expect(hc.outputSchema.type).toBe("object");
  });

  it("tools/call for an unknown tool name is a JSON-RPC InvalidParams error (-32602)", async () => {
    const r = await rpc("tools/call", { name: "no_such_tool", arguments: {} });
    expect(r.body.error.code).toBe(-32602);
    expect(r.body.error.message).toContain("no_such_tool");
  });
});
