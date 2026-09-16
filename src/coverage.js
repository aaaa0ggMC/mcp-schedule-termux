import { DateTime } from 'luxon';
import { fail } from './store.js';

export const scheduleStatusOf = c => c.scheduleStatus ?? (c.rules.length ? 'scheduled' : 'unknown');
export const academic = c => c.category !== 'activity';
export const courseActive = c => !academic(c) || !c.status || c.status === 'selected';
export const courseInfo = c => ({...c,category:c.category ?? 'academic',scheduleStatus:scheduleStatusOf(c)});

// Stable machine-readable codes for coverage.issues[].reason and coverage.outOfRange[].reason.
export const ISSUE_REASONS = {
  time_not_imported: '没有任何时间规则，也没有确认待定',
  time_tbd: '来源已确认时间待定',
  partial_schedule: '只录入部分课次',
  term_disabled: 'simulateEnable 的目标所属学期已禁用',
  outside_term: 'simulateEnable 的目标在本范围内没有课次，也不在学期或预期窗口内',
};
const reasonOf = status => status === 'partial' ? 'partial_schedule' : status === 'tbd' ? 'time_tbd' : 'time_not_imported';
const overlapsRange = (from,to,start,end,zone) =>
  DateTime.fromISO(from,{zone}) < end && DateTime.fromISO(to,{zone}).plus({days:1}) > start;

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
  // A soft window is a placement claim of its own, so it never travels with a fixed date and it
  // may leave the term: the internship case is "this term's course, expected in next summer".
  if (timing.window) {
    if (timing.date || timing.startWeek !== undefined || timing.endWeek !== undefined || timing.durationWeeks !== undefined)
      fail('INVALID_EXPECTED_TIMING','软性 window 与教学周/日期边界不混用，二者择一',{courseId:c.id});
    if (timing.window.from > timing.window.to || DateTime.fromISO(timing.window.to).diff(DateTime.fromISO(timing.window.from),'days').days > 420)
      fail('INVALID_EXPECTED_TIMING','预期窗口起止须有序且不超过 420 天',{courseId:c.id});
  }
}

// Partial timing bounds apply to the unspecified part; they never invent a weekday or clock time.
export function mayHaveUnknownTime(c,t,start,end) {
  const timing=c.expectedTiming ?? {};
  const first=DateTime.fromISO(t.startDate,{zone:t.timezone});
  const stop=DateTime.fromISO(t.endDate,{zone:t.timezone}).plus({days:1});
  // A soft window is the whole placement claim: it may sit outside the term, so it replaces the
  // teaching-week scan instead of widening it.
  if (timing.window) return overlapsRange(timing.window.from,timing.window.to,start,end,t.timezone);
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

export function coverageOf(map,agenda,start,end,simulated=[],today=start.toISODate()) {
  const issues=[],issuesOutsideRange=[],activeCourses=[];
  const occurrenceIds=new Set(agenda.filter(o=>o.enabled&&o.kind==='course').map(o=>o.entityId));
  // A gap never explains itself: "时间待定" of a course that is already selected and carries the
  // reason in its notes (学院还没排时间 / 预计暑假) reads very differently from a course the user
  // simply never filled in. Both lists of gaps therefore carry the entry's own explanation.
  const gapOf=(c,status,extra={})=>({
    entityId:c.id,title:c.title,category:c.category??'academic',scheduleStatus:status,reason:reasonOf(status),
    ...(c.status!==undefined?{status:c.status}:{}),
    ...(c.notes?{notes:c.notes}:{}),
    ...extra
  });
  for (const c of map.values()) {
    if (c.kind!=='course') continue;
    const t=map.get(c.termId), window=c.expectedTiming?.window;
    const termInRange=DateTime.fromISO(t.startDate,{zone:t.timezone})<end && DateTime.fromISO(t.endDate,{zone:t.timezone}).plus({days:1})>start;
    const windowInRange=window?overlapsRange(window.from,window.to,start,end,t.timezone):false;
    const active=c.enabled && t.enabled && courseActive(c), status=scheduleStatusOf(c), gap=status!=='scheduled';
    if (active && (termInRange || windowInRange || occurrenceIds.has(c.id))) {
      activeCourses.push(c);
      if (gap && mayHaveUnknownTime(c,t,start,end)) {
        const ack=c.acknowledge;
        issues.push(gapOf(c,status,{
          acknowledged:Boolean(ack&&ack.until>=today),
          ...(ack?{acknowledgedUntil:ack.until, ...(ack.note?{acknowledgeNote:ack.note}:{})}:{}),
          expectedTiming:c.expectedTiming
        }));
      } else if (gap) {
        issuesOutsideRange.push({
          entityId: c.id, title: c.title, category: c.category ?? 'academic',
          scheduleStatus: status, reason: reasonOf(status),
          ...(c.status !== undefined ? { status: c.status } : {}),
          ...(c.expectedTiming?.window?.label ? { expectedTime: c.expectedTiming.window.label } : {})
        });
      }
    }
    if (simulated.includes(c.id) && !active) issues.push({...gapOf(c,status),reason:'term_disabled'});
    if (simulated.includes(c.id) && active && !termInRange && !occurrenceIds.has(c.id)) issues.push({...gapOf(c,status),reason:'outside_term'});
  }
  const approximateEvents=agenda.filter(o=>o.enabled&&o.busy&&o.precision==='slot').length;
  const complete=issues.length===0, acknowledged=issues.filter(i=>i.acknowledged).length;
  // A clean range with out-of-range gaps is not a silent "all good": say that the uncertainty
  // exists somewhere else, so it is not mistaken for "nothing to know at all".
  const elsewhere=issuesOutsideRange.length
    ?`另有 ${issuesOutsideRange.length} 条时间不完整的记录按预期不会落在本范围内（见 issuesOutsideRange）；`
    :'';
  return {
    scope:'enabled_entries_in_query_range',complete,
    courses:{considered:activeCourses.length,withOccurrences:occurrenceIds.size,fullySpecified:activeCourses.filter(c=>scheduleStatusOf(c)==='scheduled').length,missingTime:issues.filter(i=>['time_not_imported','time_tbd'].includes(i.reason)).length,partial:issues.filter(i=>i.reason==='partial_schedule').length,unresolvedOutsideRange:issuesOutsideRange.length},
    approximateEvents,acknowledgedIssues:acknowledged,issues,issuesOutsideRange,
    message:!complete?(acknowledged===issues.length?'时间资料不完整：本范围内缺失的时间都是已确认的待定，无需重复说明；空冲突列表不代表已排除冲突，空闲和排程仅依据已知占用。':'时间资料不完整；空冲突列表不代表已排除冲突，空闲和排程仅依据已知占用。'):approximateEvents?`已检查本次范围内已存的有效安排；${elsewhere}粗略事件按保守时段处理，不能确认精确冲突。`:`已检查本次范围内已存的有效安排；${elsewhere}不代表学校全部公示课程已导入。`,
  };
}
