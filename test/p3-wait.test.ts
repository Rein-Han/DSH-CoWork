import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp, rm, readFile, writeFile, appendFile, rename, stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
import {EventLedger} from "../src/event-ledger.js";
import {TaskStore} from "../src/task-store.js";
import {BridgeService} from "../src/bridge-service.js";
import {createMcpServer} from "../src/mcp-server.js";
import {waitWithPolicy, type WaitView} from "../src/wait-policy.js";
import {applyClaudeEntry, applyCodexTable, renderCodexBlock} from "../src/setup-desktop.js";
import {rollbackWaitConfig} from "../src/rollback-wait-profile.js";
import {FakeDshApi, FakeConnection} from "./support/fakes.js";

const taskId = "dsh_000000000013";
const turn = (seq: number, type = "tool/result") => ({sourceSessionId:"root",sourceSeq:seq,origin:"root" as const,type:"session/event",raw:{type:"session/event",sessionId:"root",event:{type,seq,time:seq,data:{}}}});
const view = (cursor: number, done = false): WaitView => ({taskId,rootSessionId:"root",cursor,availability:"connected",execution:done?"turn_completed":"running",pendingInteractions:[],connection:{revision:cursor},recovery:{state:"reconciled"}});
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test("P3: 10 virtual minutes / 1000 ordinary events require exactly one terminal wait", async t => {
  let now = 0; let events = 0; let reads = 0;
  t.mock.method(performance, "now", () => now);
  const result = await waitWithPolicy({timeoutSec:900,options:{until:"terminal"},read:async()=>{reads++;return view(events,events===1000);},wait:async()=>{events++;now+=600;}});
  assert.equal(result.wakeReason,"terminal");assert.equal(now,600000);assert.equal(reads,1001);
});

test("P3: incremental locked reads preserve restart/dedupe and detect replacement/truncation/corruption", async () => {
  const home=await mkdtemp(join(tmpdir(),"dsh-p3-ledger-"));
  try {
    const a=new EventLedger(home), b=new EventLedger(home);
    for(let i=0;i<40;i++){await a.append(taskId,turn(i));assert.equal((await b.snapshot(taskId)).cursor,i+1);}
    assert.ok(a.observationDiagnostics().fullScans<=1);assert.equal(b.observationDiagnostics().fullScans,1);assert.equal(b.observationDiagnostics().recordsRead,40);
    const snap=await b.snapshot(taskId), path=snap.logPath;
    assert.deepEqual(await new EventLedger(home).snapshot(taskId),snap);
    assert.equal(await b.append(taskId,turn(39)),undefined);
    const original=await readFile(path,"utf8");
    await rename(path,`${path}.saved`);await writeFile(path,original);
    assert.equal((await b.snapshot(taskId)).cursor,40);assert.equal(b.observationDiagnostics().fullScans,2);
    await writeFile(path,original.split("\n")[0]+"\n");assert.equal((await b.snapshot(taskId)).cursor,1);
    await appendFile(path,'{"cursor":');await assert.rejects(b.snapshot(taskId),/incomplete trailing record/);
    await writeFile(path,original);assert.equal((await b.snapshot(taskId)).cursor,40);
    const changed=JSON.parse(original.split("\n")[0]!);changed.cursor=9;changed.mergeIndex=9;
    await writeFile(path,JSON.stringify(changed)+"\n");await assert.rejects(b.snapshot(taskId),/cursor gap/);
  }finally{await rm(home,{recursive:true,force:true});}
});

test("P3: four observers share one poller; abort/deadline release all request resources", async () => {
  const home=await mkdtemp(join(tmpdir(),"dsh-p3-observers-"));
  try {
    const ledger=new EventLedger(home);await ledger.append(taskId,turn(0));
    const controllers=Array.from({length:4},()=>new AbortController());
    const waits=controllers.map(c=>ledger.waitForCursor(taskId,1,3000,c.signal));
    const settled=Promise.allSettled(waits);
    // Read registrations use file locks, so allow them to drain before measuring.
    for(let i=0;i<100&&ledger.observationDiagnostics().waiters<4;i++)await new Promise(r=>setTimeout(r,10));
    assert.equal(ledger.observationDiagnostics().waiters,4);assert.equal(ledger.observationDiagnostics().pollers,1);
    controllers[0]!.abort();await new EventLedger(home).append(taskId,turn(1));
    const result=await settled;assert.equal(result.filter(r=>r.status==="fulfilled").length,3);
    assert.equal(ledger.observationDiagnostics().waiters,0);assert.equal(ledger.observationDiagnostics().pollers,0);assert.ok(ledger.observationDiagnostics().pollChecks<=2);
    await ledger.waitForCursor(taskId,2,20);assert.equal(ledger.observationDiagnostics().pollers,0);
  }finally{await rm(home,{recursive:true,force:true});}
});

