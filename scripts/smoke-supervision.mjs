// Read-only smoke against an existing task. Use the installed bridge env; never print credentials or result bodies.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';
const taskId = process.argv[2];
if (!/^dsh_[a-f0-9]{12}$/.test(taskId ?? '')) throw new Error('provide an existing BridgeTask id');
const client = new Client({ name: 'supervision-smoke', version: '1' });
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/index.js')], env: process.env, stderr: 'ignore' });
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(r.content?.[0]?.text ?? 'tool error');
  return { value: JSON.parse(r.content[0].text), bytes: Buffer.byteLength(r.content[0].text) };
};
try {
  await client.connect(transport);
  let host;
  for (let i = 0; i < 10; i++) {
    host = (await call('dsh_host_status', {})).value;
    if (host.reachable) break;
    await new Promise(r => setTimeout(r, 500));
  }
  if (!host.reachable) throw new Error(`host unavailable: ${host.errorCode ?? host.availability}`);
  console.log(JSON.stringify({ host: { reachable: host.reachable, observation: host.observation, queueSnapshot: host.connection?.capabilities?.queueSnapshot } }));
  if (process.argv.includes('--prompt-check')) {
    // Explicit test mode: exactly one accepted prompt, never automatically retried.
    const receipt = (await call('dsh_followup', { taskId, mode: 'queue', prompt: '连接修复验收：只回复 SUPERVISION_OK，不调用任何工具，不修改文件。' })).value;
    console.log(JSON.stringify({ promptAccepted: receipt.accepted, waitTarget: receipt.waitTarget }));
    const waited = await call('dsh_wait', { taskId, timeoutSec: 30, until: 'terminal', responseMode: 'compact', ...receipt.waitTarget });
    console.log(JSON.stringify({ attributedWait: waited.value }));
  }
  const full = await call('dsh_wait', { taskId, timeoutSec: 0 });
  const compact = await call('dsh_wait', { taskId, timeoutSec: 0, until: 'terminal', responseMode: 'compact' });
  console.log(JSON.stringify({ fullBytes: full.bytes, compactBytes: compact.bytes, compact: compact.value }));
  const status = await call('dsh_status', { taskId });
  console.log(JSON.stringify({ completeResult: { execution: status.value.execution, finalMessageStatus: status.value.finalMessageStatus, chars: status.value.finalMessage?.length ?? 0 } }));
} finally { await client.close(); await transport.close(); }
