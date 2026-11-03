// 完整入站链路测试：飞书消息 -> dsh agent -> 卡片回复。
// 跑法：node test/agent-echo.mjs
import { readFile } from 'node:fs/promises';
import { FeishuClient } from '../lib/feishu.js';
import { startInbound } from '../lib/inbound-ws.js';
import { createMessageHandler } from '../lib/dispatch.js';

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

const client = new FeishuClient({ appId, appSecret, domain });
const log = (m) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${m}`);

const onMessage = createMessageHandler({
  client,
  profile: process.env.TEST_AGENT_PROFILE ?? 'headless',
  botName,
  log,
});

console.log('机器人:', appId);
console.log('agent profile:', process.env.TEST_AGENT_PROFILE ?? 'headless');
console.log('等待飞书消息…（收到后跑 agent 并回卡片）\n');

const st = startInbound({
  appId,
  appSecret,
  domain,
  onReady: () => log('[ok] 长连接已建立'),
  onError: (e) => log(`[ws-error] ${e.message}`),
  onMessage,
});

setTimeout(() => {
  log('300 秒窗口到期，退出');
  st.close();
  process.exit(0);
}, 300000);