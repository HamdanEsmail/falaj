import { describe, expect, it } from "vitest";
import { ARGS_ABBREV_CHARS } from "../src/core/limits";
import { abbrev, hashKey, maskEmails, slugToName } from "../src/core/text";
import { parseCatalogue } from "../src/parsers/catalogue";
import { parseCoursePage } from "../src/parsers/course";
import {
  COLLEGE_BY_ABBREV,
  NON_PROGRAMME_SLUGS,
  parseProgramIndex,
  parseProgramPage,
  programKind,
} from "../src/parsers/program";
import catalogueFixture from "./fixtures/uaeu/catalogue-index.json";
import hsrFixture from "./fixtures/uaeu/course-hsr140.json";
import aeroFixture from "./fixtures/uaeu/course-aero485.json";
import mdsFixture from "./fixtures/uaeu/program-mds.json";
import microFixture from "./fixtures/uaeu/program-microcredential.json";
import minorFixture from "./fixtures/uaeu/program-minor.json";
import programsIndexFixture from "./fixtures/uaeu/programs-index.json";

const cat = catalogueFixture.results[0]!;
const hsr = hsrFixture.results[0]!;
const mds = mdsFixture.results[0]!;
const minor = minorFixture.results[0]!;
const micro = microFixture.results[0]!;
const aero = aeroFixture.results[0]!;
const idx = programsIndexFixture.results[0]!;

const COURSE_LINK = /\/en\/catalog\/courses\/course_\d+\.shtml\?id=([A-Z0-9]+)\s*$/;

describe("parseCatalogue (recorded catalogue index)", () => {
  it("finds every college and 2,700+ courses, keyed by code from the link's id param", () => {
    const { colleges, courseMap } = parseCatalogue(cat.text, cat.links);
    expect(colleges.map((c) => c.college)).toContain("College of Business and Economics");
    expect(colleges.flatMap((c) => c.courses).length).toBeGreaterThan(2700);
    expect(courseMap.get("HSR140")).toMatch(/course_\d+\.shtml\?id=HSR140$/);
    expect(colleges.flatMap((c) => c.courses).find((c) => c.code === "ENGL601")?.title).toBe(
      "Storytelling in the World",
    );
  });

  it("groups the nine colleges plus General Education, 2,787 courses in all", () => {
    const { colleges } = parseCatalogue(cat.text, cat.links);
    expect(colleges.map((c) => c.college)).toEqual([
      "College of Business and Economics",
      "College of Education",
      "College of Engineering",
      "College of Agriculture and Veterinary Medicine",
      "College of Humanities and Social Sciences",
      "College of Information Technology",
      "College of Law",
      "College of Medicine and Health Sciences",
      "College of Science",
      "General Education",
    ]);
    expect(colleges.flatMap((c) => c.courses)).toHaveLength(2787);
    expect(colleges.find((c) => c.college === "General Education")!.courses.map((c) => c.code)).toEqual([
      "HSR140",
      "HSR150",
    ]);
  });

  it("reads the first item of a list (`* + CODE`) as well as the rest, and ignores department sub-headings", () => {
    const { colleges } = parseCatalogue(cat.text, cat.links);
    const business = colleges[0]!.courses.map((c) => c.code);
    expect(business[0]).toBe("ECON105");
    expect(business).toContain("BANA200");
    expect(business.every((code) => /^[A-Z]{2,5}\d{3,4}[A-Z]?$/.test(code))).toBe(true);
  });

  it("keys courseMap by the id param, so every course has a url and every key is a valid code", () => {
    const { colleges, courseMap } = parseCatalogue(cat.text, cat.links);
    const courses = colleges.flatMap((c) => c.courses);
    expect(courseMap.size).toBe(2787);
    for (const key of courseMap.keys()) expect(key).toMatch(/^[A-Z]{2,5}\d{3,4}[A-Z]?$/);
    expect(courses.filter((c) => c.url === null)).toHaveLength(0);
    for (const c of courses) expect(c.url).toBe(courseMap.get(c.code));
  });

  it("trims the four recorded links whose id carries a trailing space (AERO485, SWEB698, PHYS501, PHYS502)", () => {
    const raw = cat.links.filter((l) => /\?id=[A-Z0-9]+ $/.test(l));
    expect(raw).toHaveLength(4);
    const { courseMap } = parseCatalogue(cat.text, cat.links);
    for (const code of ["AERO485", "SWEB698", "PHYS501", "PHYS502"]) {
      expect(courseMap.get(code)).toMatch(new RegExp(`course_\\d+\\.shtml\\?id=${code}$`));
    }
  });

  it("never keys by link text, rejects ids outside the code class, and gives unlinked courses url null", () => {
    const text = "## College of Science\n\n* + MATH105 : Calculus I\n  + MATH110 : Calculus II\n";
    const links = [
      "https://www.uaeu.ac.ae/en/catalog/courses/course_2957.shtml?id=MATH105",
      "https://www.uaeu.ac.ae/en/catalog/courses/course_2957.shtml?id=not a code",
      "https://www.uaeu.ac.ae/en/catalog/courses/course_2957.shtml?id=math999",
      "https://www.uaeu.ac.ae/en/catalog/courses/?id=MATH110",
      "https://www.uaeu.ac.ae/en/catalog/courses/MATH110",
    ];
    const { colleges, courseMap } = parseCatalogue(text, links);
    expect([...courseMap.keys()]).toEqual(["MATH105"]);
    expect(colleges[0]!.courses).toEqual([
      { code: "MATH105", title: "Calculus I", url: links[0] },
      { code: "MATH110", title: "Calculus II", url: null },
    ]);
  });

  it("is tolerant: empty or unrecognisable input gives empty results, never a throw", () => {
    expect(parseCatalogue("", [])).toEqual({ colleges: [], courseMap: new Map() });
    expect(parseCatalogue("# Courses\n\nnothing to see\n", ["", "not a url"]).colleges).toEqual([]);
  });
});