test("P3: progress is token-only, monotonic, throttled and stops on completion/cancel", async t => {
  let now=0; t.mock.method(performance,"now",()=>now);
  t.mock.timers.enable({apis:["setTimeout"]});
  const observers=new Set<()=>void>();let done=false;
  const service = {waitCapabilities:()=>({maxTimeoutSec:900}),wait:async (_id:string,seconds:number,_cursor:unknown,options:any)=>waitWithPolicy({timeoutSec:seconds,options,read:async()=>view(0,done),wait:async(_c,_r,ms,signal)=>new Promise<void>(resolve=>{const finish=()=>{clearTimeout(timer);observers.delete(finish);signal.removeEventListener("abort",finish);resolve();};const timer=setTimeout(finish,ms);observers.add(finish);signal.addEventListener("abort",finish,{once:true});})})} as unknown as BridgeService;
  const server=createMcpServer(service,{toolProfile:"desktop"});const client=new Client({name:"p3-progress",version:"1"});const [a,b]=InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);await client.connect(b);
    const progress:number[]=[];
    const one=client.callTool({name:"dsh_wait",arguments:{taskId,timeoutSec:900,until:"terminal"}},undefined,{timeout:960000,onprogress:p=>progress.push(p.progress)});
    const controller=new AbortController();const two=client.callTool({name:"dsh_wait",arguments:{taskId,timeoutSec:900,until:"terminal"}},undefined,{timeout:960000,signal:controller.signal});const rejected=assert.rejects(two);
    await flush();now=29999;t.mock.timers.tick(29999);await flush();assert.equal(progress.length,0);
    now=30000;t.mock.timers.tick(1);await flush();assert.deepEqual(progress,[30]);
    now=60000;t.mock.timers.tick(30000);await flush();assert.deepEqual(progress,[30,60]);
    controller.abort();await rejected;await flush();assert.equal(observers.size,1);
    done=true;for(const fn of [...observers])fn();await one;assert.equal(observers.size,0);
    now=120000;t.mock.timers.tick(60000);await flush();assert.deepEqual(progress,[30,60]);
  }finally{await client.close();await server.close();}
});

test("P3: cancel/deadline abort in-flight synchronization signal without canceling execution", async()=>{
  for(const cancel of [false,true]){
    const controller=new AbortController();let aborted=false;
    const pending=waitWithPolicy({timeoutSec:0.05,options:{signal:controller.signal},read:async(_initial,signal)=>new Promise<WaitView>((_resolve,reject)=>{signal.addEventListener("abort",()=>{aborted=true;reject(signal.reason);},{once:true});}),wait:async()=>assert.fail()});
    if(cancel)setTimeout(()=>controller.abort(),10);
    await assert.rejects(pending);assert.equal(aborted,true);
  }
});

test("P3: long schema accepts 900 terminal only; defaults remain 30 and errors never clamp",async()=>{
  const home=await mkdtemp(join(tmpdir(),"dsh-p3-schema-"));const api=new FakeDshApi(),ledger=new EventLedger(home),connection=new FakeConnection(ledger);
  const service=new BridgeService({homeDir:home,hostUrl:"http://127.0.0.1:3080",requestTimeoutMs:1000,allowRemoteHost:false,waitProfile:"long"},api,new TaskStore(home),connection,ledger);
  const task=await service.delegate({cwd:home,prompt:"test",waitSeconds:0});
  const server=createMcpServer(service,{toolProfile:"desktop"}),client=new Client({name:"p3-schema",version:"1"});const [a,b]=InMemoryTransport.createLinkedPair();
  try{
    await server.connect(a);await client.connect(b);connection.state.availability="host_unreachable";
    const call=(args:Record<string,unknown>)=>client.callTool({name:"dsh_wait",arguments:{taskId:task.taskId,...args}});
    assert.equal((await call({timeoutSec:900,until:"terminal"})).isError,undefined);
    assert.equal((await call({timeoutSec:31})).isError,true);assert.equal((await call({timeoutSec:901,until:"terminal"})).isError,true);
    assert.equal(service.waitCapabilities().defaults.timeoutSec,30);assert.equal(service.waitCapabilities().clientLongWaitVerified,false);
  }finally{await client.close();await server.close();await rm(home,{recursive:true,force:true});}
});

