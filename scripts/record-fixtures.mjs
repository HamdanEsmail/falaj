// Records the six UAEU page fixtures (tests/fixtures/uaeu/*.json) with ONE live TinyFetch
// request, then runs the cache-indicator probe (the refunds page twice with ttl 3600).
// A second named batch, `--batch extra`, records four more pages with ONE more request
// and no probe: a minor, a micro-credential, the AERO485 course page and the programmes index's
// own single-hyphen link to the Mathematics of Data Science page.
// TinyFetch is free. Run each batch once; the tests never touch the network.
//
// The API key is read here, in-process, from .dev.vars (parsed as KEY=value lines, a trailing
// CR and surrounding whitespace or quotes stripped). It is never read from the shell's
// environment and never printed, logged or written to a file: not the key, its length or any part.
//
//   node scripts/record-fixtures.mjs --dry     parse .dev.vars and print the plan; no network, no writes
//   node scripts/record-fixtures.mjs           record, then probe
//   --skip-record / --skip-probe               run only one of the two stages
//   --batch extra                              the four-page batch above (no probe)
//
// Test hooks (used to check parsing and writing against a local stub with a fake key):
//   --env-file <path>   read the key from this file instead of .dev.vars
//   --api <url>         send requests here instead of TinyFetch; only a loopback address is accepted
//   --out-dir <dir>     write the fixtures here instead of tests/fixtures/uaeu
//   --scratch-dir <dir> write the raw dumps here instead of the gitignored .scratch/fixtures dir
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TINYFETCH = "https://api.fetch.tinyfish.ai";

/** The six pages and the fixture each one becomes. */
export const TARGETS = [
  ["https://www.uaeu.ac.ae/en/catalog/courses/", "catalogue-index.json"],
  ["https://www.uaeu.ac.ae/en/catalog/courses/course_2924.shtml?id=HSR140", "course-hsr140.json"],
  ["https://www.uaeu.ac.ae/en/catalog/undergraduate/programs/", "programs-index.json"],
  [
    "https://www.uaeu.ac.ae/en/catalog/undergraduate/programs/bachelor-of-science-in--the-mathematics-of-data-science.shtml",
    "program-mds.json",
  ],
  ["https://www.uaeu.ac.ae/en/events/", "events.json"],
  ["https://www.uaeu.ac.ae/en/dvcsae/student_account_office/refunds.shtml", "refunds.json"],
];
const PROBE_URL = "https://www.uaeu.ac.ae/en/dvcsae/student_account_office/refunds.shtml";

/**
 * The second batch. URLs 1 to 3 were derived from the recorded fixtures with the parsers:
 * the first programme in the programmes index's page order for which programKind(slugToName(slug))
 * is "minor", the first for which it is "micro_credential", and
 * parseCatalogue(catalogue-index).courseMap.get("AERO485"). URL 4 is the Mathematics of Data
 * Science link exactly as the index writes it (a single hyphen after "science-in"); the first
 * recording (TARGETS above) used the double-hyphen form.
 */
export const EXTRA_TARGETS = [
  [
    "https://www.uaeu.ac.ae/en/catalog/undergraduate/programs/minor-in--statistics-and-data-analytics.shtml",
    "program-minor.json",
  ],
  [
    "https://www.uaeu.ac.ae/en/catalog/undergraduate/programs/creditbearing-microcredential-in-accounting-foundations.shtml",
    "program-microcredential.json",
  ],
  ["https://www.uaeu.ac.ae/en/catalog/courses/course_2945.shtml?id=AERO485", "course-aero485.json"],
  [
    "https://www.uaeu.ac.ae/en/catalog/undergraduate/programs/bachelor-of-science-in-the-mathematics-of-data-science.shtml",
    "program-mds-single-hyphen.json",
  ],
];

/** The named batches: what to record, what to call the raw dump, and whether the cache probe follows. */
const BATCHES = {
  default: { targets: TARGETS, rawName: "task-2-record-raw.json", probe: true },
  extra: { targets: EXTRA_TARGETS, rawName: "task-5-record-raw.json", probe: false },
};

/** Reads `--name value` and `--flag` options. */
function parseArgs(argv) {
  const opts = { flags: new Set(), values: new Map() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const name = a.slice(2);
    if (["env-file", "api", "out-dir", "scratch-dir", "batch"].includes(name)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`--${name} needs a value`);
      opts.values.set(name, v);
    } else if (["dry", "skip-record", "skip-probe"].includes(name)) {
      opts.flags.add(name);
    } else {
      throw new Error(`unknown option ${a}`);
    }
  }
  return opts;
}

