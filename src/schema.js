import { z } from 'zod';
import { DateTime } from 'luxon';
// Sub schemas are factories, not shared instances: the MCP SDK converts a tool shape with
// zod-to-json-schema, whose default $refStrategy reuses a repeated schema instance as a
// "$ref". Strict clients (Gemini) refuse a tools payload containing one, so every use below
// builds its own instance and the generated JSON Schema stays flat.
export const date = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => DateTime.fromISO(v).isValid, 'Invalid date');
export const time = () => z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const instant = () => z.string().refine(v => /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(v) && DateTime.fromISO(v).isValid, 'Use ISO datetime with timezone offset');
const id = () => z.string().min(1).max(160);
const period = () => z.object({ number: z.number().int().positive(), start: time(), end: time() }).strict();
const timetableName = () => z.string().min(1).max(80).describe('Exact timetable name, e.g. summer or winter');
const common = () => ({
  id: id().optional(), title: z.string().min(1).max(300), enabled: z.boolean().default(true),
  aliases: z.array(z.string()).max(30).default([]).describe('Alternative names for searching, e.g. ["C加加", "cpp"]'),
  tags: z.array(z.string()).max(30).default([]), notes: z.string().max(10000).default(''),
  metadata: z.record(z.string(), z.unknown()).default({}),
  source: z.object({ namespace: id(), key: id() }).strict().optional(),
});
export const rule = z.object({
  weekday: z.number().int().min(1).max(7), weeks: z.array(z.number().int().min(1).max(60)).min(1).max(60),
  start: time().optional(), end: time().optional(), periods: z.array(z.number().int().positive()).min(1).max(30).optional(),
  location: z.string().optional(),
}).strict().refine(v => v.periods ? !v.start && !v.end : v.start && v.end && v.start < v.end, 'Use periods OR start/end (same day)');
export const term = z.object({
  ...common(), kind: z.literal('term'), startDate: date(), endDate: date(),
  weekOne: date().describe('Monday of teaching week 1'), timezone: z.string().default('Asia/Shanghai').refine(v => DateTime.now().setZone(v).isValid),
  periods: z.array(period()).default([]).describe('Default timetable before the first switch, or when switching to null'),
  timetables: z.array(z.object({ name: timetableName(), periods: z.array(period()).min(1).max(60) }).strict()).max(30).default([]),
  timetableSwitches: z.array(z.object({ effectiveFrom: date(), timetable: timetableName().nullable() }).strict()).max(420).default([])
    .describe('Effective from local midnight, inclusive, until next switch; null selects term.periods'),
  calendar: z.record(date(), date().nullable()).default({}).describe('Actual date -> teaching date; null means no courses'),
}).strict();
export const course = z.object({
  ...common(), kind: z.literal('course'), termId: id(), teacher: z.string().default(''), location: z.string().default(''),
  courseCode: z.string().optional().describe('Course code or group name to link multiple teaching classes of the same course'),
  teachingClass: z.string().optional().describe('Identifier for the specific teaching class, e.g. "教学班1"'),
  category: z.enum(['academic','activity']).optional().describe('academic by default; activity is a personal recurring meeting, excluded from academic summary'),
  scheduleStatus: z.enum(['scheduled','partial','tbd','unknown']).optional().describe('Omitted: rules present => scheduled, empty => unknown. tbd only if source confirms undecided time; partial means some sessions are missing'),
  scheduleSource: z.object({ type: z.enum(['official','personal','unknown']), reference: z.string().max(2000).optional() }).strict().optional(),
  expectedTiming: z.object({ startWeek: z.number().int().min(1).max(60).optional(), endWeek: z.number().int().min(1).max(60).optional(),
    date: date().optional(), durationWeeks: z.number().int().min(1).max(60).optional(),
    window: z.object({ from: date(), to: date(), label: z.string().max(120).optional() }).strict().optional()
      .describe('Soft expectation covering from and to; may lie outside the term, e.g. a summer placement held by a fall course. Not a confirmed occurrence and never a substitute for rules'),
    source: z.enum(['official','personal','unknown']).optional().describe('Who states this expectation; personal or unknown never counts as official scheduling'),
    confidence: z.enum(['high','medium','low']).optional().describe('How much the expectation can be trusted; lower confidence means more hedging is required'),
    verifiedAt: date().optional().describe('Local date this expectation was last checked'),
  }).strict().optional()
    .describe('Known bounds for unspecified sessions, not exact occurrences. startWeek alone does not imply endWeek; durationWeeks is not a date range; window is a soft placement that may lie outside the term and must not be combined with date'),
  acknowledge: z.object({ until: date(), note: z.string().max(500).optional() }).strict().optional()
    .describe('Known and accepted gap: until this local date coverage still reports the missing time but marks it acknowledged, so it does not need explaining again'),
  status: z.enum(['candidate','selected','not_selected','dropped']).optional().describe('Enrollment state; omitted means unknown, independent of enabled'),
  credits: z.number().finite().nonnegative().optional(),
  hours: z.object({ total: z.number().finite().nonnegative().optional(), theory: z.number().finite().nonnegative().optional(), practice: z.number().finite().nonnegative().optional() }).strict().optional(),
  rules: z.array(rule).max(60).default([]),
}).strict();
export const event = z.object({
  ...common(), kind: z.literal('event'), start: instant().optional(), end: instant().optional(),
  date: date().optional(), termId: id().optional(),
  timezone: z.string().refine(v => DateTime.now().setZone(v).isValid).optional(),
  slot: z.enum(['morning','afternoon','evening']).optional().describe('Coarse local slot: 00–12 / 12–18 / 18–24; boundaries are conservative occupancy, not exact event times'),
  periods: z.array(z.number().int().positive()).min(1).max(30).optional(), location: z.string().default(''),
  busy: z.boolean().default(true), taskId: id().optional(), locked: z.boolean().default(false),
}).strict();
export const task = z.object({
  ...common(), kind: z.literal('task'), durationMinutes: z.number().int().min(1).max(10080),
  earliest: instant(), deadline: instant(), priority: z.number().int().min(0).max(100).default(50),
  minBlockMinutes: z.number().int().positive().default(30), maxBlockMinutes: z.number().int().positive().default(120),
  splittable: z.boolean().default(true), completed: z.boolean().default(false), courseId: id().optional(),
}).strict();
export const exception = z.object({
  ...common(), kind: z.literal('exception'), courseId: id(),
  originalDate: date(), ruleIndex: z.number().int().min(0), cancelled: z.boolean().default(false),
  start: instant().optional(), end: instant().optional(), location: z.string().optional(),
}).strict();
export const entity = z.discriminatedUnion('kind', [term, course, event, task, exception]);
export const querySchema = z.object({
  from: date().optional().describe('Omit for today (in timezone)'), to: date().optional().describe('Exclusive end date; default 7 days after from; max 120 days'),
  timezone: z.string().default('Asia/Shanghai').refine(v => DateTime.now().setZone(v).isValid),
  views: z.array(z.enum(['agenda','catalog','tasks','conflicts','free','config','summary','unscheduled','changes'])).default(['agenda'])
    .describe('Which views to return; each one paginates on its own. Omit (or send []) for agenda'),
  sinceRevision: z.number().int().nonnegative().optional().describe('changes view: return persisted changes with a higher revision, oldest first; in a write response the changes view always reports that write instead'),
  state: z.enum(['enabled','disabled','all']).default('enabled').describe('Display filter: enabled (default) hides disabled entries, all shows both. Never changes what coverage counts'),
  category: z.enum(['academic','activity']).optional()
    .describe('Display filter, courses only. Omit for both. Empty or omitted means no filter, and it also drops every non-course entry (term/event/task), so config plus this filter is always empty'),
  scheduleStatus: z.enum(['scheduled','partial','tbd','unknown']).optional()
    .describe('Display filter, courses only. Omit to see every status together; scheduled hides the courses whose time is only partial/tbd/unknown. CRITICAL: NEVER enumerate statuses in parallel queries. Omit the parameter instead.'),
  courseStatus: z.enum(['candidate','selected','not_selected','dropped','unknown','all']).default('all')
    .describe('Display filter, courses only. "all" (default) shows every status. CRITICAL: NEVER make multiple parallel queries to guess a course status. ALWAYS use "all" (or omit this parameter) if you are unsure of the status.'),
  termId: id().optional().describe('Filter courses/events and term config by term ID (an exact term ID or unique exact title). Omit it for every term - do not invent a placeholder such as ".", "*" or "any"; an unmatched value is ignored and reported instead of filtering'),
  search: z.string().optional().describe('Display filter: case insensitive substring over title/notes/tags/teacher/location. Omit or send "" for no search'),
  kinds: z.array(z.enum(['course','event','task','term','exception'])).optional()
    .describe('Display filter over the storage kind of a record, not a category. Omit or send [] for all kinds. It applies to every view, so kinds ["course","event"] also empties config (which only holds terms)'),
  ids: z.array(id()).optional().describe('Display filter: exact IDs or unique exact titles. Omit or send [] for no restriction (an empty list never means match nothing; unmatched entries are ignored and reported)'),
  simulateEnable: z.array(id()).max(100).default([]).describe('Temporarily enable these exact IDs or unique titles without writing'),
  dayStart: time().default('08:00'), dayEnd: time().default('22:00'), minFreeMinutes: z.number().int().positive().default(30),
  bufferMinutes: z.number().int().min(0).max(180).default(0),
  limit: z.number().int().min(1).max(2000).default(200), offset: z.number().int().min(0).default(0),
}).strict();
export const operation = z.discriminatedUnion('op', [
  z.object({ op: z.literal('put'), entity }).strict(),
  z.object({ op: z.literal('patch'), target: id().describe('Exact ID or unique exact title; searches disabled too'), changes: z.record(z.string(), z.unknown()).describe('Partial entity fields; arrays replaced; id/kind/source cannot change') }).strict(),
  z.object({ op: z.literal('enable'), targets: z.array(id()).min(1).max(500), enabled: z.boolean() }).strict(),
  z.object({ op: z.literal('set_timetable'), target: id().describe('Term ID or unique exact term title'), name: timetableName(),
    periods: z.array(period()).min(1).max(60).describe('Complete replacement of this named timetable; does not activate it') }).strict(),
  z.object({ op: z.literal('switch_timetable'), target: id().describe('Term ID or unique exact term title'),
    timetable: timetableName().nullable().describe('Existing name; null switches back to term.periods'),
    effectiveFrom: date().describe('Required local date in term timezone; replaces switch on same date, preserves other switches') }).strict(),
]);
export const mutateSchema = z.object({
  operations: z.array(operation).min(1).max(500), dryRun: z.boolean().default(false),
  expectedRevision: z.number().int().nonnegative().optional(), requestId: id().optional().describe('Reuse same ID and payload on retries'),
  returnQuery: querySchema.optional().describe('Read requested views after mutation in the same call'),
}).strict();
const importEntity = z.discriminatedUnion('kind', [term, course, event, task, exception].map(s => s.extend({enabled: z.boolean().optional()})));
export const importSchema = z.object({
  namespace: id(), entries: z.array(importEntity).min(1).max(500),
  defaultEnabled: z.boolean().default(false).describe('New imported courses default disabled until selected'),
  preserveStatus: z.boolean().default(true).describe('Reimport preserves an existing enrollment status'),
  preserveEnabled: z.boolean().default(true).describe('Reimport preserves personal enabled/disabled choices'),
  dryRun: z.boolean().default(false), expectedRevision: z.number().int().nonnegative().optional(), requestId: id().optional(),
  returnQuery: querySchema.optional(),
}).strict();
export const planSchema = z.object({
  tasks: z.array(id()).max(100).optional().describe('Existing task IDs or unique titles; omitted means all active unfinished tasks'),
  newTasks: z.array(task).max(100).default([]).describe('Create and schedule tasks in one call when commit=true'),
  from: date(), to: date(), timezone: querySchema.shape.timezone,
  dayStart: time().default('08:00'), dayEnd: time().default('22:00'), bufferMinutes: z.number().int().min(0).max(180).default(0),
  prefer: z.enum(['earliest','morning','afternoon','evening']).default('earliest'),
  commit: z.boolean().default(false).describe('true directly writes feasible blocks; false previews only'),
  requireAll: z.boolean().default(true).describe('When committing, abort if any task cannot be fully scheduled'),
  expectedRevision: z.number().int().nonnegative().optional(), requestId: id().optional(),
}).strict();
