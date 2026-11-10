import { describe, expect, it } from "vitest";
import { parseDeadlines, policySummary } from "../src/parsers/deadlines";
import { parseEvents } from "../src/parsers/events";
import { canonicalProfileUrl, facultyFromSearch } from "../src/parsers/faculty";
import eventsFixture from "./fixtures/uaeu/events.json";
import refundsFixture from "./fixtures/uaeu/refunds.json";
import searchFaculty from "./fixtures/tinyfish/search-faculty.json";

const events = eventsFixture.results[0]!;
const refunds = refundsFixture.results[0]!;

const NBSP = " ";
const DIRECTORY = "https://www.uaeu.ac.ae/en/catalog/uaeu-faculty-directory.shtml";

describe("parseEvents (recorded /en/events/ page)", () => {
  it("reads the five highlighted events with ISO dates and stops before video highlights", () => {
    const ev = parseEvents(events.text);
    expect(ev).toHaveLength(5);
    expect(ev[0]).toMatchObject({ date: "2026-02-28", title: "Emirati Day for Education" });
    expect(ev.map((e) => e.title)).not.toContain("Academic Carnival");
    expect(ev.map((e) => e.title)).not.toContain("Golden Jubilee");
  });

  it("keeps the page's order and each event's own date and title", () => {
    expect(parseEvents(events.text).map((e) => [e.date, e.title])).toEqual([
      ["2026-02-28", "Emirati Day for Education"],
      ["2026-03-02", 'Forum: "UAEU\'s Leadership in Higher Education - 50 Years of Excellence"'],
      ["2026-02-16", "UAEU's Session with The Great Arab Minds"],
      ["2026-02-09", 'International Conference: "Reimagining Translation and Literary Studies in the Era of Digital Human'],
      ["2026-01-26", "Graduate Students Graduation Ceremony"],
    ]);
  });

  it("has no url without the page's links, and takes each event's page from them in order when the counts agree", () => {
    expect(parseEvents(events.text).map((e) => e.url)).toEqual([null, null, null, null, null]);
    const withLinks = parseEvents(events.text, events.links);
    expect(withLinks.map((e) => e.url)).toEqual([
      "https://www.uaeu.ac.ae/en/events/emirati-day-for-education.shtml",
      "https://www.uaeu.ac.ae/en/events/forum-uaeu-leadership-in-higher-education-50-years-of-excellence.shtml",
      "https://www.uaeu.ac.ae/en/events/uaeu-session-with-the-great-arab-minds.shtml",
      "https://www.uaeu.ac.ae/en/events/translitdh.shtml",
      "https://www.uaeu.ac.ae/en/events/graduate-students-graduation-ceremony.shtml",
    ]);
    // The events page itself, its #fragments and other sections are not event pages.
    expect(withLinks.every((e) => /^https:\/\/www\.uaeu\.ac\.ae\/en\/events\/[^/]+\.shtml$/.test(e.url!))).toBe(true);
  });

  it("gives every url null when the number of event links is not the number of events", () => {
    const links = events.links.filter((l) => !l.endsWith("translitdh.shtml"));
    expect(parseEvents(events.text, links).map((e) => e.url)).toEqual([null, null, null, null, null]);
    expect(parseEvents(events.text, []).map((e) => e.url)).toEqual([null, null, null, null, null]);
  });

  it("does not take the events section's index page, or a repeated link, for an event's page", () => {
    const links = [
      "https://www.uaeu.ac.ae/en/events/index.shtml",
      ...events.links,
      events.links.find((l) => l.endsWith("translitdh.shtml"))!,
    ];
    expect(parseEvents(events.text, links).map((e) => e.url)).toEqual(parseEvents(events.text, events.links).map((e) => e.url));
    expect(parseEvents(events.text, links)[3]!.url).toBe("https://www.uaeu.ac.ae/en/events/translitdh.shtml");
  });

  it("reads a three-line date with non-breaking spaces, a one-line date, and a full month name", () => {
    const text = [
      "# EVENTS",
      "",
      "##",
      "",
      `05${NBSP}`,
      `Jan${NBSP}`,
      "2027",
      "",
      "###### New Year Open Day",
      "",
      "DISCOVER MORE",
      "",
      "7 March 2027",
      "",
      "###### One Line Date",
      "",
      "## Video Highlights",
      "",
      "###### Not an event",
    ].join("\n");
    expect(parseEvents(text)).toEqual([
      { date: "2027-01-05", title: "New Year Open Day", url: null },
      { date: "2027-03-07", title: "One Line Date", url: null },
    ]);
  });

  it("skips a date that is not a calendar day, and is tolerant of empty and unrelated text", () => {
    expect(parseEvents("31\nFeb\n2026\n\n###### Never\n")).toEqual([]);
    expect(parseEvents("")).toEqual([]);
    expect(parseEvents("Nothing to see here\n")).toEqual([]);
    expect(parseEvents(undefined as unknown as string)).toEqual([]);
    // A date with no title heading after it is not an event.
    expect(parseEvents("12\nMay\n2026\n\nDISCOVER MORE\n")).toEqual([]);
  });
});

