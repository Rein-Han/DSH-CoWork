import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {BridgeService} from "../src/bridge-service.js";
import {EventLedger} from "../src/event-ledger.js";
import {TaskStore} from "../src/task-store.js";
import {DshConnectionManager} from "../src/connection-manager.js";
import {FakeConnection,FakeDshApi} from "./support/fakes.js";

async function fixture() {
  const home=await mkdtemp(join(tmpdir(),"dsh-p2-"));const api=new FakeDshApi();
  const tasks=new TaskStore(home);const ledger=new EventLedger(home);const connection=new FakeConnection(ledger);
  const config={homeDir:home,hostUrl:"http://127.0.0.1:1",requestTimeoutMs:1000,allowRemoteHost:false};
  const service=new BridgeService(config,api,tasks,connection,ledger);
  const task=await service.delegate({cwd:home,prompt:"fixture"});let seq=0;
  const event=async(type:string,data:unknown={},sessionId=task.rootSessionId)=>ledger.append(task.taskId,{sourceSessionId:sessionId,origin:sessionId===task.rootSessionId?"root":"subagent",sourceSeq:++seq,type:"session/event",raw:{type:"session/event",sessionId,event:{type,seq,time:seq,data}}});
  return {home,api,tasks,ledger,connection,config,service,task,event};
}
const end={reason:{kind:"completed"}};

test("P2 steer is refused when idle or when its active turn changes during preflight",async()=>{
  const f=await fixture();try {
    f.connection.lineage[0]!.running=false;
    const count=()=>f.api.calls.filter(c=>c.method==="session.prompt").length;
    const before=count();
    await assert.rejects(f.service.continueTask(f.task.taskId,"idle steer","steer"),(e:any)=>e.code==="stale_view");assert.equal(count(),before);
    f.connection.lineage[0]!.running=true;await f.event("turn/start");
    const original=f.api.sessionModels.bind(f.api);
    f.api.sessionModels=async(id:string)=>{await f.event("turn/end",end);await f.event("turn/start");return original(id);};
    await assert.rejects(f.service.continueTask(f.task.taskId,"racing steer","steer"),(e:any)=>e.code==="stale_view");assert.equal(count(),before);
    f.api.sessionModels=original;
    assert.equal((await f.service.continueTask(f.task.taskId,"valid steer","steer")).accepted,true);
  }finally{await rm(f.home,{recursive:true,force:true});}
});

test("P2 mixed external input is ambiguous even when the expected prompt is present",async()=>{
  const f=await fixture();try{
    const receipt=await f.service.continueTask(f.task.taskId,"next","queue");
    await f.event("turn/start");await f.event("user/message",{source:{rpcId:receipt.issuedRpcId}});
    await f.event("user/message",{source:{rpcId:"manual-input"}});await f.event("turn/end",end);
    await assert.rejects(f.service.wait(f.task.taskId,0,undefined,{until:"terminal",...receipt.waitTarget}),(e:any)=>e.code==="ambiguous_wait_target");
  }finally{await rm(f.home,{recursive:true,force:true});}
});

test("P2 input before turn/start and acknowledged steering retain correct result ownership",async()=>{
  const f=await fixture();try{
    const receipt=await f.service.continueTask(f.task.taskId,"next","queue");
    await f.event("user/message",{source:{rpcId:receipt.issuedRpcId}});await f.event("turn/start");
    const steer=await f.service.continueTask(f.task.taskId,"guide","steer");
    await f.event("user/message",{source:{rpcId:steer.issuedRpcId}});await f.event("turn/end",end);
    const result:any=await f.service.wait(f.task.taskId,0,undefined,{until:"terminal",...receipt.waitTarget});
    assert.equal(result.wakeReason,"terminal");
  }finally{await rm(f.home,{recursive:true,force:true});}
});

