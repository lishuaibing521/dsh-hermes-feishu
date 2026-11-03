// 发一张不撤回的真实卡片，让人眼确认表格渲染效果。
// 跑法：node test/demo.mjs
import { readFile } from 'node:fs/promises';
import { FeishuClient } from '../lib/feishu.js';
import { buildOutboundPayload } from '../lib/render.js';

const ENV_PATH = 'C:/Users/lishuaibing/.dsh/.env';
const text = await readFile(ENV_PATH, 'utf8');
const pick = (key) => {
  const m = new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm').exec(text);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : undefined;
};

const client = new FeishuClient({
  appId: pick('FEISHU_PLUGIN_APP_ID'),
  appSecret: pick('FEISHU_PLUGIN_APP_SECRET'),
  domain: pick('FEISHU_PLUGIN_DOMAIN') ?? 'feishu',
});
const chatId = pick('FEISHU_PLUGIN_CHAT_ID');
const botName = pick('FEISHU_PLUGIN_BOT_NAME') ?? 'DSH Ai助手';

const stamp = new Date().toLocaleString('zh-CN', { hour12: false });

const content = [
  '## dsh-hermes-feishu 渲染验证',
  '',
  `发出时间：${stamp}`,
  '',
  '下面这张表如果是**原生表格**（有表头、框线、列对齐）就说明移植成功；',
  '如果显示成一堆竖线文字，就是失败。',
  '',
  '| 能力 | Hermes 实现 | dsh 插件实现 | 状态 |',
  '| --- | --- | --- | --- |',
  '| Markdown 表格 | `_build_native_card_table` | `buildNativeTable` | 原生 table 组件 |',
  '| 多级标题 | `_md_headings_to_bold` | `mdHeadingsToBold` | 降级为粗体 |',
  '| 出站路由 | `_build_outbound_payload` | `buildOutboundPayload` | 自动 text/card |',
  '| 入站解析 | `normalize_feishu_message` | `normalizeFeishuMessage` | post/卡片/合并转发 |',
  '',
  '### 代码块测试',
  '',
  '```js',
  "import { buildOutboundPayload } from './render.js';",
  "const routed = buildOutboundPayload(markdown);",
  '// routed.msgType 应该是 interactive',
  '```',
  '',
  '### 列表测试',
  '',
  '- 第一项',
  '- 第二项，**带粗体**',
  '- 第三项，`带行内代码`',
  '',
  '这条消息由 **dsh 插件直接调用飞书 Open API 发出**，没经过 dsh-lark-bot 桥。',
].join('\n');

const routed = buildOutboundPayload(content, { botName });
console.log('路由结果:', routed.msgType, '(', routed.reason, ')');

const data = await client.sendMessage({
  receiveId: chatId,
  receiveIdType: 'chat_id',
  msgType: routed.msgType,
  content: routed.content,
});

console.log('已发送，message_id =', data.message_id);
console.log('打开「DSH Ai助手」的私聊窗口就能看到（这条不会撤回）。');