describe("parseDeadlines (recorded withdrawal and refund page)", () => {
  const rows = parseDeadlines(refunds.text);

  it("reads the withdrawal table rows with refund percent and ISO dates", () => {
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows[0]).toMatchObject({ refund_percent: 100, start_date: "2026-08-24", end_date: "2026-09-18" });
    expect(rows[0]!.label).toContain("Course Withdrawal");
  });

  it("reads all seven tables, each labelled by its own system and period", () => {
    expect(rows.map((r) => [r.label, r.end_date])).toEqual([
      ["Courses Under the Full-Semester System: Course Withdrawal", "2026-09-18"],
      ["Courses Under the Monthly System: First Month: Course Withdrawal", "2026-08-30"],
      ["Courses Under the Monthly System: Second Month: Course Withdrawal", "2026-09-27"],
      ["Courses Under the Monthly System: Third Month: Course Withdrawal", "2026-10-25"],
      ["Courses Under the Monthly System: Fourth Month: Course Withdrawal", "2026-11-22"],
      ["Courses Under the Quarterly System: First Quarter: Course Withdrawal", "2026-09-06"],
      ["Courses Under the Quarterly System: Second Quarter: Course Withdrawal", "2026-11-01"],
    ]);
    expect(new Set(rows.map((r) => r.label)).size).toBe(7);
    expect(rows.every((r) => r.start_date === "2026-08-24" && r.refund_percent === 100)).toBe(true);
  });

  it("keeps the dates as the page writes them in date_or_rule", () => {
    expect(rows[0]!.date_or_rule).toBe("24 August 2026 to 18 September 2026");
    expect(rows[5]!.date_or_rule).toBe("24 August 2026 to 06 September 2026");
  });

  it("labels a table by the heading above it, and keeps the date text when a date does not parse", () => {
    const text = [
      "## Fees",
      "",
      "###### Graduate Courses",
      "",
      "| Status | Start Date | End Date | Payment Refund % | Payment Pledge % |",
      "| --- | --- | --- | --- | --- |",
      "| Course Withdrawal | Before the first class | 14 January 2027 | 50% | 50% |",
      "| University Withdrawal | 15 January 2027 | After the add/drop period | 0% | 100% |",
      "",
    ].join("\n");
    expect(parseDeadlines(text)).toEqual([
      {
        label: "Graduate Courses: Course Withdrawal",
        date_or_rule: "Before the first class to 14 January 2027",
        refund_percent: 50,
        start_date: null,
        end_date: "2027-01-14",
      },
      {
        label: "Graduate Courses: University Withdrawal",
        date_or_rule: "15 January 2027 to After the add/drop period",
        refund_percent: 0,
        start_date: "2027-01-15",
        end_date: null,
      },
    ]);
  });

  it("finds the columns by their names when the order changes, and gives a null refund when there is none", () => {
    const text = [
      "###### Summer",
      "| Status | End Date | Start Date |",
      "| --- | --- | --- |",
      "| Course Withdrawal | 2 July 2027 | 1 June 2027 |",
    ].join("\n");
    expect(parseDeadlines(text)).toEqual([
      {
        label: "Summer: Course Withdrawal",
        date_or_rule: "1 June 2027 to 2 July 2027",
        refund_percent: null,
        start_date: "2027-06-01",
        end_date: "2027-07-02",
      },
    ]);
  });

  it("is tolerant: no table, no text or a table without rows gives an empty list", () => {
    expect(parseDeadlines("")).toEqual([]);
    expect(parseDeadlines("Just a paragraph.\n")).toEqual([]);
    expect(parseDeadlines("| Status | Start Date | End Date |\n| --- | --- | --- |\n")).toEqual([]);
    expect(parseDeadlines(undefined as unknown as string)).toEqual([]);
  });
});

describe("policySummary", () => {
  it("is the first paragraph after the page title", () => {
    const s = policySummary(refunds.text);
    expect(s.startsWith("This page outlines the approved deadlines for withdrawal from the University")).toBe(true);
    expect(s.endsWith("United Arab Emirates University (UAEU).")).toBe(true);
    expect(s).not.toContain("Withdrawal or Registration Suspension Procedures");
  });

  it("joins the lines of a wrapped paragraph and is empty when there is none", () => {
    expect(policySummary("## Title\n\nFirst line\nsecond line.\n\nNext paragraph.\n")).toBe("First line second line.");
    expect(policySummary("## Title only\n")).toBe("");
    expect(policySummary("")).toBe("");
    expect(policySummary(undefined as unknown as string)).toBe("");
  });
});

