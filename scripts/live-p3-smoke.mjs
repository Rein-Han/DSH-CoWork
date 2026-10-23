#!/usr/bin/env node
// Explicit real DSH test. Two small tasks, SDK clients using both caller kinds.
// Not evidence of native UI background/interrupt behaviour. Does spend DSH use.
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const root=resolve('../analysis/supervision-fix-v2/2026-10-23-p3');await mkdir(root,{recursive:true});
const base=JSON.parse(await readFile(join(homedir(),'.claude.json'),'utf8')).mcpServers.dsh_desktop;
const report=[];
async function run(caller){
 const isolated=await mkdtemp(join(root,`live-${caller}-`));const cwd=join(isolated,'work');await mkdir(cwd);
 const client=new Client({name:`p3-${caller}-sdk`,version:'1'});
 const transport=new StdioClientTransport({command:process.execPath,args:[resolve('dist/index.js')],env:{...process.env,...base.env,DSH_CALLER_KIND:caller==='claude'?'claude-code':'codex',DSH_WAIT_PROFILE:'long',DSH_BRIDGE_HOME:join(isolated,'bridge')},stderr:'ignore'});
 async function call(name,args={},signal){const r=await client.callTool({name,arguments:args},undefined,{timeout:960000,...(signal?{signal}:{})});const v=JSON.parse(r.content[0].text);if(r.isError)throw Object.assign(new Error(v.message),{result:v});return v;}
 try{
  await client.connect(transport);await new Promise(r=>setTimeout(r,2000));const host=await call('dsh_host_status');assert.equal(host.reachable,true);assert.equal(host.observation.policyVersion,2);assert.equal(host.observation.maxTimeoutSec,900);
  const marker=`P3_${caller.toUpperCase()}_OK`;
  const receipt=await call('dsh_delegate',{cwd,workspaceMode:'read-only',waitSeconds:0,title:`P3 ${caller} adapter smoke`,prompt:`隔离验收。目录是空的，不读写文件、不扫描仓库、不委派。仅执行这一条前台命令（不要放后台）：node -e "setTimeout(()=>console.log('done'),45000)"。等命令完成后最终仅回复 ${marker}。使用当前 Desktop 模型与权限。`});
  const record={caller,taskId:receipt.taskId,waitTarget:receipt.waitTarget,isolated};report.push(record);await writeFile(join(root,`live-${caller}-receipt.json`),JSON.stringify(record,null,2));console.log(JSON.stringify(record));
  const start=performance.now();const waited=await call('dsh_wait',{taskId:receipt.taskId,timeoutSec:900,until:'terminal',responseMode:'compact',...receipt.waitTarget});
  assert.equal(waited.wakeReason,'terminal');assert.ok(performance.now()-start>30000);
  const status=await call('dsh_status',{taskId:receipt.taskId});assert.match(status.finalMessage,new RegExp(marker));
  const release=await call('dsh_release_workspace',{taskId:receipt.taskId});assert.equal(release.releaseEvidence.source,'desktop-live');
  Object.assign(record,{status:'PASS',waitMs:performance.now()-start,waited,finalMessage:status.finalMessage,releaseEvidence:release.releaseEvidence,observation:host.observation});console.log(JSON.stringify(record));
 }finally{await client.close();await transport.close();}
}
const results=await Promise.allSettled(['codex','claude'].map(run));await writeFile(join(root,'live-smoke-results.json'),JSON.stringify({evidence:'SDK clients / real Host; not native UI',report,errors:results.filter(r=>r.status==='rejected').map(r=>String(r.reason))},null,2));for(const r of results)if(r.status==='rejected')throw r.reason;
