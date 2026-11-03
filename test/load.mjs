// 用假 ctx 模拟 cordis 加载，验证 apply() 能跑通且工具全部注册。
// 跑法：node test/load.mjs
import { apply, name, inject } from '../lib/index.js';

const registered = [];
const effects = [];
const logs = [];

const ctx = {
  tools: {
    register(tool) {
      registered.push(tool);
      return () => {};
    },
  },
  effect(fn) {
    effects.push(fn);
    const disposer = fn();
    return disposer ?? (() => {});
  },
  logger: {
    info: (...args) => logs.push(args.join(' ')),
    warn: (...args) => logs.push(args.join(' ')),
  },
};

let failed = 0;

function check(label, ok, detail = '') {
  if (ok) {
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('\n=== 插件元信息 ===');
check('name = dsh-hermes-feishu', name === 'dsh-hermes-feishu', name);
check('inject 含 tools', Array.isArray(inject) && inject.includes('tools'), JSON.stringify(inject));

console.log('\n=== apply() 加载 ===');
try {
  apply(ctx, { botName: '测试助手' });
  check('apply 未抛异常', true);
} catch (error) {
  check('apply 未抛异常', false, error.message);
}

console.log('\n=== 工具注册 ===');
const expectedTools = [
  'feishu_send_message',
  'feishu_send_card',
  'feishu_send_file',
  'feishu_send_image',
  'feishu_reply',
  'feishu_edit_message',
  'feishu_delete_message',
  'feishu_download',
  'feishu_bot_info',
  'feishu_render_preview',
  'feishu_parse_message',
  'feishu_send_voice',
  'feishu_transcribe',
];
const names = registered.map((t) => t.name);
check(`注册了 ${expectedTools.length} 个工具`, registered.length === expectedTools.length, `实际 ${registered.length}`);

for (const toolName of expectedTools) {
  const tool = registered.find((t) => t.name === toolName);
  check(`${toolName} 已注册`, Boolean(tool));
  if (!tool) continue;
  check(`  ${toolName} 有 description`, typeof tool.description === 'string' && tool.description.length > 10);
  check(`  ${toolName} 有 parameters 对象`, tool.parameters?.type === 'object');
  check(`  ${toolName} 有 execute 函数`, typeof tool.execute === 'function');
  check(`  ${toolName} 有 output.render`, typeof tool.output?.render === 'function');
  if (tool.parameters?.required) {
    const props = tool.parameters.properties ?? {};
    const missing = tool.parameters.required.filter((k) => !(k in props));
    check(`  ${toolName} 的 required 字段都在 properties 里`, missing.length === 0, missing.join(','));
  }
}

console.log('\n=== 工具输出契约 ===');
const preview = registered.find((t) => t.name === 'feishu_render_preview');
try {
  const out = await preview.execute({ text: '## 标题\n\n| a | b |\n| --- | --- |\n| 1 | 2 |' });
  const card = JSON.parse(out.rendered);
  check('preview 返回可解析的卡片 JSON', card.schema === '2.0');
  check('卡片含原生 table 组件', card.body.elements.some((e) => e.tag === 'table'));
  const rendered = preview.output.render({}, out);
  check('render 返回 text 片段', rendered[0].type === 'text' && rendered[0].text.length > 0);
} catch (error) {
  check('preview 执行成功', false, error.message);
}

const previewPlain = registered.find((t) => t.name === 'feishu_render_preview');
try {
  const out = await previewPlain.execute({ text: '**粗**和`码`', plain: true });
  check('plain 模式返回纯文本', out.rendered === '粗和码', out.rendered);
} catch (error) {
  check('plain 模式执行成功', false, error.message);
}

const parser = registered.find((t) => t.name === 'feishu_parse_message');
try {
  const out = await parser.execute({
    messageType: 'text',
    content: '{"text":"@_user_1 你好"}',
    mentions: '[{"key":"@_user_1","name":"张三","id":{"open_id":"ou_x"}}]',
  });
  const parsed = JSON.parse(out.json);
  check('parse 还原 @名字', parsed.textContent.includes('@张三'), parsed.textContent);
} catch (error) {
  check('parse 执行成功', false, error.message);
}

console.log('\n=== 凭据缺失时的错误处理 ===');
const sendTool = registered.find((t) => t.name === 'feishu_send_message');
const savedId = process.env.DSH_FEISHU_APP_ID;
const savedSecret = process.env.DSH_FEISHU_APP_SECRET;
const savedFid = process.env.FEISHU_APP_ID;
const savedFsecret = process.env.FEISHU_APP_SECRET;
delete process.env.DSH_FEISHU_APP_ID;
delete process.env.DSH_FEISHU_APP_SECRET;
delete process.env.FEISHU_APP_ID;
delete process.env.FEISHU_APP_SECRET;
try {
  await sendTool.execute({ text: '测试', receiveId: 'oc_test' });
  check('凭据缺失时应抛错', false, '没有抛错');
} catch (error) {
  check('凭据缺失时抛中文错误', error.message.includes('飞书凭据缺失'), error.message);
}
if (savedId) process.env.DSH_FEISHU_APP_ID = savedId;
if (savedSecret) process.env.DSH_FEISHU_APP_SECRET = savedSecret;
if (savedFid) process.env.FEISHU_APP_ID = savedFid;
if (savedFsecret) process.env.FEISHU_APP_SECRET = savedFsecret;

console.log('\n=== 无默认会话时的错误处理 ===');
const savedChat = process.env.DSH_FEISHU_CHAT_ID;
const savedHome = process.env.FEISHU_HOME_CHANNEL;
delete process.env.DSH_FEISHU_CHAT_ID;
delete process.env.FEISHU_HOME_CHANNEL;
process.env.DSH_FEISHU_APP_ID = 'cli_test';
process.env.DSH_FEISHU_APP_SECRET = 'secret_test';
try {
  await sendTool.execute({ text: '测试' });
  check('缺 receiveId 时应抛错', false, '没有抛错');
} catch (error) {
  check('缺 receiveId 时抛中文错误', error.message.includes('没有默认会话'), error.message);
}
delete process.env.DSH_FEISHU_APP_ID;
delete process.env.DSH_FEISHU_APP_SECRET;
if (savedChat) process.env.DSH_FEISHU_CHAT_ID = savedChat;
if (savedHome) process.env.FEISHU_HOME_CHANNEL = savedHome;

console.log(`\n${'='.repeat(60)}`);
if (failed > 0) {
  console.log(`失败 ${failed} 项`);
  process.exit(1);
}
console.log('加载测试全部通过 ✅');