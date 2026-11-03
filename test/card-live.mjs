// 流式卡片单独验证：发一张卡 -> 追加工具 -> 更新 -> 收尾。
// 跑法：node test/card-live.mjs
import { readFile } from 'node:fs/promises';
import { FeishuClient } from '../lib/feishu.js';
import { RunCard } from '../lib/stream-card.js';

const t = await readFile('C:/Users/lishuaibing/.dsh/.env', 'utf8');
const pick = (k) => {
  const m = new RegExp(`^${k}\\s*=\\s*(.+)$`, 'm').exec(t);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : undefined;
};

const client = new FeishuClient({
  appId: pick('FEISHU_PLUGIN_APP_ID'),
  appSecret: pick('FEISHU_PLUGIN_APP_SECRET'),
  domain: pick('FEISHU_PLUGIN_DOMAIN') ?? 'feishu',
});

const chatId = 'oc_b037d4652e1b16a59fe04d9a9cf929a8';
const log = (m) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${m}`);

const card = new RunCard({ client, chatId, botName: 'DSH Ai助手', log });

console.log('1) 发初始卡片…');
const mid = await card.start();
console.log('   message_id =', mid);
if (!mid) process.exit(1);

await new Promise((r) => setTimeout(r, 1200));

console.log('2) 模拟工具调用…');
card.onEvent({ type: 'tool_call', callId: 'c1', tool: 'ops_bash', input: { command: 'ls -la' } });
card.onEvent({ type: 'tool_call', callId: 'c2', tool: 'ops_glob', input: { pattern: '**/*.md' } });
await new Promise((r) => setTimeout(r, 1000));
console.log('   （此时飞书上应该能看到「正在思考」和两条工具）');

card.onEvent({ type: 'tool_result', callId: 'c1', status: 'completed' });
card.onEvent({ type: 'tool_result', callId: 'c2', status: 'completed' });
await new Promise((r) => setTimeout(r, 1200));

console.log('3) 收尾，更新成最终结果…');
card.text = [
  '## 执行完毕',
  '',
  '下面是这次的结果：',
  '',
  '| 步骤 | 状态 |',
  '| --- | --- |',
  '| 列目录 | ✅ |',
  '| 找文件 | ✅ |',
  '',
  '表格如果能显示成**原生表格**就成了。',
].join('\n');
await card.finish({ status: 'done' });
console.log('   完成，卡片已更新');