// The output schemas sent to TinyFish with an Agent run. TinyFish answers 400 INVALID_INPUT to a
// schema whose "type" is a list (["string", "null"]), so a run with one never starts. Every field
// names one plain type; a field the page does not show is simply left out of the answer.
import { describe, expect, it } from "vitest";
import { CALENDAR_SCHEMA, PROFILE_SCHEMA, normalizeProfile } from "../src/parsers/calendar";

function typesIn(schema: unknown, path = "$"): { path: string; type: unknown }[] {
  if (schema === null || typeof schema !== "object") return [];
  const out: { path: string; type: unknown }[] = [];
  const o = schema as Record<string, unknown>;
  if ("type" in o) out.push({ path, type: o.type });
  if (o.properties !== null && typeof o.properties === "object") {
    for (const [k, v] of Object.entries(o.properties as Record<string, unknown>)) {
      out.push(...typesIn(v, `${path}.${k}`));
    }
  }
  if ("items" in o) out.push(...typesIn(o.items, `${path}[]`));
  return out;
}

describe("Agent output schemas", () => {
  it.each([
    ["profile", PROFILE_SCHEMA],
    ["calendar", CALENDAR_SCHEMA],
  ])("the %s schema names one plain type for every field", (_name, schema) => {
    const found = typesIn(schema);
    expect(found.length).toBeGreaterThan(3);
    for (const f of found) {
      expect(typeof f.type, `${f.path} has type ${JSON.stringify(f.type)}`).toBe("string");
    }
  });

  it("a profile answer that leaves out what the page does not show still reads, with nulls", () => {
    const got = normalizeProfile(
      { name: "  Dr. Example Person ", research_interests: ["Soil water"] },
      "https://www.uaeu.ac.ae/en/profile/?email=example",
    );
    expect(got).toEqual({
      name: "Dr. Example Person",
      title: null,
      college: null,
      department: null,
      email: null,
      research_interests: ["Soil water"],
      education: [],
      profile_url: "https://www.uaeu.ac.ae/en/profile/?email=example",
    });
  });
});
