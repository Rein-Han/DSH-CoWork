// Compare against the user-approved v0.1.1 baseline. No task execution or edits.
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import ts from 'typescript';
import assert from 'node:assert/strict';
const root=resolve('.').replaceAll('\\','/');
const git=(...args)=>execFileSync('git',['-c',`safe.directory=${root}`,...args],{encoding:'utf8'});
const original=path=>git('show',`v0.1.1:${path}`);
const current=path=>readFileSync(path,'utf8');
const normalize=text=>text.replaceAll('\r\n','\n');
const source=(path,text)=>ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true);
let checks=0;
function same(label,a,b){assert.equal(normalize(a),normalize(b),`protected code changed: ${label}`);checks++;}
function members(path,className,allowed=[]){
  const get=text=>source(path,text).statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text===className).members;
  const before=get(original(path)),after=get(current(path));
  for(const old of before){const key=old.name?.getText()??'constructor';if(allowed.includes(key))continue;
    const next=after.find(n=>(n.name?.getText()??'constructor')===key);assert.ok(next,`missing ${key}`);same(`${path}:${key}`,old.getText(),next.getText());}
}
members('src/bridge-service.ts','BridgeService',['wait','waitCapabilities']);
members('src/event-ledger.ts','EventLedger');
const path='src/mcp-server.ts';
function tools(text){const found=new Map();function visit(n){if(ts.isCallExpression(n)&&n.expression.getText().endsWith('.registerTool'))found.set(n.arguments[0].text,n.getText());ts.forEachChild(n,visit);}visit(source(path,text));return found;}
const oldTools=tools(original(path)),newTools=tools(current(path));
for(const [name,text] of oldTools)if(!['dsh_wait','dsh_observe'].includes(name))same(`MCP ${name}`,text,newTools.get(name));
for(const name of ['serverInstructions','desktopServerInstructions']){
  const find=text=>source(path,text).statements.filter(ts.isVariableStatement).find(n=>n.declarationList.declarations.some(d=>d.name.getText()===name)).getText();
  same(name,find(original(path)),find(current(path)));
}
const editable=new Set(['src/bridge-service.ts','src/event-ledger.ts','src/mcp-server.ts','src/config.ts','src/wait-policy.ts','src/setup-desktop.ts','src/codex-integration.ts','src/rollback-wait-profile.ts']);
for(const file of git('ls-tree','-r','--name-only','v0.1.1','src').trim().split('\n')){
  if(file==='src/version.ts'){
    same(file,original(file).replace('"0.1.0-alpha.5"','"<version>"'),current(file).replace('"0.2.0"','"<version>"'));
  }else if(!editable.has(file))same(file,original(file),current(file));
}
for(const caller of ['codex','claude','zcode','kimi-code','kimi-work']){
  const file=`skill/${caller}-dsh-desktop/SKILL.md`;
  const sections=text=>new Map(text.split(/(?=^## )/m).map(s=>[s.split('\n')[0],s]));
  const a=sections(normalize(original(file))),b=sections(normalize(current(file)));
  for(const [title,text] of a)if(!['## While it runs','## 等待','## 连接'].includes(title))same(`${file}:${title}`,text,b.get(title));
}
console.log(JSON.stringify({baseline:'v0.1.1',protectedChecks:checks,result:'PASS',scope:'All original BridgeService methods except wait/capabilities; every original EventLedger method; other MCP tools/instructions; other original src files; cooperation skill sections'}));
