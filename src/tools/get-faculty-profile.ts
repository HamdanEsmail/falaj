// get_faculty_profile: a UAEU faculty page, served from agent_cache. A first
// read starts at most one Agent run and answers {status:"reading"}; later
// calls serve the cached profile.
import { z } from "zod";
import { requestProfileRead } from "../agent/reads";
import { daysBetween } from "../core/dates";
import { ToolError } from "../core/errors";
import { STALE_DAYS } from "../core/limits";
import { normalizeProfile } from "../parsers/calendar";
import { canonicalProfileUrl } from "../parsers/faculty";
import { ENVELOPE, stamp } from "./envelope";
import { defineTool } from "./types";

const OPTIONAL = {
  source_url: ENVELOPE.source_url.optional(),
  read_at: ENVELOPE.read_at.optional(),
  method: ENVELOPE.method.optional(),
  cached: ENVELOPE.cached.optional(),
  ttl_seconds: ENVELOPE.ttl_seconds,
};


export const getFacultyProfile = defineTool({
  name: "get_faculty_profile",
  title: "Get a faculty profile",
  description:
    "Reads one UAEU faculty profile page (name, title, college, department, email if shown, " +
    "research interests and education). The page is JavaScript-rendered, so Falaj starts a " +
    "capped TinyAgent run when the profile is not yet cached and answers " +
    "{status: \"reading\", eta_seconds: 90} until that run finishes; call again then. " +
    "The profile_url must be a https://www.uaeu.ac.ae/…/profile.shtml?email=… address " +
    "(find_faculty returns those). Returns the profile fields plus source_url, read_at, " +
    "method (agent_cached), cached and stale, or the reading shape. " +
    "Example: get_faculty_profile({\"profile_url\": \"https://www.uaeu.ac.ae/en/cmhs/profile.shtml?email=a.example@uaeu.ac.ae\"})",
  input: {
    profile_url: z.string().url().describe("A UAEU faculty profile URL from find_faculty"),
  },
  output: {
    name: z.string().optional(),
    title: z.string().nullable().optional(),
    college: z.string().nullable().optional(),
    department: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    research_interests: z.array(z.string()).optional(),
    education: z.array(z.string()).optional(),
    profile_url: z.string().optional(),
    stale: z.boolean().optional(),
    status: z.literal("reading").optional(),
    eta_seconds: z.number().optional(),
    retry: z.string().optional(),
    ...OPTIONAL,
  },
  async run({ profile_url: given }, t) {
    // The page is read and cached under its one canonical address, never under the text as given.
    const profile_url = canonicalProfileUrl(given);
    if (profile_url === null) {
      throw new ToolError(
        "INVALID_INPUT",
        "profile_url must be a https://www.uaeu.ac.ae/en/<college>/profile.shtml?email=<name>@uaeu.ac.ae address of one of the nine UAEU colleges",
        { fix: "Pass a profile URL from find_faculty" },
      );
    }
    const r = await requestProfileRead(t, profile_url);
    if (r.status === "reading") {
      return {
        status: "reading" as const,
        eta_seconds: r.eta_seconds,
        retry: `call again in ${r.eta_seconds} seconds`,
      };
    }
    const profile = normalizeProfile(r.data, profile_url);
    if (profile === null) {
      throw new ToolError("SITE_CHANGED", `The faculty profile at ${profile_url} could not be read`, {
        source_url: profile_url,
        fix: "UAEU changed this page; health_check shows when it was last seen working, so try again later",
      });
    }
    const stale = daysBetween(new Date(r.read_at), t.now) > STALE_DAYS;
    return stamp({ ...profile, stale }, {
      source_url: profile_url,
      method: "agent_cached",
      cached: true,
      read_at: new Date(r.read_at),
    });
  },
});
