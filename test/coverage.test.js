import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
const term={kind:'term',id:'term',title:'秋季',startDate:'2026-09-01',endDate:'2026-12-31',weekOne:'2026-08-31'};
const rules=[{weekday:2,weeks:[3],start:'10:00',end:'11:00'}];
const course={kind:'course',id:'math',title:'数学',termId:'term',status:'selected',rules};
const q={from:'2026-09-14',to:'2026-09-21',views:['agenda','conflicts','free','unscheduled']};
function setup(t,entries=[]){const store=new Store(':memory:');t.after(()=>store.close());const e=new Engine(store);e.mutate({operations:[term,...entries].map(entity=>({op:'put',entity}))});return e;}

test('official unselected sections retain published rules, query separately and simulate net conflicts',t=>{
  const e=setup(t,[course]);
  e.import({namespace:'school',entries:[{...course,id:'cpp-section1',title:'C++',status:'not_selected',scheduleStatus:'scheduled',scheduleSource:{type:'official',reference:'学校导出：课堂1'},source:{namespace:'school',key:'CPP-01'}},{...course,id:'cpp-section2',title:'C++',status:'not_selected',scheduleSource:{type:'official'},rules:[{...rules[0],start:'14:00',end:'15:00'}],source:{namespace:'school',key:'CPP-02'}}]});
  assert.equal(e.query(q).views.agenda.length,1);
  const unselected=e.query({...q,state:'all',courseStatus:'not_selected'});assert.equal(unselected.views.agenda.length,2);assert.equal(unselected.views.conflicts.length,0);
  const before=e.store.revision(),one=e.query({...q,simulateEnable:['cpp-section1']});
  assert.equal(one.simulation.baselineConflictCount,0);assert.equal(one.simulation.addedConflictCount,1);assert.equal(one.simulation.addedConflicts.length,1);assert.equal(one.coverage.complete,true);
  const two=e.query({...q,simulateEnable:['cpp-section2']});assert.equal(two.simulation.addedConflictCount,0);assert.equal(two.simulation.targets[0].occurrences,1);
  assert.equal(e.store.revision(),before);assert.equal(e.store.snapshot().get('cpp-section1').status,'not_selected');assert.equal(e.store.snapshot().get('cpp-section1').enabled,false);
  assert.throws(()=>e.query({...q,simulateEnable:['C++']}),{code:'AMBIGUOUS_TARGET'});
});

test('missing, confirmed TBD and partial times appear explicitly; coverage ignores display filters and paginates',t=>{
  const e=setup(t,[course,{...course,id:'a-missing',title:'未导入',rules:[]},{...course,id:'b-tbd',title:'待通知',rules:[],scheduleStatus:'tbd'},{...course,id:'c-partial',title:'只知一部分',scheduleStatus:'partial'},{...course,id:'d-inactive',status:'not_selected',enabled:false,rules:[]}]);
  const read=e.query({...q,search:'no match',ids:['no-id'],state:'disabled',category:'activity',limit:1});
  assert.equal(read.views.agenda.length,0);assert.equal(read.coverage.complete,false);assert.equal(read.coverage.courses.considered,4);assert.equal(read.coverage.courses.missingTime,2);assert.equal(read.coverage.courses.partial,1);
  assert.equal(read.coverage.pagination.total,3);assert.equal(read.coverage.pagination.hasMore,true);assert.equal(read.coverage.issues[0].reason,'time_not_imported');
  const next=e.query({...q,offset:1,limit:1});assert.equal(next.coverage.issues[0].reason,'time_tbd');
  const all=e.query({...q,state:'all'});assert.equal(all.views.unscheduled.length,4);
  const legacy=e.query({views:['catalog'],ids:['a-missing']}).views.catalog[0];assert.equal(legacy.scheduleStatus,'unknown');assert.equal(e.store.snapshot().get('a-missing').scheduleStatus,undefined);
  const empty=e.query({...q,simulateEnable:['d-inactive']});assert.equal(empty.simulation.complete,false);assert.equal(empty.simulation.targets[0].occurrences,0);
});

test('known week/date bounds scope missing time without inventing sessions, including teaching-day remapping',t=>{
  const e=setup(t,[{...course,rules:[],scheduleStatus:'unknown',expectedTiming:{startWeek:9}},{...course,id:'intern',rules:[],scheduleStatus:'tbd',expectedTiming:{date:'2026-10-30',durationWeeks:1}}]);
  const early=e.query(q);assert.equal(early.coverage.complete,true);assert.equal(early.views.unscheduled.length,0);
  const later=e.query({...q,from:'2026-10-26',to:'2026-11-02'});assert.equal(later.coverage.courses.missingTime,2);assert.equal(later.views.agenda.length,0);
  e.mutate({operations:[{op:'patch',target:'term',changes:{calendar:{'2026-09-19':'2026-10-27'}}}]});
  assert.equal(e.query(q).coverage.complete,false);assert.equal(e.query(q).coverage.issues[0].entityId,'math');
  const outside=e.query({...q,from:'2027-01-01',to:'2027-01-02'});assert.equal(outside.coverage.complete,true);assert.equal(outside.coverage.courses.considered,0);
  assert.equal(e.query({...q,from:'2027-01-01',to:'2027-01-02',simulateEnable:['math']}).coverage.issues[0].reason,'outside_term');
});

