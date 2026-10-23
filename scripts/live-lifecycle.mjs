// Real Desktop integration through the built MCP. Caller SDK test, not a native
// Claude/Codex UI test. Exactly two independent prompts in an isolated directory.
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const cwd=resolve('../analysis/supervision-fix-v2/2026-10-23/live-workspace');
await mkdir(cwd,{recursive:true});
const config=JSON.parse(await readFile(join(homedir(),'.claude.json'),'utf8')).mcpServers.dsh_desktop;
const client=new Client({name:'live-lifecycle-verification',version:'1'});
const transport=new StdioClientTransport({command:process.execPath,args:[resolve('dist/index.js')],env:{...process.env,...config.env},stderr:'ignore'});
async function call(name,args) {const r=await client.callTool({name,arguments:args});const v=JSON.parse(r.content[0].text);if(r.isError)throw new Error(JSON.stringify(v));return v;}
try {
  await client.connect(transport);await new Promise(r=>setTimeout(r,2000));
  const host=await call('dsh_host_status',{});
  if(!host.reachable)throw new Error(JSON.stringify({errorCode:host.errorCode,availability:host.availability}));
  console.log(JSON.stringify({host:{reachable:host.reachable,version:host.connection?.hostDescribeProductVersion,workspaceRelease:host.workspaceRelease}}));
  for(const round of [1,2]) {
    const task=await call('dsh_delegate',{cwd,workspaceMode:'exclusive-write',waitSeconds:0,title:`P2 lifecycle ${round}`,prompt:`这是隔离的连接验收目录。只执行一个极小写入任务：在当前目录创建 phase${round}.txt，内容精确为 PHASE_${round}_OK（可有末尾换行），然后回复 PHASE_${round}_OK。${round===2?'先确认 phase1.txt 内容是 PHASE_1_OK，保留它。':''}不要扫描项目、不要后台作业、不要委派、不要修改其他文件。`});
    console.log(JSON.stringify({round,taskId:task.taskId,waitTarget:task.waitTarget}));
    let cursor; let result;
    for(;;) {
      result=await call('dsh_wait',{taskId:task.taskId,timeoutSec:30,until:'terminal',responseMode:'compact',...task.waitTarget,...(cursor===undefined?{}:{sinceCursor:cursor})});
      console.log(JSON.stringify({round,wait:result}));cursor=result.nextCursor;
      if(result.wakeReason==='terminal')break;
      if(result.wakeReason!=='timeout')throw new Error('needs attention; retain task and claim');
    }
    const full=await call('dsh_status',{taskId:task.taskId});
    assert.equal(full.execution,'turn_completed');assert.equal(full.finalMessageStatus,'available');
    assert.equal((await readFile(join(cwd,`phase${round}.txt`),'utf8')).trim(),`PHASE_${round}_OK`);
    const released=await call('dsh_release_workspace',{taskId:task.taskId});
    assert.equal(released.releaseEvidence.source,'desktop-live');
    const after=await call('dsh_status',{taskId:task.taskId});assert.equal(after.workspaceClaim,null);
    console.log(JSON.stringify({round,taskId:task.taskId,fileVerified:true,released:released.releaseEvidence,historyPreserved:after.cursor>=full.cursor}));
  }
  console.log(JSON.stringify({lifecycle:'PASS',cwd}));
} finally {await client.close();await transport.close();}