describe("parseCoursePage (recorded HSR140 page, which also carries HSR150)", () => {
  it("returns only the requested course when the page carries the next one too", () => {
    const c = parseCoursePage(hsr.text, "HSR140")!;
    expect(c.title).toBe("Introduction to Society & Behavior");
    expect(c.credit_hours).toBe(3);
    expect(c.learning_outcomes).toHaveLength(4);
    expect(c.description).not.toContain("Geography"); // that sentence belongs to HSR150
    expect(parseCoursePage(hsr.text, "HSR150")!.learning_outcomes).toHaveLength(5);
    expect(parseCoursePage(hsr.text, "HSR999")).toBeNull();
  });

  it("keeps each course's own description, outcomes and credit hours apart", () => {
    const a = parseCoursePage(hsr.text, "HSR140")!;
    const b = parseCoursePage(hsr.text, "HSR150")!;
    expect(a.description.startsWith("This course covers the basic concepts and purposes of Psychology")).toBe(true);
    expect(a.learning_outcomes[0]).toBe("Choose one discipline from the four disciplines");
    expect(a.learning_outcomes.join(" ")).not.toContain("political science");
    expect(b.title).toBe("Introduction to Government Policy & Urban Structures");
    expect(b.description.startsWith("This interdisciplinary course combines")).toBe(true);
    expect(b.description).toContain("Geography");
    expect(b.credit_hours).toBe(3);
    // the last course on the page stops at the Arabic notice, not at the end of the text
    expect(b.learning_outcomes.at(-1)).toBe(
      "Determine problems, challenges and solutions related to political science, geography and urban planning",
    );
    expect(b.learning_outcomes.join(" ")).not.toContain("عفوا");
    expect(a.prerequisites).toEqual([]);
  });

  it("matches the code case-insensitively and returns it upper-case", () => {
    const c = parseCoursePage(hsr.text, "hsr150")!;
    expect(c.code).toBe("HSR150");
    expect(c.title).toBe("Introduction to Government Policy & Urban Structures");
  });

  it("reads a Prerequisite or Pre-requisite line when present (synthetic page)", () => {
    const page = [
      "# Calculus II (MATH110)",
      "",
      "Integration and series.",
      "",
      "Prerequisite : MATH105, STAT101",
      "",
      "### Credit Hours : 4",
      "",
      "### Course Learning Outcomes",
      "",
      "1. Integrate",
      "2. Sum series",
      "",
      "# Calculus III (MATH210)",
      "",
      "Pre-requisite: MATH110",
    ].join("\n");
    const c = parseCoursePage(page, "MATH110")!;
    expect(c.prerequisites).toEqual(["MATH105", "STAT101"]);
    expect(c.description).toBe("Integration and series.");
    expect(c.credit_hours).toBe(4);
    expect(c.learning_outcomes).toEqual(["Integrate", "Sum series"]);
    expect(parseCoursePage(page, "MATH210")!.prerequisites).toEqual(["MATH110"]);
  });

  it("tolerates whitespace inside the parentheses of the heading (AERO485, SWEB698, PHYS501, PHYS502 carry a trailing space on the site)", () => {
    const page = [
      "# Aerospace Project ( AERO485 )",
      "",
      "A capstone.",
      "",
      "### Credit Hours : 3",
      "",
      "# Another Course (AERO486 )",
      "",
      "Next.",
    ].join("\n");
    const c = parseCoursePage(page, "AERO485")!;
    expect(c).toMatchObject({ code: "AERO485", title: "Aerospace Project", description: "A capstone.", credit_hours: 3 });
    expect(parseCoursePage(page, "aero486")).toMatchObject({ code: "AERO486", title: "Another Course", description: "Next." });
    expect(parseCoursePage("# Plain Course (PHYS501)\n", "PHYS501")!.title).toBe("Plain Course");
  });

  it("is tolerant: a bare heading gives an empty description, no outcomes and null credit hours", () => {
    expect(parseCoursePage("# Seminar (SEM101)\n", "SEM101")).toEqual({
      code: "SEM101",
      title: "Seminar",
      description: "",
      credit_hours: null,
      learning_outcomes: [],
      prerequisites: [],
    });
    expect(parseCoursePage("", "SEM101")).toBeNull();
    expect(parseCoursePage(hsr.text, "")).toBeNull();
  });
});