test("P2 two service waiters cancel independently; final survives restart and two readers",async()=>{
  const f=await fixture();try{
    const receipt=await f.service.continueTask(f.task.taskId,"next","queue");
    const controller=new AbortController();
    const opts={until:"terminal" as const,responseMode:"compact" as const,...receipt.waitTarget};
    const canceled=f.service.wait(f.task.taskId,2,undefined,{...opts,signal:controller.signal});
    const rejected=assert.rejects(canceled);
    const survivor=f.service.wait(f.task.taskId,2,undefined,opts);
    controller.abort();await rejected;
    await f.event("turn/start");await f.event("user/message",{source:{rpcId:receipt.issuedRpcId}});
    await f.event("assistant/message",{content:"owned-result"});await f.event("turn/end",end);f.connection.lineage[0]!.running=false;
    assert.equal((await survivor).wakeReason,"terminal");
    assert.equal(f.api.calls.some(c=>c.method==="session.cancel"||c.method==="session.updateQueue"),false);
    // All observers gone; another complete run is persisted before a new reader exists.
    const next=await f.service.continueTask(f.task.taskId,"after observers","queue");
    await f.event("turn/start");await f.event("user/message",{source:{rpcId:next.issuedRpcId}});
    await f.event("assistant/message",{content:"recovered-result"});await f.event("turn/end",end);
    const reloaded=new EventLedger(f.home);const restored=new BridgeService(f.config,f.api,f.tasks,f.connection,reloaded);
    const result:any=await restored.wait(f.task.taskId,0,undefined,{until:"terminal",responseMode:"compact",...next.waitTarget});
    assert.equal(result.wakeReason,"terminal");assert.equal(typeof result.finalMessageAfterCursor,"number");
    const a=await reloaded.tail(f.task.taskId,result.finalMessageAfterCursor,1,4096);
    const b=await new EventLedger(f.home).tail(f.task.taskId,result.finalMessageAfterCursor,1,4096);
    assert.deepEqual(a,b);assert.equal(a.records[0]?.sourceSeq,result.finalMessagePointer.seq);
  }finally{await rm(f.home,{recursive:true,force:true});}
});

test("P2 real manager ignores another task revision before and during registration",async()=>{
  const home=await mkdtemp(join(tmpdir(),"dsh-p2-manager-"));const ledger=new EventLedger(home);const tasks=new TaskStore(home);const api=new FakeDshApi();
  const a=await tasks.create("a");const b=await tasks.create("b");
  api.sessions=[{sessionId:"a",updatedAt:1,running:true,blank:false},{sessionId:"b",updatedAt:1,running:true,blank:false}];
  const manager=new DshConnectionManager({homeDir:home,hostUrl:"http://127.0.0.1:1",requestTimeoutMs:1000,allowRemoteHost:false},api,tasks,ledger);
  try{
    await manager.refreshLineage();
    const revision=manager.observationRevisionForTask(a.taskId);const snapshot=await ledger.snapshot(a.taskId);
    api.sessions[1]!.running=false;await manager.refreshLineage();
    assert.equal(manager.observationRevisionForTask(a.taskId),revision);
    assert.ok(manager.snapshot().revision>revision);
    const waiting=manager.waitForTaskChange(a.taskId,snapshot.cursor,revision,80);
    api.sessions[1]!.running=true;await manager.refreshLineage();
    assert.equal((await waiting).timedOut,true);
    // Cancellation removes only one manager waiter. The second observes a durable event.
    const c=new AbortController();const p1=manager.waitForTaskChange(a.taskId,snapshot.cursor,revision,2000,c.signal);const rejected=assert.rejects(p1);
    const p2=manager.waitForTaskChange(a.taskId,snapshot.cursor,revision,2000);
    c.abort();await rejected;
    await ledger.append(a.taskId,{sourceSessionId:"a",type:"bridge/test-marker",raw:{}});
    assert.equal((await p2).timedOut,false);
    assert.equal((manager as any).waiters.size,0);
  }finally{await manager.stop();await rm(home,{recursive:true,force:true});}
});

test("P2 ledger closes the initial snapshot/registration lost-wakeup boundary",async()=>{
  const home=await mkdtemp(join(tmpdir(),"dsh-p2-race-"));const ledger=new EventLedger(home);const task=await new TaskStore(home).create("root");
  const original=(ledger as any).readLocked.bind(ledger);let injected=false;
  (ledger as any).readLocked=async(id:string)=>{
    const state=await original(id);
    if(!injected){injected=true;await new EventLedger(home).append(id,{sourceSessionId:"root",type:"bridge/test-marker",raw:{}});}
    return state;
  };
  try{
    const start=performance.now();await ledger.waitForCursor(task.taskId,0,2000);
    assert.ok(performance.now()-start<800,"must detect the event at registration, before the 1000ms cross-process poll");
  }finally{await rm(home,{recursive:true,force:true});}
});
