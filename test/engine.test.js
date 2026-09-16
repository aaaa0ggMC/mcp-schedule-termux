import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
const term={id:'autumn',kind:'term',title:'2026秋',startDate:'2026-09-01',endDate:'2026-12-31',weekOne:'2026-08-31',periods:[{number:1,start:'08:00',end:'08:45'},{number:2,start:'08:55',end:'09:40'}]};
const course={id:'cpp',kind:'course',title:'C++',termId:'autumn',rules:[{weekday:2,weeks:[1,2,3,4],periods:[1,2]}]};
const q={from:'2026-09-14',to:'2026-09-21',views:['agenda','catalog','conflicts','free']};
function setup(t){const store=new Store(':memory:');t.after(()=>store.close());const e=new Engine(store);e.mutate({operations:[{op:'put',entity:term}]});return e;}
test('import defaults disabled, discover and simulate without writes, enable by title in one call',t=>{
  const e=setup(t);
  e.import({namespace:'official',entries:[{...course,source:{namespace:'official',key:'CPP'}}]});
  assert.equal(e.query(q).views.agenda.length,0);
  const catalog=e.query({...q,state:'disabled',search:'C++'});assert.equal(catalog.views.catalog[0].enabled,false);
  const before=e.store.revision();assert.equal(e.query({...q,simulateEnable:['C++']}).views.agenda.length,1);assert.equal(e.store.revision(),before);
  const result=e.mutate({operations:[{op:'enable',targets:['C++'],enabled:true}],returnQuery:q});
  assert.equal(result.query.views.agenda.length,1);assert.equal(result.query.views.agenda[0].start,'2026-09-15T08:00:00.000+08:00');
});
test('import explicit selection and reimport preserve personal selection, with opt-out',t=>{
  const e=setup(t), entry={...course,source:{namespace:'official',key:'CPP'}};
  e.import({namespace:'official',entries:[{...entry,enabled:true}]});
  e.import({namespace:'official',entries:[{...entry,title:'C++ updated',enabled:false}]});
  assert.equal(e.query({views:['catalog'],ids:['cpp']}).views.catalog[0].enabled,true);
  e.import({namespace:'official',entries:[entry],preserveEnabled:false});
  assert.equal(e.query({views:['catalog'],state:'disabled',ids:['cpp']}).views.catalog.length,1);
});
test('a batch is atomic, dry-run is non-persistent and retry is idempotent',t=>{
  const e=setup(t), before=e.store.revision();
  assert.throws(()=>e.mutate({operations:[{op:'put',entity:course},{op:'patch',target:'missing',changes:{enabled:false}}]}),{code:'NOT_FOUND'});
  assert.equal(e.store.revision(),before);assert.equal(e.store.snapshot().has('cpp'),false);
  assert.equal(e.mutate({operations:[{op:'put',entity:course}],dryRun:true,returnQuery:q}).query.views.agenda.length,1);
  assert.equal(e.store.snapshot().has('cpp'),false);
  const request={operations:[{op:'put',entity:course}],requestId:'retry',expectedRevision:before};
  const first=e.mutate(request), second=e.mutate(request);assert.equal(second.replayed,true);assert.equal(second.revision,first.revision);
  assert.throws(()=>e.mutate({...request,operations:[{op:'enable',targets:['cpp'],enabled:false}]}),{code:'REQUEST_ID_REUSED'});
  assert.throws(()=>e.mutate({operations:request.operations,expectedRevision:before}),{code:'REVISION_CONFLICT'});
});
test('ambiguous title returns candidates including disabled entries',t=>{
  const e=setup(t);e.mutate({operations:[{op:'put',entity:course},{op:'put',entity:{...course,id:'cpp2',enabled:false}}]});
  assert.throws(()=>e.mutate({operations:[{op:'enable',targets:['C++'],enabled:false}]}),err=>err.code==='AMBIGUOUS_TARGET'&&err.details.candidates.length===2);
});
test('moved-in class appears under original stable instance id; cancelling and disabling exception work',t=>{
  const e=setup(t);e.mutate({operations:[{op:'put',entity:course},{op:'put',entity:{kind:'exception',id:'move',title:'调课',courseId:'cpp',originalDate:'2026-09-08',ruleIndex:0,start:'2026-09-16T14:00:00+08:00',end:'2026-09-16T15:00:00+08:00'}}]});
  const agenda=e.query(q).views.agenda;assert.equal(agenda.length,2);assert.equal(agenda[1].id,'cpp@2026-09-08#0');
  assert.equal(e.query({from:'2026-09-08',to:'2026-09-09'}).views.agenda.length,0);
  e.mutate({operations:[{op:'patch',target:'move',changes:{cancelled:true}}]});assert.equal(e.query(q).views.agenda.length,1);
  e.mutate({operations:[{op:'enable',targets:['move'],enabled:false}]});assert.equal(e.query({from:'2026-09-08',to:'2026-09-09'}).views.agenda.length,1);
});
test('teaching week and holiday remapping, parent disabled excludes courses',t=>{
  const e=setup(t);e.mutate({operations:[{op:'patch',target:'autumn',changes:{calendar:{'2026-09-15':null,'2026-09-19':'2026-09-15'}}},{op:'put',entity:{...course,rules:[{weekday:2,weeks:[1,3],start:'10:00',end:'11:00'}]}}]});
  assert.equal(e.query(q).views.agenda[0].originalDate,'2026-09-19');
  e.mutate({operations:[{op:'enable',targets:['autumn'],enabled:false}]});assert.equal(e.query(q).views.agenda.length,0);
  assert.equal(e.query({...q,state:'disabled',views:['agenda']}).views.agenda.length,1);
});
test('conflict/free computation ignores catalog search filters and treats touching boundaries as free',t=>{
  const e=setup(t);e.mutate({operations:[{op:'put',entity:course},{op:'put',entity:{id:'meeting',kind:'event',title:'会议',start:'2026-09-15T09:40:00+08:00',end:'2026-09-15T10:00:00+08:00'}}]});
  const result=e.query({...q,from:'2026-09-15',to:'2026-09-16',search:'no-match',dayEnd:'12:00'});
  assert.equal(result.views.agenda.length,0);assert.equal(result.views.conflicts.length,0);assert.match(result.views.free[0].start,/T10:00/);
  e.mutate({operations:[{op:'patch',target:'meeting',changes:{start:'2026-09-15T09:30:00+08:00'}}]});assert.equal(e.query(q).views.conflicts.length,1);
});
test('invalid dates, missing references and unknown patch fields fail without writes',t=>{
  const e=setup(t);
  assert.throws(()=>e.query({from:'2026-02-30'}));assert.throws(()=>e.query({from:'2026-01-01',to:'2027-01-01'}),{code:'INVALID_RANGE'});
  assert.throws(()=>e.mutate({operations:[{op:'put',entity:{...course,termId:'missing'}}]}),{code:'INVALID_REFERENCE'});
  assert.throws(()=>e.mutate({operations:[{op:'patch',target:'autumn',changes:{enabeld:false}}]}));
});
const task={kind:'task',id:'revision',title:'复习',durationMinutes:180,earliest:'2026-09-15T08:00:00+08:00',deadline:'2026-09-16T22:00:00+08:00',maxBlockMinutes:60};
test('plan new tasks in one call, preview no writes, commit avoids courses and retries do not duplicate',t=>{
  const e=setup(t);e.mutate({operations:[{op:'put',entity:course}]});
  const input={from:'2026-09-15',to:'2026-09-17',newTasks:[task],prefer:'evening'};
  const preview=e.plan(input);assert.equal(preview.blocks.length,3);assert.match(preview.blocks[0].start,/T18:00/);assert.equal(e.store.snapshot().has('revision'),false);
  const committed=e.plan({...input,commit:true,requestId:'plan-1'});assert.equal(committed.query.views.conflicts.length,0);
  assert.equal(e.plan({...input,commit:true,requestId:'plan-1'}).replayed,true);
  assert.equal(e.plan({from:'2026-09-15',to:'2026-09-17',commit:true}).blocks.length,0);
});
test('plan requires all by default and buffer is respected; disabled task blocks release time',t=>{
  const e=setup(t);
  assert.throws(()=>e.plan({from:'2026-09-15',to:'2026-09-16',dayStart:'08:00',dayEnd:'09:00',newTasks:[task],commit:true}),{code:'INSUFFICIENT_TIME'});
  assert.equal(e.store.snapshot().has('revision'),false);
  const result=e.plan({from:'2026-09-15',to:'2026-09-16',newTasks:[task],commit:true,bufferMinutes:10});
  assert.match(result.blocks[1].start,/T09:10/);
  e.mutate({operations:[{op:'enable',targets:['revision'],enabled:false}]});assert.equal(e.query(q).views.agenda.length,0);
});
test('persistent database retains entries, revision, retry receipts and audit across restart',()=>{
  const dir=mkdtempSync(join(tmpdir(),'kebiao-'));const path=join(dir,'test.sqlite');
  let store=new Store(path);
  try{
    const input={operations:[{op:'put',entity:term}],requestId:'persistent'};
    new Engine(store).mutate(input);store.close();store=new Store(path);
    assert.equal(store.snapshot().get('autumn').title,term.title);assert.equal(new Engine(store).mutate(input).replayed,true);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM history').get().n,1);
  }finally{store.close();rmSync(dir,{recursive:true});}
});

