#!/usr/bin/env node
// Temporary timer-only MCP entry for native-client acceptance. Does not alter
// the production dsh_desktop profile. Removal compares the entry before writing.
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
import {atomicInstallText,readConfigSnapshot} from '../dist/setup-engine.js';
import {codexConfigPath,claudeConfigPath} from '../dist/setup-desktop.js';
const args=process.argv.slice(2);for(const arg of args)if(!['--apply','--remove'].includes(arg))throw new Error(`unknown option ${arg}`);
const apply=args.includes('--apply'),remove=args.includes('--remove');
const name='dsh_wait_acceptance';
const fixture=resolve(dirname(fileURLToPath(import.meta.url)),'p3-fixture.mjs');
const block=`[mcp_servers.${name}]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(fixture)}]\nstartup_timeout_sec = 30\ntool_timeout_sec = 960\n`;
const entry={type:'stdio',command:process.execPath,args:[fixture],timeout:960000};
// Plan both clients before any write, so a conflict is reviewable and no private
// configuration contents need be printed.
const plans=[];
for(const caller of ['codex','claude']){
 const path=caller==='codex'?codexConfigPath('user',process.cwd()):claudeConfigPath('user',process.cwd());
 const snapshot=await readConfigSnapshot(path);const before=snapshot.exists?snapshot.content:'';let content;
 if(caller==='codex'){
  const re=new RegExp(`^\\[mcp_servers\\.${name}\\][^\\r\\n]*\\r?\\n[^]*?(?=^\\s*\\[|(?![^]))`,'m');const match=re.exec(before);
  if(match&&match[0].trim()!==block.trim())throw new Error(`${caller}: acceptance entry was customized; preserving it`);
  content=remove?(match?before.replace(match[0],''):before):match?before:`${before.trimEnd()}\n\n${block}`;
 }else{
  const json=before?JSON.parse(before):{};const current=json.mcpServers?.[name];
  if(current&&JSON.stringify(current)!==JSON.stringify(entry))throw new Error(`${caller}: acceptance entry was customized; preserving it`);
  if(remove){if(current)delete json.mcpServers[name];else{plans.push({caller,path,snapshot,content:before});continue;}}
  else{json.mcpServers??={};json.mcpServers[name]=entry;}
  content=JSON.stringify(json,null,2)+'\n';
 }
 plans.push({caller,path,snapshot,content});
}
for(const p of plans){
 if(p.content===(p.snapshot.exists?p.snapshot.content:'')){console.log(`${p.caller}: identical`);continue;}
 if(!apply){console.log(`${p.caller}: would ${remove?'remove':'add'} timer-only ${name} in ${p.path}`);continue;}
 const result=await atomicInstallText({path:p.path,content:p.content,expected:p.snapshot,backupLabel:'dsh-p3-acceptance'});
 console.log(JSON.stringify({caller:p.caller,path:p.path,action:remove?'remove':'add',backup:result.backupPath}));
}