test("P3: per-server timeouts, repeat install and field-only rollback preserve user changes",()=>{
  const before='[mcp_servers.dsh_desktop]\ncommand = "node"\nargs = []\ntool_timeout_sec = 180 # custom\nenv = { DSH_WAIT_PROFILE = "bounded", CUSTOM = "keep" }\n\n[mcp_servers.other]\ncommand = "other"\n';
  const block=renderCodexBlock("node","entry.js",{DSH_WAIT_PROFILE:"long"});const installed=applyCodexTable(before,block);
  assert.equal(applyCodexTable(installed,block),installed);assert.match(installed,/tool_timeout_sec = 960/);
  const restored=rollbackWaitConfig("codex",installed.replace('CUSTOM = "keep"','CUSTOM = "edited"'),before);assert.match(restored,/tool_timeout_sec = 180 # custom/);assert.match(restored,/CUSTOM = "edited"/);assert.match(restored,/DSH_WAIT_PROFILE = "bounded"/);assert.match(restored,/command = "other"/);
  assert.match(rollbackWaitConfig("codex",installed.replace("tool_timeout_sec = 960","tool_timeout_sec = 1200"),before),/tool_timeout_sec = 1200/);
  const json=JSON.stringify({mcpServers:{dsh_desktop:{command:"node",timeout:180000,custom:true,env:{DSH_WAIT_PROFILE:"bounded",CUSTOM:"keep"}},other:{command:"other"}}});
  const entry={command:"node",env:{DSH_WAIT_PROFILE:"long"}};const long=applyClaudeEntry(json,entry);assert.equal(applyClaudeEntry(long,entry),long);assert.equal(JSON.parse(long).mcpServers.dsh_desktop.timeout,960000);
  const current=JSON.parse(long);current.mcpServers.dsh_desktop.env.CUSTOM="edited";
  const rollback=JSON.parse(rollbackWaitConfig("claude",JSON.stringify(current),json));assert.equal(rollback.mcpServers.dsh_desktop.timeout,180000);assert.equal(rollback.mcpServers.dsh_desktop.env.CUSTOM,"edited");assert.equal(rollback.mcpServers.dsh_desktop.custom,true);
  current.mcpServers.dsh_desktop.timeout=1200000;assert.equal(JSON.parse(rollbackWaitConfig("claude",JSON.stringify(current),json)).mcpServers.dsh_desktop.timeout,1200000);
  const absent=JSON.stringify({mcpServers:{dsh_desktop:{command:"node",env:{CUSTOM:"keep"}}}});
  const reverted=JSON.parse(rollbackWaitConfig("claude",applyClaudeEntry(absent,entry),absent));assert.equal(reverted.mcpServers.dsh_desktop.timeout,undefined);assert.equal(reverted.mcpServers.dsh_desktop.env.DSH_WAIT_PROFILE,undefined);
});

test("P3: resource matrix 0/100/1000 events x 1/4 waiters uses local views and incremental disk reads", async t=>{
  for(const events of [0,100,1000])for(const readers of [1,4]){
    const home=await mkdtemp(join(tmpdir(),"dsh-p3-matrix-"));
    try{
      const api=new FakeDshApi(),ledger=new EventLedger(home),connection=new FakeConnection(ledger);
      const service=new BridgeService({homeDir:home,hostUrl:"http://127.0.0.1:3080",requestTimeoutMs:1000,allowRemoteHost:false,waitProfile:"long"},api,new TaskStore(home),connection,ledger);
      const task=await service.delegate({cwd:home,prompt:"test",waitSeconds:0});let seq=0;
      const writer=new EventLedger(home);
      const event=async(type:string)=>{const input=turn(seq++,type);input.sourceSessionId=task.rootSessionId;input.raw.sessionId=task.rootSessionId;await writer.append(task.taskId,input);};
      connection.waitForTaskChange=async(id,cursor,_revision,ms,signal?:AbortSignal)=>{await ledger.waitForCursor(id,cursor,ms,signal);return {timedOut:false,connection:connection.snapshot(),ledger:await ledger.snapshot(id)};};
      await event("turn/start");const baseline=api.calls.length;const start=performance.now();
      const waits=Array.from({length:readers},()=>service.wait(task.taskId,900,undefined,{until:"terminal",responseMode:"compact"}));
      for(let i=0;i<100&&ledger.observationDiagnostics().waiters<readers;i++)await new Promise(r=>setTimeout(r,5));
      for(let i=0;i<events;i++)await event("tool/result");
      connection.lineage[0]!.running=false;await event("turn/end");
      const results=await Promise.all(waits);for(const result of results)assert.equal((result as any).wakeReason,"terminal");
      const metrics=ledger.observationDiagnostics();assert.equal(metrics.waiters,0);assert.equal(metrics.pollers,0);assert.ok(metrics.fullScans<=1);assert.ok(api.calls.length-baseline<=readers*2,`remote calls ${api.calls.length-baseline}`);
      const size=(await stat((await ledger.snapshot(task.taskId)).logPath)).size;
      t.diagnostic(JSON.stringify({events,readers,elapsedMs:performance.now()-start,remoteCalls:api.calls.length-baseline,fileBytes:size,metrics,rss:process.memoryUsage().rss}));
    }finally{await rm(home,{recursive:true,force:true});}
  }
});
