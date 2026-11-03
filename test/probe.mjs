// 真机探测：用真实凭据调飞书 Open API，验证 token / 机器人身份 / 群信息。
// 凭据从 Hermes 的 .env 读，绝不打印。
// 跑法：node test/probe.mjs
import { readFile } from 'node:fs/promises';
import { FeishuClient } from '../lib/feishu.js';

const ENV_PATH = 'C:/Users/lishuaibing/AppData/Local/hermes/.env';

async function loadCreds() {
  const text = await readFile(ENV_PATH, 'utf8');
  const pick = (key) => {
    const m = new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm').exec(text);
    if (!m) return undefined;
    return m[1].trim().replace(/^["']|["']$/g, '');
  };
  return {
    appId: pick('FEISHU_APP_ID'),
    appSecret: pick('FEISHU_APP_SECRET'),
    chatId: pick('FEISHU_HOME_CHANNEL'),
  };
}

const mask = (v) => (typeof v === 'string' && v.length > 10 ? `${v.slice(0, 6)}…${v.slice(-4)}` : '***');

const creds = await loadCreds();
console.log('凭据读取：');
console.log('  app_id  =', mask(creds.appId));
console.log('  chat_id =', creds.chatId);
console.log('  secret  =', creds.appSecret ? '已读取（不显示）' : '缺失');

if (!creds.appId || !creds.appSecret) {
  console.error('凭据缺失，无法继续');
  process.exit(1);
}

const client = new FeishuClient({
  appId: creds.appId,
  appSecret: creds.appSecret,
  domain: 'feishu',
});

let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failed += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

console.log('\n=== 1. tenant_access_token ===');
try {
  const token = await client.tenantToken();
  check('拿到 token', typeof token === 'string' && token.length > 10, `长度 ${token?.length}`);
  const cached = await client.tenantToken();
  check('第二次命中的是缓存', cached === token);
} catch (error) {
  check('获取 token', false, error.message);
}

console.log('\n=== 2. 机器人身份 ===');
try {
  const info = await client.getBotInfo();
  const name = info?.bot_name ?? info?.app_name ?? '';
  check('查到机器人', Boolean(name));
  console.log(`     app_name = ${name}`);
  console.log(`     open_id  = ${mask(info?.open_id)}`);
  console.log(`     activate_status = ${info?.activate_status ?? '(空)'}`);
} catch (error) {
  check('查询机器人信息', false, error.message);
}

console.log('\n=== 3. 目标会话可访问性 ===');
if (creds.chatId) {
  try {
    const chat = await client.getChatInfo(creds.chatId);
    check('能读到会话信息', Boolean(chat));
    console.log(`     chat_name = ${chat?.name ?? '(空)'}`);
    console.log(`     chat_mode = ${chat?.chat_mode ?? '(空)'}`);
    console.log(`     user_count = ${chat?.user_count ?? '(空)'}`);
  } catch (error) {
    check('读取会话', false, error.message);
  }
} else {
    console.log('  跳过（没有 chat_id）');
}

console.log('\n=== 4. 渲染链路（不发消息，只看载荷） ===');
try {
  const { buildOutboundPayload } = await import('../lib/render.js');
  const md = [
    '## 插件自检',
    '',
    '| 能力 | 状态 |',
    '| --- | --- |',
    '| 表格渲染 | 原生 table |',
    '| 标题降级 | 粗体 |',
    '',
    '```js',
    "console.log('ok')",
    '```',
  ].join('\n');
  const routed = buildOutboundPayload(md, { botName: 'HermesAgent' });
  check('含表格时路由到 interactive', routed.msgType === 'interactive', routed.msgType);
  const card = JSON.parse(routed.content);
  check('卡片 schema 2.0', card.schema === '2.0');
  check('含原生 table 组件', card.body.elements.some((e) => e.tag === 'table'));
  const table = card.body.elements.find((e) => e.tag === 'table');
  check('表格列数是 2', table.columns.length === 2, String(table.columns?.length));
  check('表格数据行数是 2', table.rows.length === 2, String(table.rows?.length));
  check('标题已降级为粗体', card.body.elements.some((e) => e.tag === 'markdown' && e.content.includes('**插件自检**')));
  console.log(`     卡片元素类型：${card.body.elements.map((e) => e.tag).join(', ')}`);
} catch (error) {
  check('渲染链路', false, error.message);
}

console.log(`\n${'='.repeat(60)}`);
if (failed > 0) {
  console.log(`失败 ${failed} 项`);
  process.exit(1);
}
console.log('真机探测全部通过 ✅');