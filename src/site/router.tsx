// The visitor's page and the form on it. The page is drawn on the server from Falaj's own record;
// the form runs one real tool call and draws the page again with the answer in it.
import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../env";
import { pageData } from "./data";
import { Home } from "./home";
import { isTryTool, runTry, TRYABLE, type TryTool, type TryView } from "./try";

type AppContext = Context<{ Bindings: Env }>;

export const siteRouter = new Hono<{ Bindings: Env }>();

/**
 * Sends the page with a content security policy: files of this site only, the two font hosts, no
 * inline script or style, no framing, forms that post here. What a visitor types is escaped as well;
 * this is the second lock.
 */
async function send(c: AppContext, view: TryView, status: 200 | 400 | 429 = 200) {
  const data = await pageData(c.env.DB, c.env.PUBLIC_BASE_URL, new Date());
  return c.html((<Home data={data} view={view} />) as unknown as string, status, {
    "cache-control": "no-store",
    "content-security-policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' https://api.fontshare.com https://fonts.googleapis.com",
      "font-src https://cdn.fontshare.com https://fonts.gstatic.com",
      "img-src 'self' data:",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
  });
}

function rest(tool: TryTool): TryView {
  return { kind: "rest", tool, value: TRYABLE[tool].field?.sample ?? "" };
}

siteRouter.get("/", (c) => {
  const picked = c.req.query("try");
  return send(c, rest(isTryTool(picked) ? picked : "search_courses"));
});

siteRouter.post("/try", async (c) => {
  const form = await c.req.parseBody();
  const { status, view } = await runTry(
    c.env,
    c.executionCtx as ExecutionContext,
    c.req.header("cf-connecting-ip") ?? "anon",
    form,
    new Date(),
  );
  return send(c, view, status);
});

// The answer page lives at /try; opened again without a question it is just the form.
siteRouter.get("/try", (c) => c.redirect("/#try", 303));
