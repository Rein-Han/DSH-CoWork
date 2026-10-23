#!/usr/bin/env node
// Standalone acceptance MCP. No DSH credentials, adapters, task store or write
// tools. Its only work is local timers. It uses the production waiting policy.
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {waitWithPolicy, compactWait} from '../dist/wait-policy.js';
const server = new McpServer({name:'dsh-cowork-p3-fixture',version:'1'});
const jobs = new Map();
const counts = {waitCalls:0, completedWaits:0, canceledWaits:0, activeWaits:0, activeObservers:0, progress:0};
const out = value => ({content:[{type:'text',text:JSON.stringify(value)}]});
const job = id => {const v=jobs.get(id);if(!v)throw new Error('unknown fixture job');return v;};
const current = v => ({taskId:v.id,rootSessionId:v.id,cursor:v.cursor,availability:'connected',execution:v.done?'turn_completed':'running',pendingInteractions:[],connection:{revision:v.cursor},recovery:{state:'reconciled'},finalMessageStatus:v.done?'available':'not_available',finalMessagePointer:v.done?{sessionId:v.id,seq:v.cursor}:null});
server.registerTool('p3_start',{description:'Start timer-only acceptance work. Does not contact DSH or any model.',inputSchema:{seconds:z.number().int().min(1).max(900),ordinaryEvents:z.number().int().min(0).max(1000).default(0)}},async ({seconds,ordinaryEvents})=>{
  const v={id:randomUUID(),cursor:0,ordinaryEmitted:0,done:false,observers:new Set(),started:Date.now(),seconds,ordinaryEvents}; jobs.set(v.id,v);
  const emit=()=>{v.ordinaryEmitted++;v.cursor++;for(const fn of [...v.observers])fn();};
  const step=seconds*1000/(ordinaryEvents+1);
  const pump=()=>{
    const due=Math.min(ordinaryEvents,Math.floor((Date.now()-v.started)/step));
    while(v.ordinaryEmitted<due)emit();
    if(v.ordinaryEmitted<ordinaryEvents)v.events=setTimeout(pump,Math.max(1,v.started+(v.ordinaryEmitted+1)*step-Date.now()));
  };
  if(ordinaryEvents)v.events=setTimeout(pump,step);
  v.timer=setTimeout(()=>{clearTimeout(v.events);while(v.ordinaryEmitted<ordinaryEvents)emit();v.done=true;v.cursor++;for(const fn of [...v.observers])fn();},seconds*1000);
  return out({jobId:v.id,seconds,ordinaryEvents});
});
server.registerTool('p3_status',{description:'Read timer-only work, including after observer cancellation.',inputSchema:{jobId:z.string()}},async ({jobId})=>{const v=job(jobId);return out({...current(v),ordinaryEmitted:v.ordinaryEmitted,elapsedMs:Date.now()-v.started,result:v.done?'P3_FIXTURE_OK':null});});
server.registerTool('p3_metrics',{description:'Non-content resource counters for fixture acceptance.',inputSchema:{}},async ()=>out({...counts,rss:process.memoryUsage().rss,heapUsed:process.memoryUsage().heapUsed,activeWork:[...jobs.values()].filter(v=>!v.done).length}));
server.registerTool('p3_wait',{description:'One terminal wait, up to 900 seconds. Canceling this observation leaves timer work running. Collect its native background result; do not duplicate waits.',inputSchema:{jobId:z.string(),timeoutSec:z.number().int().min(0).max(900).default(900)}},async ({jobId,timeoutSec},extra)=>{
  const v=job(jobId);counts.waitCalls++;counts.activeWaits++;
  try {
    const result=await waitWithPolicy({timeoutSec,options:{until:'terminal',signal:extra.signal,...(extra._meta?.progressToken===undefined?{}:{progress:async progress=>{counts.progress++;await extra.sendNotification({method:'notifications/progress',params:{progressToken:extra._meta.progressToken,progress}});}})},read:async()=>current(v),
      wait:async (cursor,_revision,remaining,signal)=>new Promise((resolve,reject)=>{
        let settled=false;const finish=()=>{if(settled)return;settled=true;clearTimeout(timer);v.observers.delete(finish);signal.removeEventListener('abort',abort);counts.activeObservers--;resolve();};
        const abort=()=>{finish();reject(signal.reason);};const timer=setTimeout(finish,remaining);v.observers.add(finish);counts.activeObservers++;signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();else if(v.cursor>cursor)finish();
      })});
    counts.completedWaits++;return out({...compactWait(result),ordinaryEmitted:v.ordinaryEmitted,result:v.done?'P3_FIXTURE_OK':null,elapsedMs:Date.now()-v.started});
  } catch(error){if(extra.signal.aborted)counts.canceledWaits++;throw error;}finally{counts.activeWaits--;}
});
server.server.onclose=()=>{for(const v of jobs.values()){clearTimeout(v.timer);clearInterval(v.events);} };
await server.connect(new StdioServerTransport());
