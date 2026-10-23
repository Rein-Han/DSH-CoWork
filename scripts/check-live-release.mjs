// Explicit operator smoke: normal installed MCP transport, real Host, no claim deletion.
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const ids=process.argv.slice(2);
if(!ids.length || ids.some(id=>!/^dsh_[a-f0-9]{12}$/.test(id))) throw new Error('explicit task IDs required');
const config=JSON.parse(await readFile(join(homedir(),'.claude.json'),'utf8')).mcpServers.dsh_desktop;
const client=new Client({name:'live-release-verification',version:'1'});
const transport=new StdioClientTransport({command:process.execPath,args:[resolve('dist/index.js')],env:{...process.env,...config.env},stderr:'ignore'});
const call=async(name,args)=>{const r=await client.callTool({name,arguments:args});const v=JSON.parse(r.content[0].text);if(r.isError)throw new Error(JSON.stringify(v));return v;};
try {
  await client.connect(transport);
  // MCP initialize completes before the bridge's asynchronous Host handshake.
  await new Promise(resolve=>setTimeout(resolve,2000));
  const host=await call('dsh_host_status',{});
  if(!host.reachable) throw new Error(JSON.stringify({errorCode:host.errorCode,availability:host.availability,error:host.error,connectionError:host.connection?.lastError}));
  for(const taskId of ids) {
    const before=await call('dsh_status',{taskId});
    console.log(JSON.stringify({taskId,execution:before.execution,claim:before.workspaceClaim}));
    const released=await call('dsh_release_workspace',{taskId});
    console.log(JSON.stringify(released));
    const after=await call('dsh_status',{taskId});
    if(after.workspaceClaim) throw new Error('claim still present');
    console.log(JSON.stringify({taskId,claimAbsent:true,execution:after.execution,historyPreserved:after.cursor>=before.cursor}));
  }
} finally {await client.close();await transport.close();}