describe("parseCoursePage (recorded AERO485 page: a department page with 100+ courses, AERO485's id has a trailing space)", () => {
  it("reads AERO485 from its heading `# Internship I (AERO485 )`: title, 1 credit hour, 3 outcomes, 7 prerequisites", () => {
    const c = parseCoursePage(aero.text, "AERO485")!;
    expect(c.code).toBe("AERO485");
    expect(c.title).toBe("Internship I");
    expect(c.credit_hours).toBe(1);
    expect(c.description.startsWith("Students spend 8 weeks on a full-time basis")).toBe(true);
    expect(c.learning_outcomes).toHaveLength(3);
    expect(c.learning_outcomes[0]).toContain("Function effectively in multi-disciplinary teams");
    expect(c.prerequisites).toHaveLength(7);
    expect(c.prerequisites[0]).toBe("CIVL240 with a minimum grade D");
    // The last prerequisite is one parenthesised "or" line; it is kept whole, not split into five.
    const last = c.prerequisites.at(-1)!;
    expect(last.startsWith("(MECH305 with a minimum grade D or MECH310")).toBe(true);
    expect(last.endsWith("or MECH315 with a minimum grade D)")).toBe(true);
  });

  it("stops at the next course's heading: AERO490 and AERO485 do not mix", () => {
    const a = parseCoursePage(aero.text, "AERO485")!;
    const b = parseCoursePage(aero.text, "AERO490")!;
    expect(b.title).toBe("Internship II");
    expect(a.description).not.toContain("correlate their academic preparation");
    expect(a.learning_outcomes.join(" ")).not.toBe(b.learning_outcomes.join(" "));
  });
});

