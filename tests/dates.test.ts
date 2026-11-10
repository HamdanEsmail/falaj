import { describe, expect, it } from "vitest";
import {
  currentAcademicYear,
  daysBetween,
  isAcademicYear,
  nextAcademicYear,
  resolveCalendarDate,
} from "../src/core/dates";
import { normalizeCalendar } from "../src/parsers/calendar";

describe("currentAcademicYear", () => {
  it("currentAcademicYear flips in August", () => {
    expect(currentAcademicYear(new Date("2026-11-03"))).toBe("2026-2027");
    expect(currentAcademicYear(new Date("2026-07-31"))).toBe("2025-2026");
  });
});

describe("resolveCalendarDate", () => {
  it("resolveCalendarDate picks the year from the tab", () => {
    expect(resolveCalendarDate("17 Aug", "2026-2027")).toBe("2026-08-17");
    expect(resolveCalendarDate("05 Jan", "2026-2027")).toBe("2027-01-05");
    expect(resolveCalendarDate("TBA", "2026-2027")).toBeNull();
  });

  it("a Summer row takes the tab's second year in every month, August included", () => {
    expect(resolveCalendarDate("06 Aug", "2025-2026", "Summer Semester 2026")).toBe("2026-08-06");
    expect(resolveCalendarDate("14 Jun", "2025-2026", "Summer")).toBe("2026-06-14");
    // The same text under a Fall heading, or with no heading, keeps the month rule.
    expect(resolveCalendarDate("06 Aug", "2025-2026", "Fall Semester")).toBe("2025-08-06");
    expect(resolveCalendarDate("06 Aug", "2025-2026")).toBe("2025-08-06");
  });

  it.each([
    ["15-22 Dec", "2026-12-15"],
    ["15 - 22 Dec", "2026-12-15"],
    ["15 – 22 Dec", "2026-12-15"],
    ["15 Dec - 22 Dec", "2026-12-15"],
    ["28 Dec - 02 Jan", "2026-12-28"],
    ["Sunday, 17 Aug", "2026-08-17"],
    ["Sun 17 Aug", "2026-08-17"],
    ["Aug 17", "2026-08-17"],
    ["August 17", "2026-08-17"],
    ["17 August", "2026-08-17"],
    ["Sunday, 17 Aug - Thursday, 21 Aug", "2026-08-17"],
  ])("reads the start day of %j", (text, iso) => {
    expect(resolveCalendarDate(text, "2026-2027")).toBe(iso);
  });

  it.each(["TBA", "To be announced", "31 Feb", "Aug", "17", "17 Foo", "", "   ", "17 Aug or 18 Aug"])("makes no date of %j", (text) => {
    expect(resolveCalendarDate(text, "2026-2027")).toBeNull();
  });

  it("the calendar's Summer rows are dated in the tab's second year, and a range keeps its own words", () => {
    const out = normalizeCalendar(
      {
        academic_year: "2025-2026",
        semesters: [
          { name: "Summer Semester", items: [{ date: "06 Aug", title: "Final examinations" }, { date: "15-22 Jun", title: "Registration" }] },
        ],
      },
      "2025-2026",
    );
    expect(out?.semesters[0]?.items).toEqual([
      { date: "2026-08-06", date_text: "06 Aug", title: "Final examinations" },
      { date: "2026-06-15", date_text: "15-22 Jun", title: "Registration" },
    ]);
    expect(out?.dropped).toBe(0);
  });
});

describe("academic year helpers", () => {
  it("isAcademicYear accepts consecutive years only", () => {
    expect(isAcademicYear("2026-2027")).toBe(true);
    expect(isAcademicYear("2026-2028")).toBe(false);
    expect(isAcademicYear("2026")).toBe(false);
  });

  it("nextAcademicYear advances both ends", () => {
    expect(nextAcademicYear("2026-2027")).toBe("2027-2028");
  });

  it("daysBetween is signed whole days from a to b", () => {
    expect(daysBetween(new Date("2026-11-01T00:00:00Z"), new Date("2026-11-16T00:00:00Z"))).toBe(15);
  });
});
