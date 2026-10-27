import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp-server.js";
import type { BridgeService } from "../src/bridge-service.js";
import { compactWait, waitWithPolicy, type WaitView } from "../src/wait-policy.js";
import { applyKimiCodeEntry, applyClaudeEntry } from "../src/setup-desktop.js";
import { upsertMcpConfig } from "../src/codex-integration.js";
import { rollbackWaitConfig } from "../src/rollback-wait-profile.js";
import { WaitEvidenceIndex } from "../src/wait-evidence.js";
import type { LedgerRecord } from "../src/event-ledger.js";

const taskId = "dsh_000000000099";
const view: WaitView = {taskId,rootSessionId:"root",cursor:10,availability:"connected",execution:"running",pendingInteractions:[],connection:{revision:1},recovery:{state:"reconciled"}};

test("Desktop standalone defaults do not leak into legacy observation or delegate", async () => {
  for (const profile of ["bounded", "adaptive", "long"] as const) for (const policy of ["desktop", "legacy"] as const) {
    let captured: unknown[] = [];
    const service = {waitCapabilities:()=>({profile,desktopPolicy:policy,maxTimeoutSec:profile==="bounded"?30:profile==="adaptive"?300:900}),
      wait:async (...args: unknown[])=>{captured=args;return {ok:true};},
      observe:async (...args: unknown[])=>({legacyArgs:args})} as unknown as BridgeService;
    const server=createMcpServer(service,{toolProfile:"desktop"}), client=new Client({name:"adaptive-contract",version:"1"});
    const [a,b]=InMemoryTransport.createLinkedPair();
    try {
      await server.connect(a); await client.connect(b);
      const response=await client.callTool({name:"dsh_wait",arguments:{taskId}});
      assert.equal(response.isError,undefined);
      const options=captured[3] as Record<string,unknown>;
      assert.equal(captured[1],policy==="desktop"&&profile!=="bounded"?300:30);
      assert.equal(options.until,policy==="desktop"?"terminal":"change");
      assert.equal(options.responseMode,policy==="desktop"?"compact":"full");
      if(policy==="desktop") assert.equal((response.content as any)[0].text,'{"ok":true}');
      await client.callTool({name:"dsh_wait",arguments:{taskId,until:"change",responseMode:"full"}});
      assert.equal(captured[1],30); assert.equal((captured[3] as any).adaptive,false);
      const observed=await client.callTool({name:"dsh_observe",arguments:{taskId,waitSeconds:2}});
      assert.deepEqual(JSON.parse((observed.content as any)[0].text).legacyArgs,[taskId,null,2]);
    } finally {await client.close();await server.close();}
  }
});

test("compact interaction bodies are bounded with retrievable detail and exact final pointer",()=>{
  const status={...view,pendingInteractions:Array.from({length:40},(_,i)=>({requestId:`q${i}`,payload:{question:"问".repeat(10000)}})),
    finalMessageStatus:"pointer_available",finalMessagePointer:{sessionId:"root",seq:42},finalMessageAfterCursor:41,
    finalMessage:"answer".repeat(20000),recovery:{state:"gap",details:"x".repeat(20000)}};
  const result=compactWait({timedOut:false,wakeReason:"interaction",nextCursor:10,status});
  assert.ok(Buffer.byteLength(JSON.stringify(result))<4096);
  assert.equal(result.pendingInteractionCount,40);assert.ok(result.pendingInteractionDetails);
  assert.deepEqual(result.finalMessagePointer,{sessionId:"root",seq:42});assert.equal(result.finalMessageAfterCursor,41);
  assert.equal(result.finalMessage,undefined);
});