/**
 * Pulls TINYFISH_API_KEY out of dotenv text. Tolerates CRLF, a BOM, `export `, whitespace around
 * the value and one pair of matching quotes. Returns null when absent or empty.
 */
export function parseKey(text) {
  for (const raw of text.replace(/^﻿/, "").split(/\r\n|\n|\r/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?TINYFISH_API_KEY\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[1].trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1).trim();
    return v === "" ? null : v;
  }
  return null;
}

/** A header the dump must not carry. */
const AUTHISH = /auth|cookie|key|token|secret|credential/i;

function safeHeaders(res, key) {
  const out = {};
  for (const [name, value] of res.headers) {
    if (AUTHISH.test(name)) continue;
    out[name] = value.includes(key) ? "[redacted]" : value;
  }
  return out;
}

async function post(api, key, body) {
  const res = await fetch(api, {
    method: "POST",
    headers: { "X-API-Key": key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  return { res, text };
}

/** Prints the status and, if the body is JSON with a short token as its error code, that code. */
function reportFailure(label, res, text) {
  let code = "";
  try {
    const b = JSON.parse(text);
    const c = b?.error?.code ?? b?.code;
    if (typeof c === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(c)) code = ` ${c}`;
  } catch {
    // not JSON
  }
  console.error(`${label}: HTTP ${res.status}${code}`);
}

/** Aligns results to a requested url by `url` or `final_url`. */
function pick(body, url) {
  const result = (body.results ?? []).find((r) => r?.url === url || r?.final_url === url);
  const error = (body.errors ?? []).find((e) => e?.url === url);
  return { result, error };
}

async function record({ api, key, outDir, scratchDir, batch }) {
  const { targets, rawName } = batch;
  const urls = targets.map(([u]) => u);
  console.log(`record: ${urls.length} urls, one request:`);
  for (const u of urls) console.log(`  ${u}`);
  const { res, text } = await post(api, key, {
    urls,
    format: "markdown",
    links: true,
    ttl: 0,
    per_url_timeout_ms: 45_000,
  });
  // Dump the raw reply first, so a bug in the splitting below never costs a second live call.
  mkdirSync(scratchDir, { recursive: true });
  writeFileSync(
    join(scratchDir, rawName),
    JSON.stringify({ status: res.status, headers: safeHeaders(res, key), body: text }, null, 2) + "\n",
  );
  if (!res.ok) {
    reportFailure("record", res, text);
    return false;
  }
  const body = JSON.parse(text);
  console.log(
    `record: HTTP ${res.status}, top-level fields [${Object.keys(body).join(", ")}], ${body.results?.length ?? 0} results, ${body.errors?.length ?? 0} errors`,
  );
  mkdirSync(outDir, { recursive: true });
  let missing = 0;
  for (const [url, file] of targets) {
    const { result, error } = pick(body, url);
    const doc = result ? { results: [result], errors: [] } : { results: [], errors: [error ?? { url, error: "no_result" }] };
    if (!result) {
      missing++;
      console.error(`record: no result for ${url}: ${JSON.stringify(doc.errors[0])}`);
    }
    writeFileSync(join(outDir, file), JSON.stringify(doc, null, 2) + "\n");
    console.log(`wrote ${file}${result ? "" : " (error entry only)"}`);
  }
  // A URL TinyFish answered with an error entry is not a failed request: report it, keep going.
  if (missing > 0) process.exitCode = 2;
  return true;
}

/** What one probe reply looks like, without the page text. */
function describeReply(res, text, key) {
  const body = JSON.parse(text);
  const results = (body.results ?? []).map((r) => {
    const fields = {};
    for (const [k, v] of Object.entries(r)) {
      if (k === "text") {
        fields.text = { chars: v?.length ?? 0, sha256: createHash("sha256").update(String(v ?? "")).digest("hex") };
      } else if (k === "links") {
        fields.links = { count: Array.isArray(v) ? v.length : null };
      } else {
        fields[k] = typeof v === "string" && v.length > 200 ? `${v.slice(0, 200)}...` : v;
      }
    }
    return fields;
  });
  return {
    status: res.status,
    headers: safeHeaders(res, key),
    top_level_fields: Object.keys(body),
    top_level_scalars: Object.fromEntries(
      Object.entries(body).filter(([, v]) => v === null || ["string", "number", "boolean"].includes(typeof v)),
    ),
    result_fields: (body.results ?? []).map((r) => Object.keys(r)),
    results,
    errors: body.errors ?? [],
  };
}

async function probe({ api, key, scratchDir }) {
  const replies = [];
  for (let i = 1; i <= 2; i++) {
    const { res, text } = await post(api, key, {
      urls: [PROBE_URL],
      format: "markdown",
      links: false,
      ttl: 3600,
      per_url_timeout_ms: 45_000,
    });
    if (!res.ok) {
      reportFailure(`probe ${i}`, res, text);
      return false;
    }
    replies.push(describeReply(res, text, key));
  }
  mkdirSync(scratchDir, { recursive: true });
  writeFileSync(join(scratchDir, "task-2-probe.json"), JSON.stringify(replies, null, 2) + "\n");

  const [a, b] = replies;
  const diff = (x, y) => Object.keys({ ...x, ...y }).filter((k) => JSON.stringify(x[k]) !== JSON.stringify(y[k]));
  console.log(`probe: top-level fields [${a.top_level_fields.join(", ")}]`);
  console.log(`probe: result fields [${(a.result_fields[0] ?? []).join(", ")}]`);
  console.log(`probe: header names [${Object.keys(a.headers).join(", ")}]`);
  console.log(`probe: headers that differ between call 1 and 2: [${diff(a.headers, b.headers).join(", ")}]`);
  console.log(`probe: top-level scalars that differ: [${diff(a.top_level_scalars, b.top_level_scalars).join(", ")}]`);
  console.log(`probe: result fields that differ: [${diff(a.results[0] ?? {}, b.results[0] ?? {}).join(", ")}]`);
  const hint = /cache|age|hit|etag|last.?modified|fresh|stale/i;
  const named = [
    ...Object.keys(a.headers).filter((k) => hint.test(k)).map((k) => `header ${k}=${a.headers[k]} | ${b.headers[k]}`),
    ...a.top_level_fields.filter((k) => hint.test(k)),
    ...(a.result_fields[0] ?? []).filter((k) => hint.test(k)).map((k) => `result.${k}`),
  ];
  console.log(`probe: cache-like names: ${named.length > 0 ? named.join("; ") : "none"}`);
  return true;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const envFile = resolve(opts.values.get("env-file") ?? join(ROOT, ".dev.vars"));
  const api = opts.values.get("api") ?? TINYFETCH;
  const outDir = resolve(opts.values.get("out-dir") ?? join(ROOT, "tests/fixtures/uaeu"));
  const scratchDir = resolve(opts.values.get("scratch-dir") ?? join(ROOT, ".scratch/fixtures"));
  const batchName = opts.values.get("batch") ?? "default";
  const batch = BATCHES[batchName];
  if (batch === undefined) throw new Error(`unknown batch ${batchName}; known: ${Object.keys(BATCHES).join(", ")}`);
  // The cache probe belongs to the default batch only.
  const probeWanted = batch.probe && !opts.flags.has("skip-probe");

  if (api !== TINYFETCH) {
    // The key goes wherever --api points; only a loopback stub may receive it.
    const host = new URL(api).hostname;
    if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) throw new Error("--api must be a loopback address");
  }

  const key = parseKey(readFileSync(envFile, "utf8"));
  if (key === null) throw new Error("TINYFISH_API_KEY not found in the env file");
  // A key is one run of printable ASCII. Anything else (a stray CR, a space) means a bad parse.
  if (!/^[\x21-\x7e]+$/.test(key)) throw new Error("TINYFISH_API_KEY has whitespace or non-printable characters after parsing");

  if (opts.flags.has("dry")) {
    console.log("dry run: key found and well-formed (not shown); no request sent, nothing written");
    if (!opts.flags.has("skip-record")) {
      console.log(`would POST ${api} once with ${batch.targets.length} urls (batch ${batchName}), format markdown, links true, ttl 0, then write to ${outDir}:`);
      for (const [u, f] of batch.targets) console.log(`  ${f}  <-  ${u}`);
    }
    if (probeWanted) console.log(`would POST ${api} twice for ${PROBE_URL} with ttl 3600`);
    console.log(`raw dumps would go to ${scratchDir}`);
    return;
  }

  const ctx = { api, key, outDir, scratchDir, batch };
  // Exit code 1: a request failed (nothing, or not everything, was written). 2: written, but some URL has only an error entry.
  if (!opts.flags.has("skip-record") && !(await record(ctx))) {
    process.exitCode = 1;
    return;
  }
  if (probeWanted && !(await probe(ctx))) process.exitCode = 1;
}

// Run only when executed, not when imported (the stub check imports parseKey).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    // Never print err.stack or the request: only the message.
    console.error(`record-fixtures: ${err instanceof Error ? err.message : "failed"}`);
    process.exitCode = 1;
  });
}
