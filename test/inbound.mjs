// 入站长连接测试：起 WS 收消息，收到后只打印 + 回一条卡片，不跑 agent。
// 用来验证凭据、事件订阅、长连接是否正常。
// 跑法：node test/inbound.mjs
import { readFile } from 'node:fs/promises';
import { FeishuClient } from '../lib/feishu.js';
import { startInbound, extractMessage } from '../lib/inbound-ws.js';
import { normalizeFeishuMessage } from '../lib/inbound.js';
import { buildOutboundPayload } from '../lib/render.js';

const ENV_PATH = 'C:/Users/lishuaibing/.dsh/.env';
const text = await readFile(ENV_PATH, 'utf8');
const pick = (key) => {
  const m = new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm').exec(text);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : undefined;
};

const appId = pick('FEISHU_PLUGIN_APP_ID');
const appSecret = pick('FEISHU_PLUGIN_APP_SECRET');
const domain = pick('FEISHU_PLUGIN_DOMAIN') ?? 'feishu';
const botName = pick('FEISHU_PLUGIN_BOT_NAME') ?? 'AI 助手';

if (!appId || !appSecret) {
  console.error('凭据缺失');
  process.exit(1);
}

const client = new FeishuClient({ appId, appSecret, domain });

console.log('机器人:', appId);
console.log('开始监听飞书消息，请在飞书里给这个机器人发一条消息…');
console.log('（收到后我会回一张卡片，然后退出）\n');

const st = startInbound({
  appId,
  appSecret,
  domain,
  onReady: () => console.log('[ok] 长连接已建立，等待消息…'),
  onError: (e) => console.error('[ws-error]', e.message),
  onMessage: async (event) => {
    const m = extractMessage(event);
    console.log('[收到]');
    console.log('  messageId :', m.messageId);
    console.log('  chatId    :', m.chatId);
    console.log('  chatType  :', m.chatType);
    console.log('  msgType   :', m.messageType);
    console.log('  senderType:', m.senderType);

    const parsed = normalizeFeishuMessage({
      messageType: m.messageType,
      rawContent: m.content,
      mentions: m.mentions,
    });
    console.log('  归一化文本:', JSON.stringify(parsed.textContent));

    // 回一张卡片，证明入站 + 出站全通
    const reply = [
      '## 入站长连接测试',
      '',
      '收到你的消息了。',
      '',
      '| 项目 | 值 |',
      '| --- | --- |',
      `| 会话类型 | ${m.chatType} |`,
      `| 消息类型 | ${m.messageType} |`,
      `| 解析文本 | ${(parsed.textContent || '(空)').replace(/\|/g, '\\|').slice(0, 60)} |`,
      '',
      '如果这张表是原生表格，说明**入站 + 表格渲染**都通了。',
    ].join('\n');

    const routed = buildOutboundPayload(reply, { botName });
    try {
      await client.replyMessage({
        messageId: m.messageId,
        msgType: routed.msgType,
        content: routed.content,
      });
      console.log('  [ok] 已回复卡片');
    } catch (error) {
      console.error('  [fail] 回复失败:', error.message);
    }

    st.close();
    setTimeout(() => process.exit(0), 800);
  },
});

// 60 秒没消息就退出
setTimeout(() => {
  console.log('\n180 秒内没收到消息，退出。');
  st.close();
  process.exit(2);
}, 180000);