describe("facultyFromSearch (recorded Search reply, placeholder names)", () => {
  const people = facultyFromSearch(searchFaculty.results);

  it("keeps only profile urls and maps the college", () => {
    expect(people).toHaveLength(5);
    expect(people.map((p) => p.profile_url)).not.toContain(DIRECTORY);
    expect(people[0]).toEqual({
      name: "Amal Example",
      title: "Dr.",
      college: "College of Medicine and Health Sciences",
      profile_url: "https://www.uaeu.ac.ae/en/cmhs/profile.shtml?email=a.example@uaeu.ac.ae",
    });
    expect(people.map((p) => p.college)).toEqual([
      "College of Medicine and Health Sciences",
      "College of Engineering",
      "College of Medicine and Health Sciences",
      "College of Humanities and Social Sciences",
      "College of Medicine and Health Sciences",
    ]);
  });

  it("strips a leading 'Faculty Profile - ' and a leading Dr. or Prof. into title", () => {
    expect(people.map((p) => [p.name, p.title])).toEqual([
      ["Amal Example", "Dr."],
      ["Basel Example", null],
      ["Chen Example", null],
      ["Dina Example", "Dr."],
      ["Eli Example", null],
    ]);
    const hit = (title: string) => ({ url: "https://www.uaeu.ac.ae/en/cit/profile.shtml?email=x.example@uaeu.ac.ae", title, snippet: "" });
    expect(facultyFromSearch([hit("Faculty Profile - Prof. Fatima Example")])[0]).toMatchObject({ name: "Fatima Example", title: "Prof." });
    expect(facultyFromSearch([hit("Prof. Dr. Gad Example")])[0]).toMatchObject({ name: "Gad Example", title: "Prof. Dr." });
    expect(facultyFromSearch([hit("")])[0]).toMatchObject({ name: "Faculty profile", title: null });
    // The live site also titles a profile "<name> - <college>"; the college is already its own field.
    expect(facultyFromSearch([hit("Hadi Example - College of Information Technology")])[0]).toMatchObject({
      name: "Hadi Example",
      title: null,
      college: "College of Information Technology",
    });
  });

  it("takes a profile address written without its domain, as some of the site's own links are", () => {
    const page = "https://www.uaeu.ac.ae/en/cos/profile.shtml?email=";
    expect(canonicalProfileUrl(`${page}A.Example`)).toBe(`${page}a.example`);
    expect(canonicalProfileUrl(`${page}a.example@uaeu.ac.ae`)).toBe(`${page}a.example@uaeu.ac.ae`);
    expect(canonicalProfileUrl(`${page}a.example@elsewhere.example`)).toBeNull();
    expect(canonicalProfileUrl(`${page}a example`)).toBeNull();
  });

  it("maps every college path segment, and keeps an unknown segment as it is", () => {
    const url = (seg: string) => `https://www.uaeu.ac.ae/en/${seg}/profile.shtml?email=p.example@uaeu.ac.ae`;
    const college = (seg: string) => facultyFromSearch([{ url: url(seg), title: "P Example", snippet: "" }])[0]!.college;
    expect(college("cmhs")).toBe("College of Medicine and Health Sciences");
    expect(college("eng")).toBe("College of Engineering");
    expect(college("chss")).toBe("College of Humanities and Social Sciences");
    expect(college("cit")).toBe("College of Information Technology");
    expect(college("cbe")).toBe("College of Business and Economics");
    expect(college("cos")).toBe("College of Science");
    expect(college("col")).toBe("College of Law");
    expect(college("cedu")).toBe("College of Education");
    expect(college("cavm")).toBe("College of Agriculture and Veterinary Medicine");
    expect(college("CMHS")).toBe("College of Medicine and Health Sciences");
    expect(college("newcollege")).toBe("newcollege");
  });

  it("drops pages that are not faculty profiles, other hosts, and repeats", () => {
    const p = "https://www.uaeu.ac.ae/en/cos/profile.shtml?email=q.example@uaeu.ac.ae";
    const hits = [
      { url: DIRECTORY, title: "UAEU Faculty Directory", snippet: "" },
      { url: "https://www.uaeu.ac.ae/en/cos/profile.shtml", title: "No email", snippet: "" },
      { url: "https://www.uaeu.ac.ae/en/cos/index.shtml?email=q.example@uaeu.ac.ae", title: "Not a profile", snippet: "" },
      { url: "https://evil.example/en/cos/profile.shtml?email=q.example@uaeu.ac.ae", title: "Other host", snippet: "" },
      { url: "not a url", title: "Broken", snippet: "" },
      { url: p, title: "Faculty Profile - Q Example", snippet: "" },
      { url: p, title: "Faculty Profile - Q Example", snippet: "again" },
    ];
    expect(facultyFromSearch(hits)).toEqual([
      { name: "Q Example", title: null, college: "College of Science", profile_url: p },
    ]);
    expect(facultyFromSearch([])).toEqual([]);
    expect(facultyFromSearch(undefined as unknown as [])).toEqual([]);
  });
});
