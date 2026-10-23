#!/usr/bin/env node
// Explicit 10-minute SDK test, not a native Claude/Codex UI capability claim.
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const client=new Client({name:'p3-sdk-acceptance',version:'1'});
const transport=new StdioClientTransport({command:process.execPath,args:[resolve('scripts/p3-fixture.mjs')],stderr:'inherit'});
const progress=new Map();
async function call(name,args={},opts={}){const result=await client.callTool({name,arguments:args},undefined,{timeout:960000,...opts});if(result.isError)throw new Error(JSON.stringify(result.content));return JSON.parse(result.content[0].text);}
let sample;
try {
 await client.connect(transport);
 const short=await call('p3_start',{seconds:150});const long=await call('p3_start',{seconds:600,ordinaryEvents:1000});
 const controller=new AbortController();const canceled=call('p3_wait',{jobId:long.jobId},{signal:controller.signal});const rejection=assert.rejects(canceled);setTimeout(()=>controller.abort(),1000);
 const waits=[short,...Array.from({length:4},()=>long)].map((v,i)=>call('p3_wait',{jobId:v.jobId},{...(i===4?{}:{onprogress:p=>{const last=progress.get(i)??0;assert.ok(p.progress>last);progress.set(i,p.progress);}})}).then(result=>{assert.equal(result.wakeReason,'terminal');assert.equal(result.result,'P3_FIXTURE_OK');assert.equal(result.ordinaryEmitted,v.ordinaryEvents);assert.ok(result.elapsedMs>=v.seconds*1000);console.log(JSON.stringify({wait:i,jobId:v.jobId,result}));}));
 await rejection;
 assert.equal((await call('p3_status',{jobId:long.jobId})).execution,'running');
 sample=setInterval(()=>{void call('p3_metrics').then(m=>console.log(JSON.stringify({sample:m})));},30000);
 await Promise.all(waits);clearInterval(sample);
 await new Promise(r=>setTimeout(r,30));
 const metrics=await call('p3_metrics');assert.equal(metrics.activeWaits,0);assert.equal(metrics.activeObservers,0);assert.equal(metrics.activeWork,0);assert.equal(metrics.waitCalls,6);assert.equal(metrics.canceledWaits,1);
 console.log(JSON.stringify({status:'PASS',evidence:'MCP SDK / real elapsed time, not native caller UI',metrics,progress:[...progress]}));
}finally{clearInterval(sample);await client.close();await transport.close();}
