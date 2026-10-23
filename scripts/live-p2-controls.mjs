// Native Desktop Host, MCP SDK caller. Exercises observer cancellation and steer
// with real work; does not claim native app UI interruption support.
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const cwd=resolve('../analysis/supervision-fix-v2/2026-10-23/live-controls');await mkdir(cwd,{recursive:true});
const config=JSON.parse(await readFile(join(homedir(),'.claude.json'),'utf8')).mcpServers.dsh_desktop;
const client=new Client({name:'live-p2-controls',version:'1'});
const transport=new StdioClientTransport({command:process.execPath,args:[resolve('dist/index.js')],env:{...process.env,...config.env},stderr:'ignore'});
async function call(name,args,signal){const r=await client.callTool({name,arguments:args},undefined,{signal});const v=JSON.parse(r.content[0].text);if(r.isError)throw Object.assign(new Error(v.message),{result:v});return v;}
try {
  await client.connect(transport);await new Promise(r=>setTimeout(r,2000));
  assert.equal((await call('dsh_host_status',{})).reachable,true);
  const t=await call('dsh_delegate',{cwd,workspaceMode:'exclusive-write',waitSeconds:0,title:'P2 observer and steer',prompt:'隔离验收：仅运行这一条前台命令（不要放后台），然后回复 CONTROL_DONE：node -e "require(\'fs\').writeFileSync(\'ready.txt\',\'READY\');setTimeout(()=>console.log(\'done\'),20000)"。不扫描、不委派、不修改其他文件。如果执行中收到新指导，最终回复遵循新指导。'});
  console.log(JSON.stringify({taskId:t.taskId,waitTarget:t.waitTarget}));
  // Wait for the file, not a model/status polling loop. It proves the foreground tool began.
  const deadline=Date.now()+90000;
  while(true){try{if((await readFile(join(cwd,'ready.txt'),'utf8'))==='READY')break;}catch{}if(Date.now()>deadline)throw new Error('ready marker absent; inspect existing task');await new Promise(r=>setTimeout(r,250));}
  const before=await call('dsh_status',{taskId:t.taskId});assert.equal(before.running,true);
  await assert.rejects(call('dsh_release_workspace',{taskId:t.taskId}),e=>e.result?.code==='session_busy');
  const args={taskId:t.taskId,timeoutSec:30,until:'terminal',responseMode:'compact',...t.waitTarget};
  const controller=new AbortController();const first=call('dsh_wait',args,controller.signal);
  const canceled=assert.rejects(first);const second=call('dsh_wait',args);
  await new Promise(r=>setTimeout(r,300));controller.abort();await canceled;
  console.log(JSON.stringify({observerCanceled:true}));
  const afterCancel=await call('dsh_status',{taskId:t.taskId});assert.equal(afterCancel.running,true);
  const steer=await call('dsh_followup',{taskId:t.taskId,mode:'steer',prompt:'验收指导：前台命令结束后，最终只回复 STEER_OK。不要执行其他命令。'});
  assert.equal(steer.accepted,true);console.log(JSON.stringify({steerAccepted:true}));
  let result=await second;
  while(result.wakeReason==='timeout')result=await call('dsh_wait',{...args,sinceCursor:result.nextCursor});
  assert.equal(result.wakeReason,'terminal');
  const status=await call('dsh_status',{taskId:t.taskId});assert.equal(status.execution,'turn_completed');assert.match(status.finalMessage,/STEER_OK/);
  const released=await call('dsh_release_workspace',{taskId:t.taskId});
  console.log(JSON.stringify({taskId:t.taskId,controls:'PASS',execution:status.execution,finalMessage:status.finalMessage,release:released.releaseEvidence}));
}finally{await client.close();await transport.close();}