test('coarse events preserve precision, block planning and report possible conflicts',t=>{
  const e=setup(t);
  e.mutate({operations:[{op:'put',entity:{id:'exam',kind:'event',title:'考试',date:'2026-09-15',slot:'afternoon'}},{op:'put',entity:{id:'visit',kind:'event',title:'会面',start:'2026-09-15T13:00:00+08:00',end:'2026-09-15T14:00:00+08:00'}}]});
  const result=e.query({from:'2026-09-15',to:'2026-09-16',views:['agenda','free','conflicts'],dayStart:'12:00',dayEnd:'18:00'});
  const exam=result.views.agenda.find(x=>x.id==='exam');
  assert.equal(exam.start,undefined);assert.equal(exam.precision,'slot');assert.equal(exam.occupancy.conservative,true);
  assert.equal(result.views.free.length,0);assert.equal(result.views.conflicts[0].certainty,'possible');
  assert.equal(e.store.snapshot().get('exam').start,undefined);
  const plan=e.plan({from:'2026-09-15',to:'2026-09-16',newTasks:[{kind:'task',title:'复习',durationMinutes:60,earliest:'2026-09-15T12:00:00+08:00',deadline:'2026-09-15T18:00:00+08:00'}]});
  assert.equal(plan.blocks.length,0);assert.equal(plan.unallocated[0].remainingMinutes,60);
  const before=e.store.revision();
  assert.throws(()=>e.mutate({operations:[{op:'patch',target:'exam',changes:{start:'2026-09-15T14:00:00+08:00'}}]}),{code:'INVALID_EVENT_TIME'});
  assert.equal(e.store.revision(),before);
  e.mutate({operations:[{op:'put',entity:{id:'late',kind:'event',title:'晚间',date:'2026-09-15',slot:'evening',timezone:'Asia/Shanghai'}}]});
  assert.equal(e.query({from:'2026-09-16',to:'2026-09-17'}).views.agenda.length,0);
  assert.equal(e.query({from:'2026-09-15',to:'2026-09-16',timezone:'UTC'}).views.agenda.find(x=>x.id==='late').occupancy.end,'2026-09-16T00:00:00.000+08:00');
});
test('period events resolve actual date without teaching calendar remapping and reject invalid references',t=>{
  const e=setup(t), event={id:'exam',kind:'event',title:'考试',date:'2026-09-15',termId:'autumn',periods:[1,2]};
  e.mutate({operations:[{op:'patch',target:'autumn',changes:{calendar:{'2026-09-15':null}}},{op:'put',entity:event}]});
  const a=e.query(q).views.agenda[0];assert.equal(a.precision,'periods');assert.match(a.start,/T08:00/);assert.match(a.end,/T09:40/);
  for(const changes of [{periods:[2,1]},{periods:[99]},{periods:[1,1]},{slot:'morning'},{timezone:'UTC'},{date:'2027-01-01'}])assert.throws(()=>e.mutate({operations:[{op:'patch',target:'exam',changes}]}));
  assert.throws(()=>e.mutate({operations:[{op:'put',entity:{kind:'event',title:'无时间'}}]}),{code:'INVALID_EVENT_TIME'});
});
test('enrollment is independent of enable, simulation is temporary, summaries disclose unknown values',t=>{
  const e=setup(t);
  e.mutate({operations:[{op:'put',entity:{...course,status:'not_selected',credits:2,hours:{total:32,theory:24,practice:8}}},{op:'put',entity:{...course,id:'empty',status:'selected',rules:[],credits:0}}]});
  assert.equal(e.query(q).views.agenda.length,0);
  assert.equal(e.query({...q,state:'all',courseStatus:'not_selected'}).views.catalog[0].id,'cpp');
  assert.equal(e.query({...q,simulateEnable:['cpp']}).views.agenda.length,1);
  assert.equal(e.store.snapshot().get('cpp').status,'not_selected');
  const summary=e.query({views:['summary'],state:'all',termId:'autumn',limit:1}).views.summary[0];
  assert.equal(summary.status,'not_selected');assert.equal(summary.credits.knownTotal,2);assert.equal(summary.hours.theory.knownTotal,24);
  const selected=e.query({views:['summary'],courseStatus:'selected'}).views.summary[0];assert.equal(selected.credits.missing,0);assert.equal(selected.hours.total.missing,1);
  e.mutate({operations:[{op:'patch',target:'cpp',changes:{status:'selected'}}]});assert.equal(e.query(q).views.agenda.length,1);
  assert.throws(()=>e.mutate({operations:[{op:'patch',target:'cpp',changes:{hours:{total:10,theory:20}}}]}),{code:'INVALID_HOURS'});
});
test('imports preserve enrollment independently with explicit opt out',t=>{
  const e=setup(t), entry={...course,status:'dropped',source:{namespace:'school',key:'cpp'}};
  e.import({namespace:'school',entries:[entry]});
  e.import({namespace:'school',entries:[{...entry,status:'selected'}]});
  assert.equal(e.store.snapshot().get('cpp').status,'dropped');
  e.import({namespace:'school',entries:[{...entry,status:'selected'}],preserveStatus:false});
  assert.equal(e.store.snapshot().get('cpp').status,'selected');assert.equal(e.store.snapshot().get('cpp').enabled,false);
});

