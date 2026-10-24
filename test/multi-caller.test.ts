import assert from "node:assert/strict";
import {mkdtemp,readFile,writeFile,mkdir,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
import {applyZcodeEntry,applyKimiCodeEntry,buildPlan,applyPlan,parseArgs,kimiCodeConfigPath,skillTarget,bridgeEnvironment} from "../src/setup-desktop.js";
import {loadConfig} from "../src/config.js";
import {observeVerification,type VerificationCall} from "../src/caller-verification.js";

test("new callers preserve same-entry settings and environment through install/update/uninstall",()=>{
  for(const caller of ["zcode","kimi-code"] as const){
    const old={command:"old",args:["old.js"],enabled:false,enabledTools:["dsh_status"],timeout:90000,toolTimeoutMs:70000,custom:{keep:true},env:{CUSTOM:"keep",DSH_WAIT_PROFILE:"bounded"}};
    const other={command:"other"};
    const input=caller==="zcode"?{plugins:{enabled:true},mcp:{enabled:true,servers:{dsh_desktop:old,other}}}:{theme:"dark",mcpServers:{dsh_desktop:old,other}};
    const apply=caller==="zcode"?applyZcodeEntry:applyKimiCodeEntry;
    const entry={command:"new",args:["new.js"],env:bridgeEnvironment("connection.json",caller)};
    const once=apply(JSON.stringify(input),entry);assert.equal(apply(once,entry),once);
    const parsed=JSON.parse(once);const table=caller==="zcode"?parsed.mcp.servers:parsed.mcpServers;
    assert.equal(table.dsh_desktop.command,"new");assert.equal(table.dsh_desktop.env.CUSTOM,"keep");
    assert.equal(table.dsh_desktop.enabled,false);assert.deepEqual(table.dsh_desktop.enabledTools,["dsh_status"]);
    assert.deepEqual(table.dsh_desktop.custom,{keep:true});assert.equal(table.dsh_desktop.toolTimeoutMs,70000);assert.deepEqual(table.other,other);
    const removed=JSON.parse(apply(once,undefined));assert.equal((caller==="zcode"?removed.mcp.servers:removed.mcpServers).dsh_desktop,undefined);
    for(const bad of [null,[],"invalid"]){
      const config=caller==="zcode"?{mcp:{servers:{dsh_desktop:{env:bad}}}}:{mcpServers:{dsh_desktop:{env:bad}}};
      assert.throws(()=>apply(JSON.stringify(config),entry),/env/);
    }
  }
});

test("new caller long waits are rejected by both installer and runtime, both remains two callers",async()=>{
  for(const caller of ["zcode","kimi-code","kimi-work"] as const){
    assert.throws(()=>parseArgs(["--caller",caller,"--wait-profile","long"]),/bounded/);
    assert.throws(()=>loadConfig({DSH_CALLER_KIND:caller,DSH_WAIT_PROFILE:"long"}),/bounded/);
    assert.equal(loadConfig({DSH_CALLER_KIND:caller}).callerKind,caller);
    assert.equal(bridgeEnvironment("c",caller).DSH_WAIT_PROFILE,"bounded");
    await assert.rejects(()=>buildPlan({...parseArgs(["--caller",caller]),waitProfile:"long"}),/bounded/);
  }
  assert.equal(parseArgs(["--caller","both"]).caller,"both");
  assert.throws(()=>parseArgs(["--caller","kimi-work","--scope","project"]),/no project/);
  assert.throws(()=>parseArgs(["--caller","kimi-work","--uninstall"]),/client/);
  assert.throws(()=>parseArgs(["--caller","kimi-code","--output","out"]),/only/);
});

test("Kimi Code honors KIMI_CODE_HOME but project scope remains separate",()=>{
  const before=process.env.KIMI_CODE_HOME;const custom=join(tmpdir(),"isolated-kimi-home");
  try{process.env.KIMI_CODE_HOME=custom;
    assert.equal(kimiCodeConfigPath("user","project"),join(custom,"mcp.json"));
    assert.equal(skillTarget("kimi-code","user","project"),join(custom,"skills","kimi-code-dsh-desktop"));
    assert.equal(kimiCodeConfigPath("project","project"),join("project",".kimi-code","mcp.json"));
  }finally{if(before===undefined)delete process.env.KIMI_CODE_HOME;else process.env.KIMI_CODE_HOME=before;}
});

test("Kimi Code project installation is idempotent, detects plan races and removes only its entry",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"cowork-kimi-install-"));const before=process.env.DSH_CONNECTION_FILE;
  try{
    process.env.DSH_CONNECTION_FILE=join(dir,"connection.json");await writeFile(process.env.DSH_CONNECTION_FILE,"{}");
    const options=parseArgs(["--caller","kimi-code","--scope","project","--project",dir,"--apply"]);
    const plan=await buildPlan(options);assert.deepEqual((await applyPlan(plan)).refused,[]);
    const path=join(dir,".kimi-code","mcp.json");const config=JSON.parse(await readFile(path,"utf8"));
    assert.equal(config.mcpServers.dsh_desktop.env.DSH_CALLER_KIND,"kimi-code");assert.equal(config.mcpServers.dsh_desktop.toolTimeoutMs,120000);
    assert.equal((await applyPlan(await buildPlan(options))).changed.length,0);
    const stale=await buildPlan({...options,entry:"changed.js",replace:true});await writeFile(path,JSON.stringify({...config,userEdited:true}));
    await assert.rejects(()=>applyPlan(stale),/changed after planning/);
    config.mcpServers.other={command:"other"};await writeFile(path,JSON.stringify(config));
    assert.deepEqual((await applyPlan(await buildPlan({...options,uninstall:true}))).refused,[]);
    assert.deepEqual(JSON.parse(await readFile(path,"utf8")).mcpServers,{other:{command:"other"}});
  }finally{if(before===undefined)delete process.env.DSH_CONNECTION_FILE;else process.env.DSH_CONNECTION_FILE=before;await rm(dir,{recursive:true,force:true});}
});

