import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';

const summer=[{number:5,start:'14:30',end:'15:15'},{number:6,start:'15:25',end:'16:10'}];
const winter=[{number:5,start:'14:00',end:'14:45'},{number:6,start:'14:55',end:'15:40'}];
const term={kind:'term',id:'autumn',title:'秋季学期',startDate:'2026-09-01',endDate:'2026-12-31',weekOne:'2026-08-31',periods:summer};
const course={kind:'course',id:'math',title:'数学',termId:'autumn',rules:[{weekday:4,weeks:[5,6,7,8],periods:[5,6]}]};
const configure=[
  {op:'set_timetable',target:'秋季学期',name:'summer',periods:summer},
  {op:'set_timetable',target:'autumn',name:'winter',periods:winter},
  {op:'switch_timetable',target:'autumn',timetable:'summer',effectiveFrom:'2026-09-01'},
  {op:'switch_timetable',target:'autumn',timetable:'winter',effectiveFrom:'2026-10-08'},
];
function setup(t){const store=new Store(':memory:');t.after(()=>store.close());const e=new Engine(store);e.mutate({operations:[{op:'put',entity:term},{op:'put',entity:course}]});return e;}
const agenda=(e,from,to)=>e.query({from,to}).views.agenda;

test('set stores named tables without activating; dated switches preserve past and can return to default',t=>{
  const e=setup(t);
  e.mutate({operations:configure.slice(0,2)});
  assert.match(agenda(e,'2026-10-08','2026-10-09')[0].start,/T14:30/);
  const result=e.mutate({operations:configure.slice(2),returnQuery:{from:'2026-10-01',to:'2026-10-16',views:['agenda','config'],termId:'autumn'}});
  assert.deepEqual(result.query.views.agenda.map(x=>[x.originalDate,x.start.slice(11,16),x.timetable]),[
    ['2026-10-01','14:30','summer'],['2026-10-08','14:00','winter'],['2026-10-15','14:00','winter'],
  ]);
  assert.equal(result.query.views.config[0].activeTimetable.name,'summer');
  assert.equal(e.query({from:'2026-10-08',views:['config'],termId:'autumn'}).views.config[0].activeTimetable.name,'winter');
  e.mutate({operations:[{op:'switch_timetable',target:'autumn',timetable:null,effectiveFrom:'2026-10-15'}]});
  assert.match(agenda(e,'2026-10-15','2026-10-16')[0].start,/T14:30/);
  assert.equal(agenda(e,'2026-10-15','2026-10-16')[0].timetable,null);
  // Replacing one date preserves both earlier history and later switches.
  e.mutate({operations:[{op:'switch_timetable',target:'autumn',timetable:'summer',effectiveFrom:'2026-10-08'}]});
  const saved=e.store.snapshot().get('autumn');assert.equal(saved.timetableSwitches.length,3);
  assert.equal(saved.timetableSwitches.at(-1).timetable,null);
  assert.deepEqual(e.store.snapshot().get('math').rules,course.rules);
});

test('remapped teaching date uses actual day timetable; period events follow switches; exact exceptions stay exact',t=>{
  const e=setup(t);
  e.mutate({operations:[...configure,
    {op:'patch',target:'autumn',changes:{calendar:{'2026-10-08':null,'2026-10-10':'2026-10-01'}}},
    {op:'put',entity:{kind:'event',id:'exam',title:'考试',date:'2026-10-08',termId:'autumn',periods:[5,6]}},
    {op:'put',entity:{kind:'event',id:'fixed',title:'活动',start:'2026-10-08T17:00:00+08:00',end:'2026-10-08T18:00:00+08:00'}},
    {op:'put',entity:{kind:'course',id:'clock',title:'固定钟点课',termId:'autumn',rules:[{weekday:4,weeks:[6],start:'19:00',end:'20:00'}]}},
    {op:'put',entity:{kind:'exception',title:'明确调课',id:'move',courseId:'math',originalDate:'2026-10-01',ruleIndex:0,start:'2026-10-09T16:00:00+08:00',end:'2026-10-09T17:00:00+08:00'}},
  ]});
  const rows=agenda(e,'2026-10-08','2026-10-11');
  assert.match(rows.find(x=>x.id==='exam').start,/T14:00/);assert.equal(rows.find(x=>x.id==='exam').timetable,'winter');
  const makeUp=rows.find(x=>x.originalDate==='2026-10-10');assert.equal(makeUp.week,5);assert.match(makeUp.start,/T14:00/);
  const moved=rows.find(x=>x.exceptionId==='move');assert.match(moved.start,/T16:00/);assert.equal(moved.timetable,undefined);
  assert.match(rows.find(x=>x.id==='fixed').start,/T17:00/);
  e.mutate({operations:[{op:'patch',target:'autumn',changes:{calendar:{}}}]});
  assert.match(agenda(e,'2026-10-08','2026-10-09').find(x=>x.entityId==='clock').start,/T19:00/);
});

test('free, conflicts and committed planning use the switched timetable',t=>{
  const e=setup(t);
  e.mutate({operations:[...configure,{op:'put',entity:{kind:'event',title:'会面',id:'meeting',start:'2026-10-08T14:00:00+08:00',end:'2026-10-08T14:20:00+08:00'}}]});
  const query=e.query({from:'2026-10-08',to:'2026-10-09',views:['free','conflicts'],dayStart:'14:00',dayEnd:'17:00',search:'unmatched'});
  assert.equal(query.views.conflicts.length,1);assert.match(query.views.free[0].start,/T15:40/);
  const result=e.plan({from:'2026-10-08',to:'2026-10-09',commit:true,newTasks:[{kind:'task',title:'复习',durationMinutes:60,earliest:'2026-10-08T14:00:00+08:00',deadline:'2026-10-08T17:00:00+08:00'}]});
  assert.match(result.blocks[0].start,/T15:40/);assert.equal(result.unallocated.length,0);
});