test("acknowledged unchanged fault waits internally; new critical state still wakes",async t=>{
  const disconnected={...view,availability:"host_unreachable"};
  const first=await waitWithPolicy({timeoutSec:60,options:{until:"terminal"},read:async()=>disconnected,wait:async()=>assert.fail()});
  let now=0,iterations=0; t.mock.method(performance,"now",()=>now);
  const again=await waitWithPolicy({timeoutSec:60,options:{until:"terminal",acknowledgedWakeKey:first.wakeKey!},read:async()=>disconnected,
    wait:async(_c,_r,remaining)=>{iterations++;now+=remaining;}});
  assert.equal(again.wakeReason,"timeout");assert.equal(iterations,1);assert.equal(now,60000);
  now=0;
  const changed=await waitWithPolicy({timeoutSec:300,options:{until:"terminal",acknowledgedWakeKey:first.wakeKey!},
    read:async()=>now?{...view,pendingInteractions:[{requestId:"new"}]}:disconnected,wait:async()=>{now=1000;}});
  assert.equal(changed.wakeReason,"interaction");assert.notEqual(changed.wakeKey,first.wakeKey);
});

test("adaptive timeout margins preserve larger client settings and sibling fields",()=>{
  for(const [apply,key] of [[applyKimiCodeEntry,"toolTimeoutMs"],[applyClaudeEntry,"timeout"]] as const) {
    for(const prior of [90000,1200000]) {
      const old={mcpServers:{dsh_desktop:{[key]:prior,custom:true,env:{OTHER:"keep"}},other:{command:"keep"}}};
      const entry={command:"node",env:{DSH_WAIT_PROFILE:"adaptive"}};
      const merged=apply(JSON.stringify(old),entry), value=JSON.parse(merged);
      assert.equal(value.mcpServers.dsh_desktop[key],Math.max(prior,360000));
      assert.equal(value.mcpServers.dsh_desktop.custom,true);assert.equal(value.mcpServers.dsh_desktop.env.OTHER,"keep");
      assert.deepEqual(value.mcpServers.other,old.mcpServers.other);assert.equal(apply(merged,entry),merged);
    }
  }
});

test("legacy installer catches root inline and escaped tables without confusing unrelated scope",()=>{
  const block='[mcp_servers.dsh_agentlink]\ncommand="new"';
  for(const root of ['mcp_servers = {}', '"mcp_servers" = { other = {} }', '"mcp_servers"."dsh_agentlink" = {}']) assert.throws(()=>upsertMcpConfig(root,block,true),/inline\/dotted/);
  const unrelated='[proxy]\nmcp_servers.dsh_agentlink = { command="keep" }\n';
  assert.ok(upsertMcpConfig(unrelated,block,true).includes(unrelated.trim()));
  const replaced=upsertMcpConfig('["mcp_servers"."dsh_\\u0061gentlink"]\ncommand="old"\n',block,true);
  assert.equal(replaced.trim(),block);assert.ok(!replaced.includes('"old"'));
});

test("adaptive rollback restores only owned margins and preserves later changes",()=>{
  const before=JSON.stringify({mcpServers:{dsh_desktop:{toolTimeoutMs:70000,env:{OTHER:"keep"}}}});
  const installed=applyKimiCodeEntry(before,{command:"node",env:{DSH_WAIT_PROFILE:"adaptive"}});
  const current=JSON.parse(installed);current.mcpServers.dsh_desktop.env.OTHER="edited";
  const restored=JSON.parse(rollbackWaitConfig("kimi-code",JSON.stringify(current),before,"adaptive"));
  assert.equal(restored.mcpServers.dsh_desktop.toolTimeoutMs,70000);
  assert.equal(restored.mcpServers.dsh_desktop.env.OTHER,"edited");
  assert.equal(restored.mcpServers.dsh_desktop.env.DSH_WAIT_PROFILE,undefined);
  current.mcpServers.dsh_desktop.env.DSH_WAIT_PROFILE="long";
  assert.equal(rollbackWaitConfig("kimi-code",JSON.stringify(current),before,"adaptive"),JSON.stringify(current));
});

test("old ledger outcomes cannot be misclassified as uninterrupted failures",()=>{
  const records=[true,true,undefined,true].map((error,i)=>({cursor:i+1,mergeIndex:i+1,observedAt:new Date().toISOString(),sourceSessionId:"root",origin:"root",type:"session/event",coordination:{event:{type:"tool/result",data:error===undefined?{}:{error}}}} as LedgerRecord));
  const index=new WaitEvidenceIndex();index.update(records);assert.equal(index.issue,undefined);
});