test("Kimi Work export separates MCP settings from skill-only manifest and never writes a guessed client config",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"cowork-work-export-"));const before=process.env.DSH_CONNECTION_FILE;
  try{
    process.env.DSH_CONNECTION_FILE=join(dir,"connection.json");await writeFile(process.env.DSH_CONNECTION_FILE,"{}");
    const out=join(dir,"handoff");const options=parseArgs(["--caller","kimi-work","--output",out,"--apply"]);
    const plan=await buildPlan(options);assert.equal(plan.writes.every(x=>x.target.startsWith(out)),true);
    assert.deepEqual((await applyPlan(plan)).refused,[]);
    const manifest=JSON.parse(await readFile(join(out,"kimi.plugin.json"),"utf8"));assert.equal("mcpServers" in manifest,false);
    const settings=JSON.parse(await readFile(join(out,"mcp-settings.json"),"utf8"));
    assert.equal(settings.mcpServers.dsh_desktop.transport,"stdio");assert.equal(settings.mcpServers.dsh_desktop.env.DSH_CALLER_KIND,"kimi-work");
    assert.equal(settings.mcpServers.dsh_desktop.env.DSH_WAIT_PROFILE,"bounded");
    assert.ok((await readFile(join(out,"skills","kimi-work-dsh-desktop","SKILL.md"),"utf8")).length>0);
    assert.equal((await applyPlan(await buildPlan(options))).changed.length,0);
  }finally{if(before===undefined)delete process.env.DSH_CONNECTION_FILE;else process.env.DSH_CONNECTION_FILE=before;await rm(dir,{recursive:true,force:true});}
});

test("refusing a different caller config does not install its skill",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"cowork-kimi-refuse-"));const before=process.env.DSH_CONNECTION_FILE;
  try{
    process.env.DSH_CONNECTION_FILE=join(dir,"connection.json");await writeFile(process.env.DSH_CONNECTION_FILE,"{}");
    await mkdir(join(dir,".kimi-code"));await writeFile(join(dir,".kimi-code","mcp.json"),JSON.stringify({mcpServers:{dsh_desktop:{command:"custom"}}}));
    const plan=await buildPlan(parseArgs(["--caller","kimi-code","--scope","project","--project",dir,"--apply"]));
    const result=await applyPlan(plan);assert.equal(result.refused.length,1);assert.equal(result.changed.length,0);
    await assert.rejects(()=>readFile(join(dir,".kimi-code","skills","kimi-code-dsh-desktop","SKILL.md")),{code:"ENOENT"});
  }finally{if(before===undefined)delete process.env.DSH_CONNECTION_FILE;else process.env.DSH_CONNECTION_FILE=before;await rm(dir,{recursive:true,force:true});}
});

const pointer={sessionId:"session",seq:12};
const waitResult=(execution:string)=>({execution,availability:"connected",nextCursor:20,pendingInteractions:[],finalMessagePointer:pointer});
test("SDK verifier binds the receipt, resumes nextCursor and reads one complete result before normal release",async()=>{
  const calls:Array<{name:string;args:Record<string,unknown>}>=[];let waits=0;
  const call:VerificationCall=async(name,args)=>{calls.push({name,args});if(name==="dsh_wait")return ++waits===1?{...waitResult("running"),nextCursor:15}:waitResult("turn_completed");if(name==="dsh_status")return {execution:"turn_completed",finalMessagePointer:pointer,finalMessage:"OK"};return {released:true};};
  const result=await observeVerification(call,"task",10);assert.equal(result.finalMessage,"OK");
  assert.deepEqual(calls.map(x=>x.name),["dsh_wait","dsh_wait","dsh_status","dsh_release_workspace"]);
  assert.equal(calls[1]!.args.sinceCursor,15);assert.equal(calls[0]!.args.until,"terminal");assert.equal(calls[0]!.args.responseMode,"compact");assert.equal(calls[1]!.args.targetStartAfterCursor,10);
});

test("SDK verifier treats canceled as terminal and releases once without polling",async()=>{
  const names:string[]=[];const call:VerificationCall=async(name)=>{names.push(name);return name==="dsh_wait"?waitResult("canceled"):{released:true};};
  assert.equal((await observeVerification(call,"task",10)).execution,"canceled");assert.deepEqual(names,["dsh_wait","dsh_release_workspace"]);
});

test("SDK verifier preserves claim on interaction, unavailable or wrong-run results",async()=>{
  for(const kind of ["approval","offline","wrong-run"]){const names:string[]=[];
    const call:VerificationCall=async(name)=>{names.push(name);if(name==="dsh_wait")return kind==="approval"?waitResult("awaiting_approval"):kind==="offline"?{...waitResult("running"),availability:"host_unreachable"}:waitResult("turn_completed");return {execution:"turn_completed",finalMessagePointer:{...pointer,seq:999},finalMessage:"OLD"};};
    await assert.rejects(()=>observeVerification(call,"task",10));assert.equal(names.includes("dsh_release_workspace"),false);
  }
});

test("SDK verifier stops at its observation budget without canceling or resending",async()=>{
  let clock=0;const names:string[]=[];
  const call:VerificationCall=async(name)=>{names.push(name);clock=180001;return waitResult("running");};
  await assert.rejects(()=>observeVerification(call,"task",10,180000,()=>clock),/budget expired/);assert.deepEqual(names,["dsh_wait"]);
});
