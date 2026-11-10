// Every tool Falaj serves, in listing order. Later tasks append here.
import { academicDeadlines } from "./academic-deadlines";
import { findFaculty } from "./find-faculty";
import { getAcademicCalendar } from "./get-academic-calendar";
import { getCourse } from "./get-course";
import { getFacultyProfile } from "./get-faculty-profile";
import { getProgram } from "./get-program";
import { healthCheck } from "./health-check";
import { listEvents } from "./list-events";
import { listPrograms } from "./list-programs";
import { searchCourses } from "./search-courses";
import type { ToolDef } from "./types";

export const TOOLS: readonly ToolDef<any, any>[] = [
  healthCheck,
  searchCourses,
  getCourse,
  listPrograms,
  getProgram,
  listEvents,
  academicDeadlines,
  findFaculty,
  getFacultyProfile,
  getAcademicCalendar,
];

export function toolByName(name: string): ToolDef<any, any> | undefined {
  return TOOLS.find((tool) => tool.name === name);
}
