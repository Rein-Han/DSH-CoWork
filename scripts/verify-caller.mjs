#!/usr/bin/env node
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {kimiCodeConfigPath,zcodeConfigPath} from '../dist/setup-desktop.js';
import {observeVerification} from '../dist/caller-verification.js';

export async function verifyCallerMain(argv) {
  const value=k=>argv[argv.indexOf(k)+1];
  const caller=value('--caller');assert.ok(['zcode','kimi-code','kimi-work'].includes(caller),'--caller zcode|kimi-code|kimi-work is required');
  // --project always selects the project root; --cwd is the requested task scope.
  const project=await realpath(argv.includes('--project')?resolve(value('--project')):process.cwd());
  const executionCwd=argv.includes('--cwd')?await realpath(resolve(value('--cwd'))):project;
  const config=argv.includes('--config')?resolve(value('--config')):caller==='zcode'?zcodeConfigPath('user',project):caller==='kimi-code'?kimiCodeConfigPath('user',project):undefined;
  assert.ok(config,'Kimi Work requires --config <exported mcp-settings.json>; SDK success does not verify client installation');
  const parsed=JSON.parse(await readFile(config,'utf8'));
  const server=caller==='zcode'?parsed.mcp?.servers?.dsh_desktop:parsed.mcpServers?.dsh_desktop;
  assert.equal(server?.env?.DSH_CALLER_KIND,caller,'configuration must belong to the selected caller');
  const env={...Object.fromEntries(Object.entries(process.env).filter(([,v])=>typeof v==='string')),...server.env};
  if(argv.includes('--bridge-home'))env.DSH_BRIDGE_HOME=resolve(value('--bridge-home'));
  const client=new Client({name:'dsh-caller-sdk-acceptance',version:'1.0.0'});
  const call=async(name,args={})=>{
    const result=await client.callTool({name,arguments:args},undefined,{timeout:120000});
    const text=result.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n');
    const data=JSON.parse(text||'{}');if(result.isError)throw new Error(`${name}: ${JSON.stringify(data)}`);return data;
  };
  let receipt;
  try {
    await client.connect(new StdioClientTransport({command:server.command,args:server.args,cwd:project,env,stderr:'inherit'}));
    const connectDeadline=performance.now()+20000;let host;
    do {host=await call('dsh_host_status');if(host.reachable||host.availability!=='connecting')break;await new Promise(r=>setTimeout(r,500));}while(performance.now()<connectDeadline);
    assert.equal(host.reachable,true,'DSH must be reachable');assert.equal(host.adapter.callerKind,caller);
    assert.ok(host.observation?.targetStartAfterCursor,'updated supervision bridge is required');
    const receiptFile=argv.includes('--receipt')?resolve(value('--receipt')):undefined;
    if(receiptFile){
      receipt=JSON.parse(await readFile(receiptFile,'utf8'));
      assert.equal(receipt.caller,caller);assert.equal(receipt.bridgeHome,env.DSH_BRIDGE_HOME,'resume with the same bridge home');
      // Receipts written before workspace evidence are still resumable.
      if(receipt.project!==undefined)assert.equal(receipt.project,project,'resume with the same project');
      if(receipt.requestedCwd!==undefined)assert.equal(receipt.requestedCwd,executionCwd,'resume with the same requested cwd');
    } else {
      if(argv.some(x=>/^dsh_/.test(x)))throw new Error('resume with --receipt <saved.json>; a taskId alone does not identify the intended run');
      const marker=`${caller.toUpperCase().replaceAll('-','_')}_DSH_OK`;
      const delegated=await call('dsh_delegate',{projectRoot:project,cwd:executionCwd,title:`${caller} SDK acceptance`,workspaceMode:'read-only',waitSeconds:0,
        prompt:`这是本地桥接连通验收。项目根为 ${project}；请求任务目录（仅任务范围，不是沙箱）为 ${executionCwd}。不要修改文件或调用工具，只回复 ${marker}。`});
      const workspace=delegated.desktopWorkspace;
      assert.ok(workspace,'updated bridge desktopWorkspace evidence is required');
      assert.ok(workspace.workspaceId,'desktopWorkspace.workspaceId is required');
      assert.equal(typeof workspace.created,'boolean','desktopWorkspace.created must be boolean');
      assert.ok(['exact','ancestor','created'].includes(workspace.resolution),'invalid desktopWorkspace.resolution');
      assert.equal(workspace.path,project,'desktopWorkspace.path must be the canonical project');
      assert.equal(workspace.sessionCwd,project,'desktopWorkspace.sessionCwd must be the canonical project');
      assert.equal(workspace.requestedCwd,executionCwd,'desktopWorkspace.requestedCwd must be the canonical execution cwd');
      assert.equal(delegated.workspaceClaim?.cwd,workspace.sessionCwd,'workspace claim must use the actual session cwd');
      receipt={caller,taskId:delegated.taskId,targetStartAfterCursor:delegated.waitTarget?.targetStartAfterCursor,marker,bridgeHome:env.DSH_BRIDGE_HOME,project,requestedCwd:executionCwd,desktopWorkspace:workspace};
      console.log(JSON.stringify({delegated:receipt}));
      const path=join(project,'artifacts','dsh-verification',`${receipt.taskId}.json`);await mkdir(join(project,'artifacts','dsh-verification'),{recursive:true});
      await writeFile(path,JSON.stringify(receipt,null,2)+'\n');console.log(`receipt: ${path}`);
    }
    const result=await observeVerification(call,receipt.taskId,receipt.targetStartAfterCursor);
    assert.equal(result.execution,'turn_completed',`task ${receipt.taskId} ended ${result.execution}; normal release was attempted`);
    assert.equal(result.finalMessage?.trim(),receipt.marker,'expected marker must be the complete result');
    console.log(JSON.stringify({status:'PASS',evidence:'SDK transport; native UI acceptance still required',caller,taskId:receipt.taskId,...result}));
  } finally {await client.close();}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)await verifyCallerMain(process.argv.slice(2));
