import { DateTime } from 'luxon';
import { randomUUID } from 'node:crypto';
import { entity, querySchema, mutateSchema, importSchema, planSchema } from './schema.js';
import { fail } from './store.js';
import { timetableAt, validateTimetables, resolvePeriods } from './timetable.js';
const ms = value => DateTime.fromISO(value, {setZone: true}).toMillis();
const iso = (value, zone) => DateTime.fromMillis(value, {zone}).toISO();
const values = map => [...map.values()];
const overlap = (a, b) => ms(a.start) < ms(b.end) && ms(b.start) < ms(a.end);
import { courseActive, academic, courseInfo, scheduleStatusOf, validateSchedule, mayHaveUnknownTime, coverageOf } from './coverage.js';
// Coarse bounds are only occupancy envelopes; never persist invented instants.
function eventWindow(e, map) {
  if (e.start) return {start:e.start,end:e.end,precision:'exact'};
  const t = e.termId ? related(map,e.termId,'term') : undefined;
  const zone = e.timezone ?? t?.timezone ?? 'Asia/Shanghai';
  const day = DateTime.fromISO(e.date,{zone});
  if (e.periods) {
    const {periods,timetable} = resolvePeriods(t,e.date,e.periods);
    return {start:DateTime.fromISO(`${e.date}T${periods[0].start}`,{zone}).toISO(),end:DateTime.fromISO(`${e.date}T${periods.at(-1).end}`,{zone}).toISO(),precision:'periods',timetable};
  }
  const [a,b] = {morning:[0,12],afternoon:[12,18],evening:[18,24]}[e.slot];
  return {start:day.set({hour:a}).toISO(),end:b===24?day.plus({days:1}).toISO():day.set({hour:b}).toISO(),precision:'slot'};
}
export function resolve(map, ref) {
  if (map.has(ref)) return map.get(ref);
  const matches = values(map).filter(e => e.title === ref);
  if (matches.length !== 1) fail(matches.length ? 'AMBIGUOUS_TARGET' : 'NOT_FOUND', `无法唯一定位：${ref}`, {candidates: matches.map(e => ({id:e.id, title:e.title, kind:e.kind, enabled:e.enabled}))});
  return matches[0];
}
function related(map, id, kind) {
  const item = map.get(id);
  if (!item || item.kind !== kind) fail('INVALID_REFERENCE', `找不到 ${kind}: ${id}`);
  return item;
}
export function validate(map) {
  const sources = new Set(), exceptions = new Set();
  // Validate definitions first, irrespective of entity insertion order.
  for (const e of map.values()) { entity.parse(e); if (e.kind==='term') validateTimetables(e); }
  for (const e of map.values()) {
    if (e.source) {
      const key = JSON.stringify([e.source.namespace,e.source.key]);
      if (sources.has(key)) fail('DUPLICATE_SOURCE', '同一来源 key 必须唯一', {source:e.source});
      sources.add(key);
    }
    if (e.kind === 'term') {
      const start = DateTime.fromISO(e.startDate), end = DateTime.fromISO(e.endDate);
      if (start > end || end.diff(start,'days').days > 420 || DateTime.fromISO(e.weekOne).weekday !== 1 || e.weekOne > e.startDate || start.diff(DateTime.fromISO(e.weekOne),'days').days > 6)
        fail('INVALID_TERM', '学期最长 420 天，weekOne 必须是学期开始所在周的周一');
      for (const [actual, teaching] of Object.entries(e.calendar)) {
        if (actual < e.startDate || actual > e.endDate || (teaching && (teaching < e.weekOne || teaching > e.endDate)))
          fail('INVALID_CALENDAR', '校历日期必须在学期范围内（教学日可从 weekOne 起）');
      }
    }
    if (e.kind === 'course') {
      const t = related(map,e.termId,'term');
      validateSchedule(e,t);
      if (e.hours?.total !== undefined && (e.hours.theory ?? 0)+(e.hours.practice ?? 0)>e.hours.total) fail('INVALID_HOURS','分项学时不能超过总学时');
      // Every timetable used during the term must support the course's period references,
      // including disabled courses, so later enabling them remains safe.
      const dates = [t.startDate,...(t.timetableSwitches ?? []).map(s=>s.effectiveFrom)];
      for (const r of e.rules) if (r.periods) for (const date of dates) resolvePeriods(t,date,r.periods);
    }
    if (e.kind === 'event') {
      const exact = e.start !== undefined || e.end !== undefined;
      if (exact ? (!e.start || !e.end || e.date !== undefined || e.slot !== undefined || e.periods !== undefined || e.timezone !== undefined) : (!e.date || Number(!!e.slot)+Number(!!e.periods)!==1))
        fail('INVALID_EVENT_TIME','使用 start/end，或 date + slot，或 date + termId + periods；不可混用');
      const term = e.termId ? related(map,e.termId,'term') : undefined;
      if (e.date && term && (e.date<term.startDate || e.date>term.endDate)) fail('INVALID_EVENT_TIME','事件日期超出学期');
      if (e.periods) {
        if (!term || (e.timezone && e.timezone!==term.timezone)) fail('INVALID_PERIODS','节次事件需引用学期并使用学期时区');
        resolvePeriods(term,e.date,e.periods);
      }
      if (e.taskId && !exact) fail('INVALID_EVENT_TIME','任务时间块必须使用精确 start/end');
      const window=eventWindow(e,map);
      if (ms(window.end) <= ms(window.start)) fail('INVALID_INTERVAL','结束时间必须晚于开始时间');
      if (e.taskId) {
        const t = related(map,e.taskId,'task');
        if (ms(e.start) < ms(t.earliest) || ms(e.end) > ms(t.deadline)) fail('TASK_WINDOW','任务时间块超出任务时间范围');
      }
    }
    if (e.kind === 'task') {
      if (ms(e.deadline) <= ms(e.earliest) || e.minBlockMinutes > e.maxBlockMinutes || (e.splittable && e.durationMinutes < e.minBlockMinutes))
        fail('INVALID_TASK','检查任务时间范围和最小/最大时间块');
      if (e.courseId) related(map,e.courseId,'course');
    }
    if (e.kind === 'exception') {
      const c = related(map,e.courseId,'course'), t = related(map,c.termId,'term');
      if (!c.rules[e.ruleIndex] || !baseOccurrence(c,t,e.originalDate,e.ruleIndex)) fail('INVALID_OCCURRENCE','该日期和规则没有原始课程实例');
      if (Boolean(e.start) !== Boolean(e.end) || (e.start && ms(e.start) >= ms(e.end))) fail('INVALID_INTERVAL','调课需同时提供有效 start/end');
      const key = `${e.courseId}/${e.originalDate}/${e.ruleIndex}`;
      if (e.enabled && exceptions.has(key)) fail('DUPLICATE_EXCEPTION','同一次课只能有一条启用的例外');
      if (e.enabled) exceptions.add(key);
    }
  }
}
function baseOccurrence(c,t,date,index) {
  if (date < t.startDate || date > t.endDate) return null;
  const teaching = Object.hasOwn(t.calendar,date) ? t.calendar[date] : date;
  if (!teaching) return null;
  const d = DateTime.fromISO(teaching,{zone:t.timezone});
  const week = Math.floor(d.diff(DateTime.fromISO(t.weekOne,{zone:t.timezone}),'days').days/7)+1;
  const r = c.rules[index];
  if (d.weekday !== r.weekday || !r.weeks.includes(week)) return null;
  const resolved = r.periods ? resolvePeriods(t,date,r.periods) : undefined;
  const periods = resolved?.periods;
  const start = r.start ?? periods[0].start, end = r.end ?? periods.at(-1).end;
  return {id:`${c.id}@${date}#${index}`, entityId:c.id, kind:'course', title:c.title,
    start:DateTime.fromISO(`${date}T${start}`,{zone:t.timezone}).toISO(), end:DateTime.fromISO(`${date}T${end}`,{zone:t.timezone}).toISO(),
    location:r.location ?? c.location, teacher:c.teacher, busy:true, enabled:c.enabled && t.enabled && courseActive(c),
    originalDate:date, ruleIndex:index, week, termId:t.id,...(resolved?{timetable:resolved.timetable}:{})};
}
function range(q) {
  const start = q.from ? DateTime.fromISO(q.from,{zone:q.timezone}) : DateTime.now().setZone(q.timezone).startOf('day');
  const end = q.to ? DateTime.fromISO(q.to,{zone:q.timezone}) : start.plus({days:7});
  if (end <= start || end.diff(start,'days').days > 120) fail('INVALID_RANGE','查询范围必须为 1–120 天，to 为不包含的结束日期');
  if (q.dayStart >= q.dayEnd) fail('INVALID_WINDOW','dayStart 必须早于 dayEnd');
  return {start,end};
}
export function timeline(map,q) {
  const {start,end} = range(q), out=[];
  const exceptions = new Map(values(map).filter(e=>e.kind==='exception' && e.enabled).map(e=>[`${e.courseId}@${e.originalDate}#${e.ruleIndex}`,e]));
  for (const e of map.values()) {
    if (e.kind === 'event') {
      const enabled = e.enabled && (!e.taskId || related(map,e.taskId,'task').enabled);
      const window=eventWindow(e,map);
      if (ms(window.start)<+end && ms(window.end)>+start) out.push({...e,...window,entityId:e.id,enabled});
    }
    if (e.kind === 'course') {
      const t=related(map,e.termId,'term');
      // Iterate the bounded term, so moved-in occurrences are not missed.
      for (let d=DateTime.fromISO(t.startDate,{zone:t.timezone}); d.toISODate()<=t.endDate; d=d.plus({days:1})) {
        for (let i=0;i<e.rules.length;i++) {
          const o=baseOccurrence(e,t,d.toISODate(),i); if (!o) continue;
          const ex=exceptions.get(o.id);
          if (ex?.cancelled) continue;
          if (ex) { if(ex.start) {o.start=ex.start;o.end=ex.end;delete o.timetable;} if(ex.location!==undefined)o.location=ex.location; o.exceptionId=ex.id; }
          if(ms(o.start)<+end && ms(o.end)>+start) out.push(o);
        }
      }
    }
  }
  return out.sort((a,b)=>ms(a.start)-ms(b.start)||a.id.localeCompare(b.id));
}
function freeSlots(agenda,q) {
  const {start,end}=range(q), result=[];
  const busy=agenda.filter(o=>o.enabled && o.busy).map(o=>({start:ms(o.start)-q.bufferMinutes*60000,end:ms(o.end)+q.bufferMinutes*60000})).sort((a,b)=>a.start-b.start);
  for(let day=start;day<end;day=day.plus({days:1})) {
    const date=day.toISODate(); let cursor=+DateTime.fromISO(`${date}T${q.dayStart}`,{zone:q.timezone});
    const stop=+DateTime.fromISO(`${date}T${q.dayEnd}`,{zone:q.timezone});
    const add=(a,b)=>{if(b-a>=q.minFreeMinutes*60000)result.push({start:iso(a,q.timezone),end:iso(b,q.timezone),minutes:(b-a)/60000});};
    for(const b of busy) {if(b.end<=cursor||b.start>=stop)continue;add(cursor,Math.min(b.start,stop));cursor=Math.max(cursor,b.end);if(cursor>=stop)break;}
    add(cursor,stop);
  }
  return result;
}
function conflicts(agenda) {
  const busy=agenda.filter(o=>o.enabled && o.busy), result=[];
  for(let i=0;i<busy.length;i++)for(let j=i+1;j<busy.length && ms(busy[j].start)<ms(busy[i].end);j++) {
    if(overlap(busy[i],busy[j])) result.push({a:busy[i].id,b:busy[j].id,titles:[busy[i].title,busy[j].title],certainty:busy[i].precision==='slot'||busy[j].precision==='slot'?'possible':'confirmed',start:iso(Math.max(ms(busy[i].start),ms(busy[j].start)),'UTC'),end:iso(Math.min(ms(busy[i].end),ms(busy[j].end)),'UTC')});
    if(result.length>=10000) fail('TOO_MANY_CONFLICTS','冲突过多，请缩短查询范围');
  }
  return result;
}
export function queryMap(original,raw={}) {
  const q=querySchema.parse(raw), map=structuredClone(original), {start,end}=range(q);
  const simulated=[];
  for(const ref of q.simulateEnable) {const e=resolve(map,ref);e.enabled=true;if(e.kind==='course' && academic(e))e.status='selected';simulated.push(e.id);}
  for (const [id,e] of map) if(e.kind==='course')map.set(id,courseInfo(e));
  const effective=e=>e.enabled && (e.kind==='course' ? related(map,e.termId,'term').enabled && courseActive(e) : e.kind==='event' && e.taskId ? related(map,e.taskId,'task').enabled : true);
  const matches=e=>(q.state==='all'||(q.state==='enabled')===effective(e)) && (!q.category || (e.kind==='course' && e.category===q.category)) && (!q.scheduleStatus || (e.kind==='course' && e.scheduleStatus===q.scheduleStatus)) && (!q.courseStatus || (e.kind==='course' && (e.status??'unknown')===q.courseStatus)) && (!q.termId || (e.kind==='term'?e.id:e.termId)===q.termId) && (!q.search || `${e.title} ${e.notes??''} ${(e.tags??[]).join(' ')} ${e.teacher??''} ${e.location??''}`.toLowerCase().includes(q.search.toLowerCase())) && (!q.kinds || q.kinds.includes(e.kind)) && (!q.ids || q.ids.includes(e.entityId??e.id));
  const response={range:{from:start.toISODate(),to:end.toISODate(),timezone:q.timezone},simulated,views:{},pagination:{}};
  const put=(name,items)=>{response.views[name]=items.slice(q.offset,q.offset+q.limit);response.pagination[name]={total:items.length,offset:q.offset,limit:q.limit,hasMore:q.offset+q.limit<items.length};};
  const all=values(map).sort((a,b)=>a.id.localeCompare(b.id));
  if(q.views.includes('catalog'))put('catalog',all.filter(matches));
  if(q.views.includes('unscheduled'))put('unscheduled',all.filter(e=>e.kind==='course' && e.scheduleStatus!=='scheduled' && matches(e) && mayHaveUnknownTime(e,related(map,e.termId,'term'),start,end)));
  if(q.views.includes('summary')) {
    const groups=new Map();
    for(const e of all.filter(e=>e.kind==='course' && academic(e) && matches(e))) {
      const status=e.status??'unknown', key=JSON.stringify([e.termId,status]);
      if(!groups.has(key))groups.set(key,{termId:e.termId,status,courses:0,credits:{knownTotal:0,missing:0,knownCount:0},hours:Object.fromEntries(['total','theory','practice'].map(k=>[k,{knownTotal:0,missing:0,knownCount:0}]))});
      const g=groups.get(key);g.courses++;
      const add=(acc,value)=>{if(value===undefined)acc.missing++;else {acc.knownTotal+=value;acc.knownCount++;}};
      add(g.credits,e.credits);for(const k of ['total','theory','practice'])add(g.hours[k],e.hours?.[k]);
    }
    for(const g of groups.values())for(const field of [g.credits,...Object.values(g.hours)])field.available=field.knownCount>0;
    put('summary',[...groups.values()]);
  }
  if(q.views.includes('tasks'))put('tasks',all.filter(e=>e.kind==='task' && matches(e)));
  if(q.views.includes('config'))put('config',all.filter(e=>e.kind==='term' && matches(e)).map(t=>{
    const date=start.setZone(t.timezone).toISODate();
    return {...t,activeTimetable:date<t.startDate||date>t.endDate?null:{date,...timetableAt(t,date)}};
  }));
  if(q.simulateEnable.length || q.views.some(v=>['agenda','conflicts','free','unscheduled'].includes(v))) {
    const agenda=timeline(map,q);
    const coverage=coverageOf(map,agenda,start,end,simulated);
    const issues=coverage.issues;
    response.coverage={...coverage,issues:issues.slice(q.offset,q.offset+q.limit),pagination:{total:issues.length,offset:q.offset,limit:q.limit,hasMore:q.offset+q.limit<issues.length}};
    if(simulated.length) {
      const baseline=conflicts(timeline(original,q)), after=conflicts(agenda);
      const key=c=>JSON.stringify([...[c.a,c.b].sort(),c.start,c.end]);
      const beforeKeys=new Set(baseline.map(key)),afterKeys=new Set(after.map(key));
      const added=after.filter(c=>!beforeKeys.has(key(c)));
      response.simulation={baselineConflictCount:baseline.length,conflictCount:after.length,addedConflictCount:added.length,removedConflictCount:baseline.filter(c=>!afterKeys.has(key(c))).length,
        addedConflicts:added.slice(q.offset,q.offset+q.limit),pagination:{total:added.length,offset:q.offset,limit:q.limit,hasMore:q.offset+q.limit<added.length},complete:coverage.complete,
        targets:simulated.map(id=>({entityId:id,title:map.get(id).title,effective:effective(map.get(id)),occurrences:agenda.filter(o=>o.entityId===id&&o.enabled).length,...(map.get(id).kind==='course'?{scheduleStatus:scheduleStatusOf(map.get(id))}:{})}))};
    }
    if(q.views.includes('agenda'))put('agenda',agenda.map(o=>o.kind==='course'?{...o,category:map.get(o.entityId).category,scheduleStatus:map.get(o.entityId).scheduleStatus}:o).filter(o=>matches({...map.get(o.entityId),...o})).map(o=>{if(o.precision!=='slot')return o;const {start,end,...rest}=o;return {...rest,occupancy:{start,end,conservative:true}};}));
    // Free time/conflicts always use all effective busy entries, irrespective of search/state filters.
    if(q.views.includes('conflicts'))put('conflicts',conflicts(agenda));
    if(q.views.includes('free'))put('free',freeSlots(agenda,q));
  }
  return response;
}
function putEntity(map,raw) {
  const e=entity.parse(raw); e.id??=`${e.kind}_${randomUUID()}`;
  if(map.has(e.id) && map.get(e.id).kind!==e.kind)fail('KIND_CHANGE','不能改变实体类型');
  map.set(e.id,e);return e;
}
export class Engine {
  constructor(store){this.store=store;}
  query(raw){return this.store.read((map,revision)=>({...queryMap(map,raw),revision}));}
  mutate(raw){
    const input=mutateSchema.parse(raw);
    return this.store.transact('mutate',input,input.dryRun,map=>{
      const changed=new Set();
      for(const op of input.operations) {
        if(op.op==='put'){const e=putEntity(map,op.entity);changed.add(e.id);}
        if(op.op==='patch'){
          const old=resolve(map,op.target);
          if(['id','kind','source'].some(k=>Object.hasOwn(op.changes,k)))fail('IMMUTABLE_FIELD','patch 不允许修改 id/kind/source');
          const e=putEntity(map,{...old,...op.changes});changed.add(e.id);
        }
        if(op.op==='enable')for(const ref of op.targets){const e=resolve(map,ref);e.enabled=op.enabled;changed.add(e.id);}
        if(op.op==='set_timetable' || op.op==='switch_timetable') {
          const old=resolve(map,op.target);
          if(old.kind!=='term')fail('INVALID_REFERENCE','作息表操作的 target 必须是学期',{id:old.id});
          let changes;
          if(op.op==='set_timetable') {
            const tables=(old.timetables ?? []).filter(t=>t.name!==op.name);
            changes={timetables:[...tables,{name:op.name,periods:op.periods}].sort((a,b)=>a.name.localeCompare(b.name))};
          } else {
            const switches=(old.timetableSwitches ?? []).filter(s=>s.effectiveFrom!==op.effectiveFrom);
            changes={timetableSwitches:[...switches,{effectiveFrom:op.effectiveFrom,timetable:op.timetable}].sort((a,b)=>a.effectiveFrom.localeCompare(b.effectiveFrom))};
          }
          const e=putEntity(map,{...old,...changes});changed.add(e.id);
        }
      }
      validate(map);
      return {items:[...changed].map(id=>map.get(id)),...(input.returnQuery?{query:queryMap(map,input.returnQuery)}:{})};
    });
  }
  import(raw){
    const input=importSchema.parse(raw);
    return this.store.transact('import',input,input.dryRun,map=>{
      const items=[],seen=new Set();
      for(const entry of input.entries){
        if(!entry.source?.key)fail('SOURCE_REQUIRED','导入条目必须包含 source.key（官方稳定编号）及 source.namespace');
        const key=entry.source.key;
        if(seen.has(key))fail('DUPLICATE_SOURCE','本次导入 source.key 重复');seen.add(key);
        const old=values(map).find(e=>e.source?.namespace===input.namespace && e.source?.key===key);
        if(old && old.kind!==entry.kind)fail('KIND_CHANGE','来源条目类型改变');
        if(!old && entry.id && map.has(entry.id))fail('ID_COLLISION','导入 ID 已被其他来源占用');
        const enabled=old && input.preserveEnabled ? old.enabled : entry.enabled ?? (entry.kind==='course'?input.defaultEnabled:true);
        const status=old && input.preserveStatus && old.status!==undefined ? old.status : entry.status;
        items.push(putEntity(map,{...entry,...(entry.kind==='course'?{status}:{}),id:old?.id??entry.id,source:{namespace:input.namespace,key},enabled}));
      }
      validate(map);return {items,...(input.returnQuery?{query:queryMap(map,input.returnQuery)}:{})};
    });
  }
  plan(raw){
    const input=planSchema.parse(raw);
    return this.store.transact('plan',input,!input.commit,map=>{
      const added=input.newTasks.map(t=>{if(t.id && map.has(t.id))fail('ID_COLLISION','newTasks ID 已存在');return putEntity(map,t);});
      validate(map);
      const selected=input.tasks ? input.tasks.map(ref=>resolve(map,ref)) : values(map).filter(e=>e.kind==='task'&&e.enabled&&!e.completed);
      const tasks=[...new Map([...selected,...added].map(e=>[e.id,e])).values()];
      if(tasks.some(e=>e.kind!=='task'||!e.enabled||e.completed))fail('INVALID_TASK','只能安排已启用且未完成的任务');
      tasks.sort((a,b)=>ms(a.deadline)-ms(b.deadline)||b.priority-a.priority||a.id.localeCompare(b.id));
      const q=querySchema.parse({from:input.from,to:input.to,timezone:input.timezone,dayStart:input.dayStart,dayEnd:input.dayEnd,bufferMinutes:input.bufferMinutes,minFreeMinutes:1});
      const blocks=[],unallocated=[];
      for(const task of tasks){
        const existing=values(map).filter(e=>e.kind==='event'&&e.taskId===task.id&&e.enabled);
        let remaining=Math.max(0,task.durationMinutes-existing.reduce((sum,e)=>sum+(ms(e.end)-ms(e.start))/60000,0));
        while(remaining>0){
          let slots=freeSlots(timeline(map,q),q).map(s=>({start:Math.max(ms(s.start),ms(task.earliest)),end:Math.min(ms(s.end),ms(task.deadline))})).filter(s=>s.end>s.start);
          const preferred={morning:[8,12],afternoon:[12,18],evening:[18,22]}[input.prefer];
          if(preferred){
            const extra=slots.map(s=>{const day=DateTime.fromMillis(s.start,{zone:q.timezone}).startOf('day');return {start:Math.max(s.start,+day.set({hour:preferred[0]})),end:Math.min(s.end,+day.set({hour:preferred[1]}))};}).filter(s=>s.end>s.start);
            slots=[...extra,...slots];
          }
          let chosen;
          for(const s of slots){
            let duration=task.splittable?Math.min(remaining,task.maxBlockMinutes,Math.floor((s.end-s.start)/60000)):remaining;
            if(task.splittable && remaining-duration>0 && remaining-duration<task.minBlockMinutes)duration-=task.minBlockMinutes-(remaining-duration);
            if(duration<=0 || (task.splittable&&duration<task.minBlockMinutes) || duration*60000>s.end-s.start)continue;
            chosen={s,duration};break;
          }
          if(!chosen)break;
          const block=putEntity(map,{kind:'event',title:task.title,taskId:task.id,start:iso(chosen.s.start,q.timezone),end:iso(chosen.s.start+chosen.duration*60000,q.timezone),metadata:{planned:true}});
          blocks.push(block);remaining-=chosen.duration;
        }
        if(remaining>0)unallocated.push({taskId:task.id,title:task.title,remainingMinutes:remaining,reason:'可用时段不足或不满足时间块限制'});
      }
      if(input.commit && input.requireAll && unallocated.length)fail('INSUFFICIENT_TIME','无法完整安排，未写入任何修改',{unallocated});
      validate(map);
      const query=queryMap(map,{...q,views:['agenda','conflicts']});
      return {blocks,unallocated,newTasks:added,committed:input.commit,tentative:!query.coverage.complete,query};
    });
  }
}