test('changes view replays the audit log incrementally and reports the write that produced it',t=>{
  const e=setup(t),base=e.store.revision();
  e.mutate({operations:[{op:'put',entity:course}]});
  const first=e.query({views:['changes'],sinceRevision:base});
  assert.equal(first.views.changes.length,1);assert.equal(first.views.changes[0].kind,'mutate');
  assert.equal(first.views.changes[0].changes[0].id,'cpp');assert.equal(first.views.changes[0].changes[0].before,null);
  assert.equal(first.views.changes[0].changes[0].after.rules.length,1);
  assert.equal(first.pagination.changes.hasMore,false);
  const seen=first.views.changes.at(-1).revision;
  e.mutate({operations:[{op:'enable',targets:['cpp'],enabled:false}]});
  const delta=e.query({views:['changes'],sinceRevision:seen});
  assert.equal(delta.views.changes.length,1);assert.equal(delta.views.changes[0].changes[0].before.enabled,true);
  assert.equal(delta.views.changes[0].changes[0].after.enabled,false);
  assert.equal(e.query({views:['changes'],sinceRevision:e.store.revision()}).views.changes.length,0);
  const write=e.mutate({operations:[{op:'put',entity:{...course,id:'cpp2'}}],returnQuery:{views:['changes']}});
  assert.equal(write.query.views.changes.length,1);assert.equal(write.query.views.changes[0].changes[0].id,'cpp2');
  assert.equal(write.query.views.changes[0].revision,write.revision);
  const preview=e.mutate({operations:[{op:'put',entity:{...course,id:'cpp3'}}],dryRun:true,returnQuery:{views:['changes']}});
  assert.equal(preview.query.views.changes[0].changes[0].id,'cpp3');assert.equal(e.store.snapshot().has('cpp3'),false);
  assert.deepEqual(e.query({views:['changes'],sinceRevision:base}).views.changes.map(c=>c.revision),[base+1,base+2,base+3]);
});

