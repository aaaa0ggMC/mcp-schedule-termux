import { DateTime } from 'luxon';
import { fail } from './store.js';

export const scheduleStatusOf = c => c.scheduleStatus ?? (c.rules.length ? 'scheduled' : 'unknown');
export const academic = c => c.category !== 'activity';
export const courseActive = c => !academic(c) || !c.status || c.status === 'selected';
export const courseInfo = c => ({...c,category:c.category ?? 'academic',scheduleStatus:scheduleStatusOf(c)});

export function validateSchedule(c,t) {
  const status=scheduleStatusOf(c);
  if ((['scheduled','partial'].includes(status)) !== (c.rules.length>0))
    fail('INVALID_SCHEDULE','scheduled/partial 需要时间规则；没有规则时使用 unknown（未录入）或 tbd（已确认待定）',{courseId:c.id});
  if (!academic(c) && (c.status!==undefined || c.credits!==undefined || c.hours!==undefined))
    fail('INVALID_CATEGORY','个人周期活动不设置选课状态、学分或学时',{courseId:c.id});
  const timing=c.expectedTiming;
  if (!timing) return;
  const lastWeek=Math.floor(DateTime.fromISO(t.endDate).diff(DateTime.fromISO(t.weekOne),'days').days/7)+1;
  if ((timing.startWeek && timing.endWeek && timing.startWeek>timing.endWeek) ||
      (timing.startWeek??1)>lastWeek || (timing.endWeek??1)>lastWeek ||
      (timing.date && (timing.date<t.startDate || timing.date>t.endDate)))
    fail('INVALID_EXPECTED_TIMING','预期周次/日期须在学期内且起止有序',{courseId:c.id});
  if (timing.date && (timing.startWeek!==undefined || timing.endWeek!==undefined))
    fail('INVALID_EXPECTED_TIMING','预期时间使用实际 date 或教学周范围，不混用',{courseId:c.id});
}

// Partial timing bounds apply to the unspecified part; they never invent a weekday or clock time.
export function mayHaveUnknownTime(c,t,start,end) {
  const timing=c.expectedTiming ?? {};
  const first=DateTime.fromISO(t.startDate,{zone:t.timezone});
  const stop=DateTime.fromISO(t.endDate,{zone:t.timezone}).plus({days:1});
  if (first>=end || stop<=start) return false;
  let day=start.setZone(t.timezone).startOf('day');
  if (day<first) day=first;
  for (;day<end && day<stop;day=day.plus({days:1})) {
    const date=day.toISODate();
    if (timing.date) {if (timing.date===date) return true;continue;}
    // A remapped date may bring a later teaching week into an earlier query.
    const teaching=t.calendar?.[date] ?? date;
    const week=Math.floor(DateTime.fromISO(teaching).diff(DateTime.fromISO(t.weekOne),'days').days/7)+1;
    if (week >= (timing.startWeek??1) && week <= (timing.endWeek??60)) return true;
  }
  return false;
}

export function coverageOf(map,agenda,start,end,simulated=[]) {
  const issues=[], activeCourses=[];
  const occurrenceIds=new Set(agenda.filter(o=>o.enabled&&o.kind==='course').map(o=>o.entityId));
  for (const c of map.values()) {
    if (c.kind!=='course') continue;
    const t=map.get(c.termId);
    const termInRange=DateTime.fromISO(t.startDate,{zone:t.timezone})<end && DateTime.fromISO(t.endDate,{zone:t.timezone}).plus({days:1})>start;
    const active=c.enabled && t.enabled && courseActive(c);
    if (active && (termInRange || occurrenceIds.has(c.id))) {
      activeCourses.push(c);
      if (scheduleStatusOf(c)!=='scheduled' && mayHaveUnknownTime(c,t,start,end)) issues.push({entityId:c.id,title:c.title,category:c.category??'academic',scheduleStatus:scheduleStatusOf(c),reason:scheduleStatusOf(c)==='partial'?'partial_schedule':scheduleStatusOf(c)==='tbd'?'time_tbd':'time_not_imported',expectedTiming:c.expectedTiming});
    }
    if (simulated.includes(c.id) && !active) issues.push({entityId:c.id,title:c.title,reason:'term_disabled'});
    if (simulated.includes(c.id) && active && !termInRange && !occurrenceIds.has(c.id)) issues.push({entityId:c.id,title:c.title,reason:'outside_term'});
  }
  const approximateEvents=agenda.filter(o=>o.enabled&&o.busy&&o.precision==='slot').length;
  const complete=issues.length===0;
  return {
    scope:'enabled_entries_in_query_range',complete,
    courses:{considered:activeCourses.length,withOccurrences:occurrenceIds.size,fullySpecified:activeCourses.filter(c=>scheduleStatusOf(c)==='scheduled').length,missingTime:issues.filter(i=>['time_not_imported','time_tbd'].includes(i.reason)).length,partial:issues.filter(i=>i.reason==='partial_schedule').length},
    approximateEvents,issues,
    message:!complete?'时间资料不完整；空冲突列表不代表已排除冲突，空闲和排程仅依据已知占用。':approximateEvents?'已检查本次范围内已存的有效安排；粗略事件按保守时段处理，不能确认精确冲突。':'已检查本次范围内已存的有效安排；不代表学校全部公示课程已导入。',
  };
}