test('personal recurring activities stay in agenda and conflicts but never academic totals',t=>{
  const {status,...meeting}=course;
  const e=setup(t,[{...course,credits:0,hours:{total:0}},{...meeting,id:'meeting',title:'例会',category:'activity'},{...course,id:'candidate',status:'candidate',rules:[]}]);
  const result=e.query({...q,views:['agenda','conflicts','summary'],state:'all'});
  assert.equal(result.views.agenda.length,2);assert.equal(result.views.conflicts.length,1);
  assert.equal(result.views.summary.reduce((sum,g)=>sum+g.courses,0),2);
  const selected=result.views.summary.find(g=>g.status==='selected');assert.equal(selected.credits.available,true);assert.equal(selected.hours.total.available,true);assert.equal(selected.hours.theory.available,false);assert.equal(selected.hours.theory.knownCount,0);
  const unknown=result.views.summary.find(g=>g.status==='candidate');assert.equal(unknown.credits.available,false);
  assert.equal(e.query({...q,category:'activity'}).views.agenda[0].entityId,'meeting');
});

test('schedule consistency validation is atomic and later exact schedules clear unknown state explicitly',t=>{
  const e=setup(t,[{...course,rules:[],scheduleStatus:'unknown'}]),before=e.store.revision();
  for(const changes of [{scheduleStatus:'scheduled'},{scheduleStatus:'partial'},{rules},{expectedTiming:{startWeek:12,endWeek:9}},{expectedTiming:{endWeek:60}},{expectedTiming:{date:'2027-01-01'}},{expectedTiming:{date:'2026-09-15',startWeek:3}},{category:'activity'}]) {
    assert.throws(()=>e.mutate({operations:[{op:'patch',target:'math',changes}]}));assert.equal(e.store.revision(),before);
  }
  e.mutate({operations:[{op:'patch',target:'math',changes:{rules,scheduleStatus:'scheduled'}}]});
  assert.equal(e.query(q).coverage.complete,true);assert.equal(e.query(q).views.unscheduled.length,0);
});

test('disabled parent and unknown selected courses cannot yield a misleading clean simulation',t=>{
  const e=setup(t,[{...course,rules:[]}]);
  e.mutate({operations:[{op:'enable',targets:['term'],enabled:false}]});
  const r=e.query({...q,simulateEnable:['math']});assert.equal(r.coverage.complete,false);assert.equal(r.coverage.issues[0].reason,'term_disabled');assert.equal(r.simulation.targets[0].effective,false);
  const both=e.query({...q,simulateEnable:['term','math']});assert.equal(both.coverage.complete,false);assert.equal(both.coverage.issues[0].reason,'time_not_imported');
});

test('preview and committed plans disclose tentative status when active schedules are incomplete',t=>{
  const e=setup(t,[{...course,rules:[],scheduleStatus:'tbd'}]);
  const input={from:'2026-09-15',to:'2026-09-16',newTasks:[{id:'study',kind:'task',title:'复习',durationMinutes:30,earliest:'2026-09-15T08:00:00+08:00',deadline:'2026-09-15T10:00:00+08:00'}]};
  const preview=e.plan(input);assert.equal(preview.tentative,true);assert.equal(preview.query.coverage.complete,false);assert.equal(e.store.snapshot().has('study'),false);
  const committed=e.plan({...input,commit:true});assert.equal(committed.committed,true);assert.equal(committed.tentative,true);assert.equal(committed.query.coverage.issues[0].reason,'time_tbd');
});

test('import retains selection while accepting official timing details and activity category',t=>{
  const e=setup(t),source={namespace:'school',key:'CPP'};
  e.import({namespace:'school',entries:[{...course,status:'not_selected',rules:[],scheduleStatus:'unknown',source}]});
  e.import({namespace:'school',entries:[{...course,status:'selected',rules,scheduleStatus:'scheduled',scheduleSource:{type:'official'},source}]});
  const saved=e.store.snapshot().get('math');assert.equal(saved.status,'not_selected');assert.equal(saved.enabled,false);assert.equal(saved.scheduleStatus,'scheduled');
  assert.equal(e.query({...q,state:'all',courseStatus:'not_selected'}).views.agenda.length,1);
});