test('reimport replaces the whole entry and only carries over selection state',t=>{
  const e=setup(t),source={namespace:'school',key:'cpp'};
  e.import({namespace:'school',entries:[{...course,notes:'个人备注',tags:['必修'],enabled:true,source}]});
  e.import({namespace:'school',entries:[{...course,notes:'',tags:[],source}]});
  const saved=e.store.snapshot().get('cpp');
  assert.equal(saved.notes,'');assert.deepEqual(saved.tags,[]);assert.equal(saved.enabled,true);
});

test('empty filter values mean "no filter" instead of matching nothing',t=>{
  const e=setup(t);
  e.mutate({operations:[{op:'put',entity:course},{op:'put',entity:{id:'meeting',kind:'event',title:'例会',date:'2026-09-15',slot:'evening'}}]});
  const base=e.query({...q,views:['agenda','catalog','config']});
  assert.deepEqual(base.views.catalog.map(e=>e.id),['autumn','cpp','meeting']);assert.equal(base.views.config.length,1);
  // ids:[], kinds:[], search:"" and simulateEnable:[] are what a serialised tool call looks like
  // when nothing is being narrowed; they must behave exactly like an omitted parameter.
  const empty=e.query({...q,views:['agenda','catalog','config'],ids:[],kinds:[],search:'',simulateEnable:[]});
  assert.deepEqual(empty.views.agenda,base.views.agenda);
  assert.deepEqual(empty.views.catalog,base.views.catalog);
  assert.equal(empty.views.config.length,1);
  // An empty views list falls back to the default view rather than answering with nothing.
  const noViews=e.query({from:'2026-09-14',to:'2026-09-21',views:[]});
  assert.deepEqual(noViews.views.agenda,base.views.agenda);
  // Real values still filter, and a course-only filter empties config on purpose (no term is a course).
  assert.equal(e.query({...q,views:['catalog'],ids:['cpp']}).views.catalog.length,1);
  assert.equal(e.query({...q,views:['config'],scheduleStatus:'scheduled'}).views.config.length,0);
});

