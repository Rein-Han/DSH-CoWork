import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopPairedAdapter } from "../src/host-adapters/desktop-paired/adapter.js";
import type { AuthSession } from "../src/desktop/auth-session.js";
import { BridgeService } from "../src/bridge-service.js";
import { TaskStore } from "../src/task-store.js";
import { EventLedger } from "../src/event-ledger.js";
import { FakeConnection, FakeDshApi } from "./support/fakes.js";

// Actual Desktop wire shapes, intentionally not FakeConnection's legacy empty
// baseline. These transport tests complement (never replace) the live smoke.
function wireFixture() {
  const state = {
    projections: {kind:"sequenced", asOfSeq:3, values:{inbox:{"next-turn":[],"next-step":[]}}} as unknown,
    rows: {type:"rows",jobs:[]} as unknown,
    closed:0, fail:false, requests:[] as string[],
  };
  const session = {
    async call(endpoint: string) { state.requests.push(endpoint); return state.projections; },
    async *openStream(endpoint: string) {
      state.requests.push(endpoint);
      try { if(state.fail) throw new Error("transport lost"); yield {type:"item",streamId:"test",value:state.rows}; }
      finally { state.closed++; }
    },
  } as unknown as AuthSession;
  return {state, adapter:new DesktopPairedAdapter({session,protocolFamily:"dsh-host-0.2",harnessVersion:"0.2.1-rc.2",desktopVersion:"0.2.1-rc.2"})};
}

test("Desktop release evidence reads sequenced inbox and closes the first job rows stream", async () => {
  const {state,adapter}=wireFixture();
  state.rows={type:"rows",jobs:[{id:"old",status:"completed"},{id:"failed",status:"failed"},{id:"killed",status:"killed"}]};
  assert.deepEqual(await adapter.sessionWorkspaceState("root"),{queue:{known:true,asOfSeq:3,pending:0},jobs:{known:true,active:0}});
  assert.equal(state.closed,1);
  assert.deepEqual(state.requests,["session/projections","job/list"]);
  state.projections={kind:"sequenced",asOfSeq:4,values:{inbox:{"next-turn":[{}],"next-step":[{}]}}};
  state.rows={type:"rows",jobs:[{id:"unowned",status:"stopping"},{id:"owned",status:"running"}]};
  const busy=await adapter.sessionWorkspaceState("root");
  assert.equal(busy.queue.pending,2); assert.equal(busy.jobs.active,2);
});

test("missing, cached and malformed Desktop evidence never becomes known empty", async () => {
  const {state,adapter}=wireFixture();
  for(const p of [null,{}, {asOfSeq:3,values:{inbox:{"next-turn":[],"next-step":[]}}}, {kind:"cached",asOfSeq:3,values:{inbox:{"next-turn":[],"next-step":[]}}}, {kind:"sequenced",asOfSeq:3,values:{}}]) {
    state.projections=p;
    assert.equal((await adapter.sessionWorkspaceState("root")).queue.known,false);
  }
  for(const rows of [{}, {type:"rows"}, {type:"rows",jobs:[{id:"new",status:"future-state"}]}]) {
    state.rows=rows;
    assert.equal((await adapter.sessionWorkspaceState("root")).jobs.known,false);
  }
  state.fail=true;
  await assert.rejects(adapter.sessionWorkspaceState("root"),/transport lost/);
  assert.equal(state.closed,9);
});

test("release uses the Desktop adapter with unknown caches; busy, unknown, race, then release and next writer", async () => {
  const home=await mkdtemp(join(tmpdir(),"desktop-release-"));
  const {state,adapter}=wireFixture(); const api=new FakeDshApi();
  const realRead=adapter.sessionWorkspaceState.bind(adapter);
  Object.assign(api,{sessionWorkspaceState:realRead});
  const ledger=new EventLedger(home); const tasks=new TaskStore(home); const connection=new FakeConnection(ledger);
  connection.queue.known=false; connection.jobs.known=false;
  const service=new BridgeService({homeDir:home,hostUrl:"http://127.0.0.1:1",requestTimeoutMs:1000,allowRemoteHost:false},api,tasks,connection,ledger);
  try {
    const task=await service.delegate({cwd:home,prompt:"fixture",workspaceMode:"read-only"});
    const event=async(seq:number,type:string)=>ledger.append(task.taskId,{sourceSessionId:task.rootSessionId,origin:"root",type:"session/event",sourceSeq:seq,raw:{type:"session/event",sessionId:task.rootSessionId,event:{type,seq,time:seq,data:{reason:{kind:"completed"}}}}});
    await event(1,"turn/start"); await event(2,"turn/end"); connection.lineage[0]!.running=false;
    state.rows={type:"rows",jobs:[{id:"job1",status:"running"}]};
    await assert.rejects(service.releaseWorkspace(task.taskId),(e:any)=>e.code==="session_busy");
    state.rows={type:"rows",jobs:[]};
    state.projections={kind:"sequenced",asOfSeq:3,values:{inbox:{"next-turn":[],"next-step":[{id:"queued"}]}}};
    await assert.rejects(service.releaseWorkspace(task.taskId),(e:any)=>e.code==="session_busy");
    state.rows={type:"rows",jobs:[]}; state.projections=null;
    await assert.rejects(service.releaseWorkspace(task.taskId),(e:any)=>e.code==="workspace_state_unknown");
    assert.ok((await service.status(task.taskId)).workspaceClaim);
    state.projections={kind:"sequenced",asOfSeq:3,values:{inbox:{"next-turn":[],"next-step":[]}}};
    Object.assign(api,{sessionWorkspaceState:async(id:string)=>{ const s=await realRead(id); await event(3,"turn/start"); return s; }});
    await assert.rejects(service.releaseWorkspace(task.taskId),(e:any)=>e.code==="stale_view");
    await event(4,"turn/end"); Object.assign(api,{sessionWorkspaceState:realRead});
    const released=await service.releaseWorkspace(task.taskId);
    assert.equal(released.sessionClosedByRelease,false); assert.equal(released.releaseEvidence.source,"desktop-live");
    assert.equal((await service.status(task.taskId)).workspaceClaim,null);
    assert.ok((await ledger.snapshot(task.taskId)).cursor>0);
    api.nextSessionId="next-root";
    const next=await service.delegate({cwd:home,prompt:"second writer",workspaceMode:"exclusive-write"});
    assert.ok(next.taskId!==task.taskId);
    assert.equal(api.calls.some(c=>c.method==="session.cancel"),false);
  } finally { await rm(home,{recursive:true,force:true}); }
});