test('invalid switches and timetable edits roll back; preview, retries and revision checks work',t=>{
  const e=setup(t),before=e.store.revision();
  const request={operations:configure,requestId:'configure',expectedRevision:before};
  const preview=e.mutate({...request,dryRun:true,returnQuery:{from:'2026-10-08',to:'2026-10-09'}});
  assert.match(preview.query.views.agenda[0].start,/T14:00/);assert.equal(e.store.revision(),before);
  assert.match(agenda(e,'2026-10-08','2026-10-09')[0].start,/T14:30/);
  const first=e.mutate(request);assert.equal(e.mutate(request).replayed,true);
  assert.throws(()=>e.mutate({operations:configure,expectedRevision:before}),{code:'REVISION_CONFLICT'});
  for(const operations of [
    [{op:'switch_timetable',target:'autumn',timetable:'missing',effectiveFrom:'2026-10-08'}],
    [{op:'switch_timetable',target:'autumn',timetable:'winter',effectiveFrom:'2027-01-01'}],
    [{op:'switch_timetable',target:'autumn',timetable:'winter',effectiveFrom:'2026-08-31'}],
    [{op:'switch_timetable',target:'math',timetable:'winter',effectiveFrom:'2026-10-08'}],
    [{op:'set_timetable',target:'autumn',name:'winter',periods:[winter[0]]}],
    [{op:'set_timetable',target:'autumn',name:'winter',periods:[winter[0],winter[0]]}],
    [{op:'set_timetable',target:'autumn',name:'winter',periods:[winter[0],{...winter[1],start:'14:30'}]}],
    [{op:'patch',target:'autumn',changes:{timetables:[]}}],
    [{op:'patch',target:'autumn',changes:{timetableSwitches:[{effectiveFrom:'2026-10-08',timetable:'summer'},{effectiveFrom:'2026-10-08',timetable:'winter'}]}}],
    [{op:'patch',target:'autumn',changes:{timetables:[{name:'winter',periods:winter},{name:'winter',periods:summer}]}}],
  ]) {
    assert.throws(()=>e.mutate({operations}));assert.equal(e.store.revision(),first.revision);
    assert.match(agenda(e,'2026-10-08','2026-10-09')[0].start,/T14:00/);
  }
});

test('term local midnight controls switching across query timezones and unsorted input',t=>{
  const e=setup(t);
  e.mutate({operations:[...configure,{op:'patch',target:'autumn',changes:{timetableSwitches:[{effectiveFrom:'2026-10-08',timetable:'winter'},{effectiveFrom:'2026-09-01',timetable:'summer'}]}},{op:'put',entity:{kind:'event',id:'exam',title:'考试',date:'2026-10-08',termId:'autumn',periods:[5]}}]});
  const query=e.query({from:'2026-10-07',to:'2026-10-09',timezone:'UTC',views:['agenda','config'],termId:'autumn'});
  assert.equal(query.views.config[0].activeTimetable.name,'summer');
  assert.match(query.views.agenda.find(x=>x.id==='exam').start,/T14:00:00.000\+08:00$/);
  assert.equal(e.query({from:'2027-01-01',views:['config'],termId:'autumn'}).views.config[0].activeTimetable,null);
});

test('legacy stored terms need no migration; named-only terms work if switched from term start',t=>{
  const e=setup(t);
  // Model pre-upgrade JSON without either new field, persisted by an older release.
  e.store.db.prepare('UPDATE entities SET body=? WHERE id=?').run(JSON.stringify({...term,enabled:true,tags:[],notes:'',metadata:{},timezone:'Asia/Shanghai',calendar:{}}),'autumn');
  assert.match(agenda(e,'2026-10-08','2026-10-09')[0].start,/T14:30/);
  e.mutate({operations:configure});assert.match(agenda(e,'2026-10-08','2026-10-09')[0].start,/T14:00/);
  e.mutate({operations:[{op:'patch',target:'autumn',changes:{periods:[]}}]});
  assert.match(agenda(e,'2026-10-08','2026-10-09')[0].start,/T14:00/);
  assert.throws(()=>e.mutate({operations:[{op:'switch_timetable',target:'autumn',timetable:null,effectiveFrom:'2026-11-01'}]}),{code:'INVALID_PERIODS'});
});

test('named timetable switches survive database restart and are importable',t=>{
  const dir=mkdtempSync(join(tmpdir(),'kebiao-timetable-')),path=join(dir,'test.sqlite');
  let store=new Store(path);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  let e=new Engine(store);
  e.import({namespace:'school',entries:[{...term,timetables:[{name:'winter',periods:winter}],timetableSwitches:[{effectiveFrom:'2026-10-08',timetable:'winter'}],source:{namespace:'school',key:'term'}},{...course,enabled:true,source:{namespace:'school',key:'math'}}]});
  store.close();store=new Store(path);e=new Engine(store);
  assert.match(agenda(e,'2026-10-08','2026-10-09')[0].start,/T14:00/);
  assert.equal(e.query({from:'2026-10-08',views:['config']}).views.config[0].activeTimetable.name,'winter');
});
