import { fail } from './store.js';

// Select by the actual local date, never by a remapped teaching date.
export function timetableAt(term, date) {
  let selected;
  for (const change of term.timetableSwitches ?? []) {
    if (change.effectiveFrom <= date && (!selected || change.effectiveFrom > selected.effectiveFrom)) selected = change;
  }
  const name = selected?.timetable ?? null;
  const periods = name === null ? term.periods : term.timetables?.find(t => t.name === name)?.periods;
  if (!periods) fail('INVALID_TIMETABLE', '切换引用了不存在的作息表', {termId:term.id,timetable:name});
  return {name,effectiveFrom:selected?.effectiveFrom ?? term.startDate,periods};
}

export function validateTimetables(term) {
  const names = new Set();
  for (const table of [{name:null,periods:term.periods},...(term.timetables ?? [])]) {
    if (names.has(table.name)) fail('INVALID_TIMETABLE','作息表名称必须唯一',{termId:term.id,name:table.name});
    names.add(table.name);
    const numbers = new Set();
    for (const p of table.periods) {
      if (p.start >= p.end || numbers.has(p.number)) fail('INVALID_PERIODS','节次编号须唯一且结束晚于开始',{termId:term.id,timetable:table.name});
      numbers.add(p.number);
    }
  }
  const dates = new Set();
  for (const change of term.timetableSwitches ?? []) {
    if (dates.has(change.effectiveFrom) || change.effectiveFrom < term.startDate || change.effectiveFrom > term.endDate || !names.has(change.timetable))
      fail('INVALID_TIMETABLE','切换日期须在学期内且唯一，作息表须存在',{termId:term.id,...change});
    dates.add(change.effectiveFrom);
  }
}

export function resolvePeriods(term, date, numbers) {
  const table = timetableAt(term,date);
  const periods = numbers.map(n => table.periods.find(p => p.number === n));
  if (periods.some(p=>!p) || new Set(numbers).size!==numbers.length || periods.some((p,i)=>i && p.start<periods[i-1].end))
    fail('INVALID_PERIODS','当日作息表中的节次不存在、重复或未按时间顺序排列',{termId:term.id,date,timetable:table.name,periods:numbers});
  return {periods,timetable:table.name};
}
