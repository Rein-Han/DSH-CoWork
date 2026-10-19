#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const config = JSON.parse(await readFile(join(homedir(), '.zcode', 'cli', 'config.json'), 'utf8'));
const server = config.mcp?.servers?.dsh_desktop;
assert.ok(server, 'ZCode dsh_desktop MCP server must be registered');
assert.equal(server.env.DSH_CALLER_KIND, 'zcode');
const transport = new StdioClientTransport({
  command: server.command,
  args: server.args,
  cwd: root,
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string')), ...server.env },
  stderr: 'inherit',
});
const client = new Client({ name: 'zcode-dsh-cowork-acceptance', version: '1.0.0' });

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.filter(part => part.type === 'text').map(part => part.text).join('\n');
  const value = JSON.parse(text || '{}');
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(value)}`);
  return value;
}

try {
  await client.connect(transport);
  const tools = await client.listTools();
  console.log('MCP tools:', tools.tools.map(tool => tool.name).join(', '));
  let host;
  const connectDeadline = Date.now() + 20_000;
  do {
    host = await call('dsh_host_status');
    if (host.reachable || host.availability !== 'connecting') break;
    await new Promise(resolve => setTimeout(resolve, 500));
  } while (Date.now() < connectDeadline);
  console.log('Host status:', JSON.stringify({ reachable: host.reachable, availability: host.availability, adapter: host.adapter, version: host.connection?.hostDescribeProductVersion }));
  assert.equal(host.reachable, true, 'DSH Desktop must be reachable');

  let taskId = process.argv[2];
  let status;
  if (taskId) {
    status = await call('dsh_status', { taskId });
  } else {
    status = await call('dsh_delegate', {
      cwd: root,
      title: 'ZCode MCP connection check',
      workspaceMode: 'read-only',
      prompt: '这是 ZCode 通过 DSH-CoWork MCP 发起的连通测试。请勿修改任何文件，也无需调用工具。只回复一行：ZCODE_DSH_OK，然后写出当前工作目录。',
    });
    taskId = status.taskId;
    assert.ok(taskId, 'delegate must return a taskId');
    console.log('Delegated:', JSON.stringify({ taskId, sessionId: status.rootSessionId, accepted: status.accepted, model: status.model }));
  }
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    status = await call('dsh_status', { taskId });
    console.log('Task status:', JSON.stringify({ taskId, sessionId: status.rootSessionId, availability: status.availability, execution: status.execution, cursor: status.cursor, finalMessage: status.finalMessage }));
    if (['awaiting_approval', 'awaiting_input'].includes(status.execution)) {
      throw new Error(`DSH Desktop needs user interaction; resume verification with taskId ${taskId}`);
    }
    if (['turn_completed', 'failed', 'cancelled', 'interrupted'].includes(status.execution)) break;
    await call('dsh_wait', { taskId, timeoutSec: 20, ...(typeof status.cursor === 'number' ? { sinceCursor: status.cursor } : {}) });
  }
  if (status.execution !== 'turn_completed') {
    const tail = await call('dsh_tail', { taskId, maxEvents: 80 });
    const errors = (tail.events ?? []).filter(event => event.digest?.eventType === 'turn/end').map(event => event.digest?.data?.reason);
    console.log('Task termination:', JSON.stringify(errors));
  }
  if (status.workspaceClaim && ['turn_completed', 'failed', 'cancelled', 'interrupted'].includes(status.execution)) {
    console.log('Workspace release:', JSON.stringify(await call('dsh_release_workspace', { taskId })));
  }
  assert.equal(status.execution, 'turn_completed', `task ${taskId} did not complete`);
  assert.match(status.finalMessage ?? '', /ZCODE_DSH_OK/u);
  console.log('PASS:', JSON.stringify({ taskId, sessionId: status.rootSessionId, finalMessage: status.finalMessage }));
} finally {
  await client.close();
}