describe("programme parsers (recorded index and Mathematics of Data Science page)", () => {
  it("parseProgramIndex returns the 75 programme links (76 slug links minus general-education-requirements), in page order", () => {
    const slugLinks = [
      ...new Set(idx.links.filter((l) => /\/en\/catalog\/undergraduate\/programs\/[^/?#]+\.shtml$/.test(l))),
    ];
    expect(slugLinks).toHaveLength(76);
    expect(NON_PROGRAMME_SLUGS).toEqual(["general-education-requirements"]);

    const links = parseProgramIndex(idx.links);
    expect(links).toHaveLength(75);
    expect(links.some((l) => l.includes("general-education-requirements"))).toBe(false);
    // page order: the recorded slug links with the one non-programme page removed
    expect(links).toEqual(slugLinks.filter((l) => !l.includes("general-education-requirements")));
    expect(links[0]).toBe("https://www.uaeu.ac.ae/en/catalog/undergraduate/programs/bachelor-of-economics.shtml");
    expect(new Set(links).size).toBe(75);
  });

  it("parseProgramIndex drops the index itself, anchors and odd paths, and de-duplicates", () => {
    const base = "https://www.uaeu.ac.ae/en/catalog/undergraduate/programs/";
    const links = parseProgramIndex([
      base,
      `${base}#!`,
      `${base}#1`,
      "https://www.uaeu.ac.ae/en/catalog/undergraduate/programs",
      `${base}en/university-leadership/`,
      `${base}bachelor-of-law.shtml`,
      `${base}bachelor-of-law.shtml#1`,
      `${base}bachelor-of-law.shtml`,
      `${base}general-education-requirements.shtml`,
      `  ${base}minor-in-law.shtml  `,
      "https://www.uaeu.ac.ae/en/catalog/graduate/programs/master-of-law.shtml",
      "",
    ]);
    expect(links).toEqual([`${base}bachelor-of-law.shtml`, `${base}minor-in-law.shtml`]);
  });

  it("parseProgramPage reads name, college from the hosting sentence, credit hours and the full degree plan", () => {
    const p = parseProgramPage(mds.text);
    expect(p.name).toBe("Bachelor of Science in the Mathematics of Data Science");
    expect(p.college).toBe("College of Science");
    expect(p.credit_hours).toBe(120);
    expect(p.degree_plan.length).toBeGreaterThanOrEqual(80);
    expect(p.objectives.length).toBeGreaterThanOrEqual(4);
  });

  it("parseProgramPage's degree plan is exactly the page's 88 course links, with titles and credit hours", () => {
    const p = parseProgramPage(mds.text);
    const linked = mds.links.map((l) => l.match(COURSE_LINK)?.[1]).filter((c): c is string => c !== undefined);
    expect(linked).toHaveLength(88);
    expect(p.degree_plan.map((c) => c.code)).toEqual(linked);
    expect(p.degree_plan[0]).toEqual({ code: "GEEM110", title: "Contemporary Emirati Studies", credit_hours: 3 });
    expect(p.degree_plan.find((c) => c.code === "MATH501")).toEqual({
      code: "MATH501",
      title: "Internship (Mathematical Analytics) 1",
      credit_hours: 6,
    });
    expect(p.degree_plan.at(-1)).toEqual({ code: "STAT380", title: "Statistical Machine Learning", credit_hours: 3 });
  });

  it("parseProgramPage reads the five objectives and a description that stops before them", () => {
    const p = parseProgramPage(mds.text);
    expect(p.objectives).toHaveLength(5);
    expect(p.objectives[0]!.startsWith("Contribute to the growth of a UAE task force")).toBe(true);
    expect(p.description.startsWith("Critical sectors of the economy")).toBe(true);
    expect(p.description).toContain("hosted by the Department of Mathematical Sciences, COS");
    expect(p.description).not.toContain("Program Objectives");
    expect(p.description).not.toContain("Contribute to the growth");
  });

  // The recorded minor and micro-credential pages (2026-11-03). Both open at "## <name>" and carry the
  // same sections as a bachelor page, except that neither has a "hosted by" sentence (college is null)
  // and the micro-credential has no "# Undergraduate Programs" line above its name.
  it("parseProgramPage reads the recorded minor: name, kind, 18 credit hours, 4 objectives, 9 plan courses, no college", () => {
    const p = parseProgramPage(minor.text);
    expect(p.name).toBe("Minor in Statistics and Data Analytics");
    expect(programKind(p.name)).toBe("minor");
    expect(p.credit_hours).toBe(18);
    expect(p.college).toBeNull();
    expect(p.description.startsWith("This Minor in Statistics and Data Analytics aims to provide")).toBe(true);
    expect(p.description).not.toContain("Admission Requirements");
    expect(p.objectives).toHaveLength(4);
    expect(p.objectives[0]).toContain("basic and inferential statistical methods");
    expect(p.degree_plan.map((c) => c.code)).toEqual([
      "STAT230", "STAT240", "STAT360", "BANA200", "BANA250", "STAT330", "STAT380", "STAT400", "STAT430",
    ]);
    expect(p.degree_plan[0]).toEqual({ code: "STAT230", title: "Principles of Probability", credit_hours: 3 });
  });

  it("parseProgramPage reads the recorded micro-credential: name, kind, 6 credit hours, 4 objectives, 2 plan courses, no college", () => {
    const p = parseProgramPage(micro.text);
    expect(p.name).toBe("Credit-Bearing Micro-Credential in Accounting Foundations");
    expect(programKind(p.name)).toBe("micro_credential");
    expect(p.credit_hours).toBe(6);
    expect(p.college).toBeNull();
    expect(p.description.startsWith("The CBMC in Accounting Foundations is a 6-credit")).toBe(true);
    expect(p.objectives).toHaveLength(4);
    expect(p.objectives[0]).toContain("foundational financial and managerial accounting");
    // The table's header has two cells and its rows three; the rows still read.
    expect(p.degree_plan).toEqual([
      { code: "ACCT101", title: "Principles of Financial Accounting-CBMC", credit_hours: 3 },
      { code: "ACCT103", title: "Fundamental of Cost and Managerial Accounting-CBMC", credit_hours: 3 },
    ]);
  });

  it("the page name and the name made from the URL slug give the same kind on the minor and the micro-credential", () => {
    expect(programKind(slugToName("minor-in--statistics-and-data-analytics"))).toBe("minor");
    expect(programKind(slugToName("creditbearing-microcredential-in-accounting-foundations"))).toBe("micro_credential");
  });

  it("maps every college abbreviation to its full name", () => {
    expect(COLLEGE_BY_ABBREV).toEqual({
      COS: "College of Science",
      CIT: "College of Information Technology",
      CBE: "College of Business and Economics",
      CHSS: "College of Humanities and Social Sciences",
      CEDU: "College of Education",
      COE: "College of Engineering",
      CAVM: "College of Agriculture and Veterinary Medicine",
      CMHS: "College of Medicine and Health Sciences",
      COL: "College of Law",
    });
  });

  it("parseProgramPage names the college from an abbreviation, from words, or not at all (synthetic pages)", () => {
    const page = (sentence: string) => `## Bachelor of Law\n\nAbout the programme. ${sentence} More text.\n`;
    expect(parseProgramPage(page("It is hosted by the Department of Public Law, COL.")).college).toBe("College of Law");
    expect(parseProgramPage(page("It is hosted by the Department of Food Science, CAVM.")).college).toBe(
      "College of Agriculture and Veterinary Medicine",
    );
    expect(
      parseProgramPage(page("It is hosted by the Department of Marketing, College of Business and Economics.")).college,
    ).toBe("College of Business and Economics");
    expect(parseProgramPage(page("It is hosted by the College of Education.")).college).toBe("College of Education");
    expect(parseProgramPage(page("It is hosted by the Department of Something, XYZ.")).college).toBeNull();
    expect(parseProgramPage(page("")).college).toBeNull();
  });

  it("parseProgramPage is tolerant: missing sections give empty arrays or null, never a throw", () => {
    expect(parseProgramPage("")).toEqual({
      name: "",
      college: null,
      credit_hours: null,
      description: "",
      objectives: [],
      degree_plan: [],
    });
    const p = parseProgramPage("## Minor in Law\n\nA short minor.\n");
    expect(p).toMatchObject({ name: "Minor in Law", description: "A short minor.", objectives: [], degree_plan: [] });
  });
});

describe("programKind", () => {
  it("reads the kind from the name prefix, for all five kinds", () => {
    expect(programKind("Bachelor of Science in the Mathematics of Data Science")).toBe("bachelor");
    expect(programKind("Bachelor of Veterinary Medicine")).toBe("bachelor");
    expect(programKind("Doctor of Medicine")).toBe("doctorate");
    expect(programKind("PhD in Chemistry")).toBe("doctorate");
    expect(programKind("Minor in Statistics and Data Analytics")).toBe("minor");
    expect(programKind("Credit-bearing Micro-credential in Accounting Foundations")).toBe("micro_credential");
    expect(programKind("Master of Science in Physics")).toBe("other");
    expect(programKind("Study Abroad")).toBe("other");
    expect(programKind("")).toBe("other");
  });

  it("gives the same answer for a page name and for the name made from the URL slug (hyphens, spaces and case)", () => {
    expect(programKind(slugToName("creditbearing-microcredential-in-ai-in-gaming"))).toBe("micro_credential");
    expect(slugToName("creditbearing-microcredential-in-ai-in-gaming")).toBe("Creditbearing Microcredential in Ai in Gaming");
    expect(programKind(slugToName("minor-in--artificial-intelligence"))).toBe("minor");
    expect(programKind(slugToName("minor-of-microwave-engineering"))).toBe("minor");
    expect(programKind(slugToName("doctor-of-medicine"))).toBe("doctorate");
    expect(programKind(slugToName("bachelor-of-science-in-computer-science"))).toBe("bachelor");
    expect(programKind("  BACHELOR   of-Arts in Geography ")).toBe("bachelor");
    expect(programKind("Doctoral Studies Office")).toBe("other");
  });

  it("classes the 75 programmes of the recorded index as 54 bachelor, 1 doctorate, 12 minor and 8 micro-credential", () => {
    const counts: Record<string, number> = {};
    for (const url of parseProgramIndex(idx.links)) {
      const kind = programKind(slugToName(/\/([^/]+)\.shtml$/.exec(url)![1]!));
      counts[kind] = (counts[kind] ?? 0) + 1;
    }
    expect(counts).toEqual({ bachelor: 54, doctorate: 1, minor: 12, micro_credential: 8 });
  });
});

describe("text helpers", () => {
  it("slugToName handles the double hyphen", () => {
    expect(slugToName("bachelor-of-science-in--the-mathematics-of-data-science")).toBe(
      "Bachelor of Science in the Mathematics of Data Science",
    );
  });

  it("slugToName title-cases, keeps of/in/the/and lower except the first word, and tolerates empty input", () => {
    expect(slugToName("minor-in-law")).toBe("Minor in Law");
    expect(slugToName("the-art-and-science-of-food")).toBe("The Art and Science of Food");
    expect(slugToName("creditbearing-microcredential-in-renewable-energy-technologies")).toBe(
      "Creditbearing Microcredential in Renewable Energy Technologies",
    );
    expect(slugToName("")).toBe("");
  });

  it("maskEmails masks the local part only", () => {
    expect(maskEmails("profile.shtml?email=a.example@uaeu.ac.ae")).toBe("profile.shtml?email=***@uaeu.ac.ae");
  });

  it("maskEmails masks an address whose @ is written %40, as a URL carries it", () => {
    expect(maskEmails("profile.shtml?email=a.example%40uaeu.ac.ae")).toBe("profile.shtml?email=***@uaeu.ac.ae");
    expect(maskEmails('{"profile_url":"https://www.uaeu.ac.ae/en/cmhs/profile.shtml?email=A.Example%40UAEU.ac.ae"}')).toBe(
      '{"profile_url":"https://www.uaeu.ac.ae/en/cmhs/profile.shtml?email=***@UAEU.ac.ae"}',
    );
    // A %40 with no domain after it is not an address.
    expect(maskEmails("discount%40 off")).toBe("discount%40 off");
    const long = `${"x".repeat(50_000)}%40`;
    expect(maskEmails(long)).toBe(long);
  });

  it("maskEmails masks who a profile address is for when the site's link leaves the domain off", () => {
    expect(maskEmails('{"profile_url":"https://www.uaeu.ac.ae/en/cos/profile.shtml?email=a.example"}')).toBe(
      '{"profile_url":"https://www.uaeu.ac.ae/en/cos/profile.shtml?email=***"}',
    );
    expect(maskEmails("profile.shtml?lang=en&email=A.Example&x=1")).toBe("profile.shtml?lang=en&email=***&x=1");
    // A full address is masked once, by the first rule, and keeps its domain.
    expect(maskEmails("profile.shtml?email=a.example@uaeu.ac.ae")).toBe("profile.shtml?email=***@uaeu.ac.ae");
    // Words that only end in "email=" are left alone.
    expect(maskEmails("no email= here")).toBe("no email= here");
    const long = `?email=${"x".repeat(50_000)}`;
    expect(maskEmails(long).length).toBeLessThanOrEqual(long.length);
  });

  it("maskEmails masks every address and leaves text without one alone", () => {
    expect(maskEmails('{"a":"a.example@uaeu.ac.ae","b":"b_example+x@mail.uaeu.ac.ae"}')).toBe(
      '{"a":"***@uaeu.ac.ae","b":"***@mail.uaeu.ac.ae"}',
    );
    expect(maskEmails("no address here, just @handle and 5 > 3")).toBe("no address here, just @handle and 5 > 3");
  });

  it("maskEmails masks a long local part in full and only the address inside a long run of text", () => {
    expect(maskEmails(`${"l".repeat(100)}@uaeu.ac.ae`)).toBe("***@uaeu.ac.ae");
    expect(maskEmails(`${"x".repeat(50_000)} a.example@uaeu.ac.ae`)).toBe(`${"x".repeat(50_000)} ***@uaeu.ac.ae`);
  });

  // The Workers test clock is frozen while code runs (performance.now() and Date.now() read 0
  // across a CPU-bound call), so the elapsed check below only bites on a runtime with a live
  // clock. The shapes are what matter: an unbounded-prefix pattern took 5 to 26 seconds on each
  // of them in Node, and a quadratic regression would make this test visibly crawl.
  it("maskEmails returns long input without an address unchanged, and quickly (linear time)", () => {
    const n = 100_000;
    const shapes = [
      "a".repeat(n), //                      one long run of address-like characters, no @
      "a.".repeat(n / 2), //                 dotted run
      "%".repeat(n), //                      run of a legal local-part punctuation character
      `${"a".repeat(n)}@${"b".repeat(n)}`, // long local part, long domain, no dot, so no address
      `a@${"b.".repeat(n / 2)}`, //          domain-like run that never ends in a top-level domain
      "a@".repeat(n / 2), //                 many @ with nothing after them
    ];
    for (const s of shapes) {
      const start = performance.now();
      expect(maskEmails(s)).toBe(s);
      expect(performance.now() - start).toBeLessThan(200);
    }
  });

  it("abbrev leaves short strings alone and cuts long ones to the limit", () => {
    expect(abbrev("short")).toBe("short");
    expect(abbrev("x".repeat(ARGS_ABBREV_CHARS))).toBe("x".repeat(ARGS_ABBREV_CHARS));
    const long = abbrev("y".repeat(500));
    expect(long).toHaveLength(ARGS_ABBREV_CHARS);
    expect(long.endsWith("…")).toBe(true);
    expect(abbrev("abcdefghij", 5)).toBe("abcd…");
  });

  it("hashKey is SHA-256 hex cut to 16 characters", async () => {
    expect(await hashKey("abc")).toBe("ba7816bf8f01cfea");
    expect(await hashKey("")).toBe("e3b0c44298fc1c14");
    expect(await hashKey("203.0.113.9")).toMatch(/^[0-9a-f]{16}$/);
    expect(await hashKey("203.0.113.9")).not.toBe(await hashKey("203.0.113.10"));
  });
});
