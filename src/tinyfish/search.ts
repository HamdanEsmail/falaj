// TinySearch: finds pages on UAEU's website. Free (12,000 requests a day).
import { PRICES } from "../core/spend";
import type { Env } from "../env";
import { tinyfishFetch } from "./client";

const SEARCH_API = "https://api.search.tinyfish.ai";
const SEARCH_PURPOSE = "find pages on a university website";

export type SearchHit = { url: string; title: string; snippet: string };

export async function searchSite(env: Env, query: string, domain: "uaeu.ac.ae"): Promise<SearchHit[]> {
  const u = new URL(SEARCH_API);
  u.searchParams.set("query", query);
  u.searchParams.set("include_domains", domain);
  u.searchParams.set("purpose", SEARCH_PURPOSE);
  const res = await tinyfishFetch(env, u.toString(), {
    method: "GET",
    spend: { kind: "search", amountUsd: PRICES.search, ref: domain },
  });
  // Shape confirmed live: { query, results: [{ position, site_name, snippet, title, url, date? }], total_results, page }
  const body = (await res.json()) as { results?: unknown };
  if (!Array.isArray(body.results)) return [];
  const hits: SearchHit[] = [];
  for (const r of body.results as Record<string, unknown>[]) {
    if (r === null || typeof r !== "object" || typeof r.url !== "string" || r.url === "") continue;
    hits.push({
      url: r.url,
      title: typeof r.title === "string" ? r.title : "",
      snippet: typeof r.snippet === "string" ? r.snippet : "",
    });
  }
  return hits;
}
