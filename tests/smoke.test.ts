import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { callWorker } from "./helpers/app";

describe("smoke", () => {
  it("GET /api/stats returns zero counts and spend", async () => {
    const res = await callWorker("/api/stats");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ calls: 0, spend_usd: 0, budget_share_usd: 3.5 });
  });

  it("admin route rejects a missing token", async () => {
    expect((await callWorker("/api/admin/ping", { method: "POST" })).status).toBe(401);
  });

  it("GET /mcp is 405 with install instructions", async () => {
    const res = await callWorker("/mcp");
    expect(res.status).toBe(405);
    expect(((await res.json()) as any).install.claude_code).toContain("claude mcp add --transport http falaj");
  });

  it("runs with the fixed test bindings, never the real TinyFish key", () => {
    expect(env.TINYFISH_API_KEY === "test-tinyfish-key").toBe(true);
    expect(env.ADMIN_TOKEN).toBe("test-admin");
    expect(env.WEBHOOK_SECRET).toBe("test-secret");
    expect(env.PUBLIC_BASE_URL).toBe("https://falaj.test");
  });
});