test('a matched-by-nothing reference filter is reported and ignored, not answered with nothing',t=>{
  const e=setup(t);
  e.mutate({operations:[{op:'put',entity:course},{op:'put',entity:{id:'meeting',kind:'event',title:'例会',date:'2026-09-15',slot:'evening'}}]});
  const base=e.query({...q,views:['agenda','catalog','config']});
  // The placeholder a model invents to "fill" a required looking field must not blank the query.
  const placeholder=e.query({...q,views:['agenda','catalog','config'],termId:'.'});
  assert.deepEqual(placeholder.views.agenda,base.views.agenda);
  assert.equal(placeholder.views.config.length,1);
  assert.deepEqual(placeholder.ignoredFilters,{termId:'.'});
  assert.match(placeholder.coverage.message,/忽略无法匹配的展示过滤器/);
  assert.match(placeholder.coverage.message,/autumn/);
  // termId accepts a unique title as well as the ID, and both still filter.
  assert.equal(e.query({...q,views:['config'],termId:'autumn'}).views.config.length,1);
  assert.equal(e.query({...q,views:['config'],termId:'2026秋'}).views.config.length,1);
  assert.equal(e.query({...q,views:['config'],termId:'2027春'}).ignoredFilters.termId,'2027春');
  // ids: unique titles resolve, unknown ones are dropped and reported.
  assert.deepEqual(e.query({...q,views:['catalog'],ids:['C++']}).views.catalog.map(x=>x.id),['cpp']);
  const partial=e.query({...q,views:['catalog'],ids:['cpp','nope']});
  assert.deepEqual(partial.views.catalog.map(x=>x.id),['cpp']);
  assert.deepEqual(partial.ignoredFilters,{ids:['nope']});
  assert.equal(e.query({...q,views:['catalog'],ids:['nope']}).views.catalog.length,3);
});
