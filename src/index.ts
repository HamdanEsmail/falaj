import { Hono } from "hono";
import { adminOnly } from "./auth";
import { scheduled } from "./cron";
import type { Env } from "./env";
import { adminRouter } from "./handlers/admin";
import { apiRouter } from "./handlers/api";
import { webhooksRouter } from "./handlers/webhooks";
import { mcpRouter } from "./mcp/route";
import { siteRouter } from "./site/router";

const app = new Hono<{ Bindings: Env }>();

app.route("/", mcpRouter);
app.route("/api/webhooks", webhooksRouter);

// Every admin route needs the bearer token.
app.use("/api/admin/*", adminOnly);
app.post("/api/admin/ping", (c) => c.json({ ok: true }));
app.route("/api/admin", adminRouter);
app.route("/api", apiRouter);
app.route("/", siteRouter);

export { app };

export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<Env>;
