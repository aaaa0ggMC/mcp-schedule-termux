import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { startHttp } from '../src/server.js';

test('official MCP clients initialize, list, write and query on both transports sharing SQLite',async t=>{
  const store=new Store(':memory:'),service=await startHttp(new Engine(store),{port:0});
  t.after(async()=>{await service.close();store.close();});
  const base=`http://127.0.0.1:${service.listener.address().port}`;
  for(const kind of ['http','sse']){
    const client=new Client({name:'test',version:'1.0.0'});
    const transport=kind==='http'?new StreamableHTTPClientTransport(new URL(`${base}/mcp`)):new SSEClientTransport(new URL(`${base}/sse`));
    try{
      await client.connect(transport);
      const list=await client.listTools();assert.equal(list.tools.length,6);
      const write=await client.callTool({name:'schedule_mutate',arguments:{operations:[{op:'put',entity:{id:`${kind}-event`,kind:'event',title:'MCP test',start:'2026-09-15T10:00:00+08:00',end:'2026-09-15T11:00:00+08:00'}}]}});
      assert.equal(write.isError,undefined);assert.equal(write.structuredContent.changed,1);
      const query=await client.callTool({name:'schedule_query',arguments:{from:'2026-09-15',to:'2026-09-16'}});
      assert.equal(query.structuredContent.views.agenda.length,kind==='http'?1:2);
      const invalid=await client.callTool({name:'schedule_mutate',arguments:{operations:[{op:'enable',targets:['missing'],enabled:false}]}});assert.equal(invalid.isError,true);
      const resources=await client.listResources();assert.equal(resources.resources[0].uri,'schedule://guide');
      assert.ok((await client.readResource({uri:'schedule://guide'})).contents.length);
    }finally{if(kind==='http')await transport.terminateSession();await client.close();}
  }
  assert.equal((await fetch(`${base}/health`)).status,200);
  assert.equal((await fetch(`${base}/health`,{headers:{Origin:'https://evil.example'}})).status,403);
});
test('optional bearer auth protects both transport endpoints',async t=>{
  const store=new Store(':memory:'),service=await startHttp(new Engine(store),{port:0,token:'test-only'});
  t.after(async()=>{await service.close();store.close();});const base=`http://127.0.0.1:${service.listener.address().port}`;
  assert.equal((await fetch(`${base}/sse`)).status,401);
  assert.equal((await fetch(`${base}/mcp`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
  assert.equal((await fetch(`${base}/health`,{headers:{Authorization:'Bearer test-only'}})).status,200);
  const client=new Client({name:'auth-test',version:'1.0.0'}),transport=new StreamableHTTPClientTransport(new URL(`${base}/mcp`),{requestInit:{headers:{Authorization:'Bearer test-only'}}});
  try{await client.connect(transport);assert.equal((await client.listTools()).tools.length,6);}finally{await transport.terminateSession();await client.close();}
});

test('MCP advertises and executes named timetable operations over HTTP and SSE',async t=>{
  const store=new Store(':memory:'),service=await startHttp(new Engine(store),{port:0});
  t.after(async()=>{await service.close();store.close();});
  const base=`http://127.0.0.1:${service.listener.address().port}`;
  for(const kind of ['http','sse']) {
    const client=new Client({name:'timetable-test',version:'1.0.0'});
    const transport=kind==='http'?new StreamableHTTPClientTransport(new URL(`${base}/mcp`)):new SSEClientTransport(new URL(`${base}/sse`));
    try {
      await client.connect(transport);
      const list=await client.listTools(),schema=JSON.stringify(list.tools.find(t=>t.name==='schedule_mutate').inputSchema);
      assert.ok(schema.includes('set_timetable'));assert.ok(schema.includes('switch_timetable'));assert.ok(schema.includes('effectiveFrom'));
      const termId=`${kind}-term`;
      const result=await client.callTool({name:'schedule_mutate',arguments:{operations:[
        {op:'put',entity:{kind:'term',id:termId,title:termId,startDate:'2026-09-01',endDate:'2026-12-31',weekOne:'2026-08-31'}},
        {op:'put',entity:{kind:'course',id:`${kind}-class`,title:'数学',termId,rules:[{weekday:4,weeks:[6],periods:[5]}]}},
        {op:'set_timetable',target:termId,name:'summer',periods:[{number:5,start:'14:30',end:'15:15'}]},
        {op:'set_timetable',target:termId,name:'winter',periods:[{number:5,start:'14:00',end:'14:45'}]},
        {op:'switch_timetable',target:termId,timetable:'summer',effectiveFrom:'2026-09-01'},
        {op:'switch_timetable',target:termId,timetable:'winter',effectiveFrom:'2026-10-08'},
      ],returnQuery:{from:'2026-10-08',to:'2026-10-09',termId,views:['agenda','config']}}});
      assert.equal(result.isError,undefined);
      assert.match(result.structuredContent.query.views.agenda[0].start,/T14:00/);
      assert.equal(result.structuredContent.query.views.config[0].activeTimetable.name,'winter');
      const invalid=await client.callTool({name:'schedule_mutate',arguments:{operations:[{op:'switch_timetable',target:termId,timetable:'missing',effectiveFrom:'2026-10-08'}]}});
      assert.equal(invalid.isError,true);assert.equal(invalid.structuredContent.error.code,'INVALID_TIMETABLE');
    } finally {if(kind==='http')await transport.terminateSession();await client.close();}
  }
});

test('MCP exposes incomplete schedule coverage and simulation over both transports',async t=>{
  const store=new Store(':memory:'),service=await startHttp(new Engine(store),{port:0});
  t.after(async()=>{await service.close();store.close();});
  const base=`http://127.0.0.1:${service.listener.address().port}`;
  for(const kind of ['http','sse']) {
    const client=new Client({name:'coverage-test',version:'1.0.0'});
    const transport=kind==='http'?new StreamableHTTPClientTransport(new URL(`${base}/mcp`)):new SSEClientTransport(new URL(`${base}/sse`));
    try {
      await client.connect(transport);
      const list=await client.listTools();assert.ok(JSON.stringify(list.tools).includes('scheduleStatus'));assert.ok(JSON.stringify(list.tools).includes('unscheduled'));
      const termId=`${kind}-coverage-term`,courseId=`${kind}-missing`;
      const result=await client.callTool({name:'schedule_mutate',arguments:{operations:[
        {op:'put',entity:{kind:'term',id:termId,title:termId,startDate:'2026-09-01',endDate:'2026-12-31',weekOne:'2026-08-31'}},
        {op:'put',entity:{kind:'course',id:courseId,title:'未导入时间的选修',termId,status:'not_selected',enabled:false,scheduleStatus:'unknown',expectedTiming:{startWeek:3},rules:[]}},
      ],returnQuery:{from:'2026-09-14',to:'2026-09-21',simulateEnable:[courseId],views:['agenda','conflicts','unscheduled']}}});
      assert.equal(result.isError,undefined);const q=result.structuredContent.query;
      assert.equal(q.coverage.complete,false);assert.equal(q.simulation.complete,false);assert.equal(q.simulation.targets[0].occurrences,0);assert.equal(q.views.conflicts.length,0);assert.equal(q.views.unscheduled[0].scheduleStatus,'unknown');
      const catalog=await client.callTool({name:'schedule_query',arguments:{views:['catalog'],state:'all',ids:[courseId]}});
      assert.equal(catalog.structuredContent.views.catalog[0].status,'not_selected');assert.equal(catalog.structuredContent.views.catalog[0].enabled,false);
    } finally {if(kind==='http')await transport.terminateSession();await client.close();}
  }
});
