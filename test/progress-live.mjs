// 进度气泡验证：起一条消息 -> 追加几行 -> 编辑 -> 收尾。
// 跑法：node test/progress-live.mjs
import { readFile } from 'node:fs/promises';
import { FeishuClient } from '../lib/feishu.js';
import { ProgressBubble } from '../lib/progress.js';

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
const log = (m) => console.log(`  [log] ${m}`);

const p = new ProgressBubble({ client, chatId, log });

console.log('1) 起气泡');
p.push('🤖 收到，开始处理…');
await new Promise((r) => setTimeout(r, 1200));
console.log('   messageId =', p.messageId);

console.log('2) 追加工具调用');
p.toolStart({ tool: 'ops_bash', input: { command: 'ls -la' } });
await new Promise((r) => setTimeout(r, 1000));
p.toolStart({ tool: 'ops_glob', input: { pattern: '**/*.md' } });
await new Promise((r) => setTimeout(r, 1000));
p.toolEnd({ status: 'completed' });
await new Promise((r) => setTimeout(r, 1000));

console.log('3) 收尾');
await p.finish();
console.log('   气泡当前内容：');
console.log(p.text().split('\n').map((l) => '     ' + l).join('\n'));