// 端到端实发测试：用 openclaw 那套飞书机器人 -> 构建卡片 -> 实发 -> 读回 -> 撤回。
// 凭据从 ~/.dsh/.env 读（FEISHU_PLUGIN_*），绝不打印。
// 跑法：node test/e2e.mjs
import { readFile } from 'node:fs/promises';
import { FeishuClient } from '../lib/feishu.js';
import { buildOutboundPayload } from '../lib/render.js';

const ENV_PATH = 'C:/Users/lishuaibing/.dsh/.env';

const text = await readFile(ENV_PATH, 'utf8');
const pick = (key) => {
  const m = new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm').exec(text);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : undefined;
};

const appId = pick('FEISHU_PLUGIN_APP_ID');
const appSecret = pick('FEISHU_PLUGIN_APP_SECRET');
const chatId = pick('FEISHU_PLUGIN_CHAT_ID');
const domain = pick('FEISHU_PLUGIN_DOMAIN') ?? 'feishu';

if (!appId || !appSecret || !chatId) {
  console.error('凭据或 chat_id 缺失');
  process.exit(1);
}

const client = new FeishuClient({ appId, appSecret, domain });

let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failed += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

console.log(`目标机器人：${appId}`);
console.log(`目标会话  ：${chatId}`);

console.log('\n=== 1. 身份确认 ===');
try {
  const info = await client.getBotInfo();
  check('能查到机器人', Boolean(info?.app_name));
  console.log(`     app_name = ${info?.app_name}`);
  console.log(`     open_id  = ${(info?.open_id ?? '').slice(0, 8)}…`);
} catch (error) {
  check('查询机器人', false, error.message);
}

const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
const content = [
  '## dsh-hermes-feishu 自检',
  '',
  `发送时间：${stamp}`,
  '',
  '| 能力 | 实现方式 | 状态 |',
  '| --- | --- | --- |',
  '| Markdown 表格 | 飞书原生 table 组件 | 已验证 |',
  '| 多级标题 | 降级为粗体 | 已验证 |',
  '| 代码块 | 独立 markdown 元素 | 已验证 |',
  '',
  '```js',
  "console.log('dsh-hermes-feishu ok');",
  '```',
  '',
  '这条消息由 **dsh 插件**直接发出。',
].join('\n');

console.log('\n=== 2. 构建载荷 ===');
const routed = buildOutboundPayload(content, { botName: 'DSH Ai助手' });
check('路由到交互卡片', routed.msgType === 'interactive', routed.msgType);
const card = JSON.parse(routed.content);
const tags = card.body.elements.map((e) => e.tag);
console.log(`     卡片元素：${tags.join(', ')}`);
check('含原生 table 组件', tags.includes('table'));
check('标题带 🤖 前缀（与 Hermes 一致）', card.header.title.content === '\u{1F916} DSH Ai助手', card.header.title.content);

console.log('\n=== 3. 真实发送 ===');
let messageId;
try {
  const data = await client.sendMessage({
    receiveId: chatId,
    receiveIdType: 'chat_id',
    msgType: routed.msgType,
    content: routed.content,
  });
  messageId = data.message_id;
  check('发送成功', Boolean(messageId), JSON.stringify(data).slice(0, 200));
  console.log(`     message_id = ${messageId}`);
} catch (error) {
  check('发送成功', false, error.message);
}

console.log('\n=== 4. 读回校验 ===');
if (messageId) {
  try {
    await new Promise((r) => setTimeout(r, 1500));
    const msg = await client.getMessage({ messageId });
    const items = msg?.items ?? [];
    check('能读回消息', items.length > 0);
    if (items[0]) {
      check('msg_type = interactive', items[0].msg_type === 'interactive', items[0].msg_type);
      check('落在目标会话', items[0].chat_id === chatId);
    }
  } catch (error) {
    check('读回消息', false, error.message);
  }
}

console.log('\n=== 5. 撤回 ===');
if (messageId) {
  try {
    await client.deleteMessage({ messageId });
    check('撤回成功', true);
  } catch (error) {
    check('撤回', false, error.message);
  }
}

console.log(`\n${'='.repeat(60)}`);
if (failed > 0) {
  console.log(`失败 ${failed} 项`);
  process.exit(1);
}
console.log('端到端全链路通过 ✅');