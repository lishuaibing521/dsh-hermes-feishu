// dsh-hermes-feishu 自测：渲染层 / 入站解析 / 出站路由。
// 跑法：node test/run.mjs
import assert from 'node:assert/strict';
import {
  buildInteractiveCard,
  buildOutboundPayload,
  buildMarkdownPostPayload,
  mdHeadingsToBold,
  parseNextTable,
  buildNativeTable,
  stripMarkdownToPlainText,
} from '../lib/render.js';
import { normalizeFeishuMessage } from '../lib/inbound.js';
import { resolveOutboundFileRouting, getAudioDurationMs } from '../lib/feishu.js';

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}

console.log('\n=== 1. 表格解析 ===');

test('识别标准 Markdown 表格', () => {
  const lines = ['| 模型 | 价格 |', '| --- | --- |', '| A | 1 |', '| B | 2 |'];
  const result = parseNextTable(lines, 0);
  assert.ok(result, '应识别为表格');
  assert.equal(result.rows.length, 4);
  assert.deepEqual(result.rows[0], ['模型', '价格']);
  assert.equal(result.next, 4);
});

test('单行表格不算表格', () => {
  assert.equal(parseNextTable(['| 只有表头 |'], 0), null);
});

test('第二行不是分隔行就不算表格', () => {
  assert.equal(parseNextTable(['| a | b |', '| c | d |'], 0), null);
});

console.log('\n=== 2. 原生 table 组件 ===');

test('表格转飞书原生 table 结构', () => {
  const rows = [
    ['模型', '价格', '上下文'],
    ['---', '---', '---'],
    ['GLM-5.2', '免费', '1M'],
    ['DeepSeek', '1元', '256K'],
  ];
  const table = buildNativeTable(rows);
  assert.equal(table.tag, 'table');
  assert.equal(table.columns.length, 3);
  assert.deepEqual(table.columns[0], {
    name: 'col_0',
    display_name: '模型',
    data_type: 'text',
    width: 'auto',
  });
  assert.equal(table.rows.length, 2, '表头和分隔行不应计入 body');
  assert.equal(table.rows[0].col_0, 'GLM-5.2');
  assert.equal(table.rows[1].col_2, '256K');
});

test('单元格里的 Markdown 被剥掉', () => {
  const table = buildNativeTable([['**粗**', '`码`'], ['---', '---'], ['**值**', '`x`']]);
  assert.equal(table.rows[0].col_0, '值', '粗体标记应被剥离');
  assert.equal(table.rows[0].col_1, 'x', '行内代码标记应被剥离');
});

console.log('\n=== 3. 标题降级 ===');

test('## 与更深标题降级为粗体', () => {
  assert.equal(mdHeadingsToBold('## 标题'), '**标题**');
  assert.equal(mdHeadingsToBold('### 三级'), '**三级**');
  assert.equal(mdHeadingsToBold('###### 六级'), '**六级**');
});

test('一级标题保留（飞书卡片支持）', () => {
  assert.equal(mdHeadingsToBold('# 一级'), '# 一级');
});

test('普通文本不受影响', () => {
  assert.equal(mdHeadingsToBold('普通文字'), '普通文字');
});

console.log('\n=== 4. 卡片构建 ===');

test('含表格的 Markdown 生成卡片且表格是原生组件', () => {
  const content = '## 对比\n\n| 模型 | 价格 |\n| --- | --- |\n| A | 1 |\n\n结束';
  const card = buildInteractiveCard(content, { botName: '测试机器人' });
  assert.equal(card.schema, '2.0');
  assert.equal(card.config.wide_screen_mode, true);
  // 非 emoji 开头的机器人名会被补上 🤖 前缀（与 Hermes 一致）
  assert.equal(card.header.title.content, '\u{1F916} 测试机器人');
  assert.equal(card.header.title.tag, 'plain_text');
  assert.equal(card.header.template, 'blue');

  const tags = card.body.elements.map((e) => e.tag);
  assert.ok(tags.includes('table'), `应含原生 table 组件，实际：${tags.join(',')}`);
  assert.ok(tags.includes('markdown'));

  const tableEl = card.body.elements.find((e) => e.tag === 'table');
  assert.equal(tableEl.rows.length, 1);
  assert.equal(tableEl.rows[0].col_0, 'A');
});

test('标题在卡片里已转成粗体', () => {
  const card = buildInteractiveCard('## 二级标题');
  const md = card.body.elements.filter((e) => e.tag === 'markdown').map((e) => e.content).join('\n');
  assert.ok(md.includes('**二级标题**'), `实际内容：${md}`);
  assert.ok(!md.includes('## 二级标题'), '不应保留原始 ## 标记');
});

test('emoji 开头的机器人名不当成标题前缀处理', () => {
  const card = buildInteractiveCard('正文', { botName: '\u{1F916} 小助手' });
  assert.equal(card.header.title.content, '\u{1F916} 小助手');
});

test('空内容也生成合法卡片', () => {
  const card = buildInteractiveCard('');
  assert.equal(card.body.elements.length, 1);
  assert.equal(card.body.elements[0].content, '\u200b');
});

test('含表格时补 footer', () => {
  const content = '| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |';
  const card = buildInteractiveCard(content, { botName: 'Bot', model: 'deepseek-flash', provider: 'tokenbridge' });
  const tags = card.body.elements.map((e) => e.tag);
  assert.ok(tags.includes('hr'), '应含分隔线');
  const footerLine = card.body.elements.find(
    (e) => e.tag === 'markdown' && String(e.content).startsWith('Agent:'),
  );
  assert.ok(footerLine, '应含 Agent/Model/Provider footer');
  assert.ok(footerLine.content.includes('deepseek-flash'));
  assert.ok(footerLine.content.includes('tokenbridge'));
});

console.log('\n=== 5. 出站路由 ===');

test('纯文本短句走 text', () => {
  const r = buildOutboundPayload('好的');
  assert.equal(r.msgType, 'text');
});

test('Markdown 表格走 interactive', () => {
  const r = buildOutboundPayload('| 模型 | 价格 |\n| --- | --- |\n| A | 1 |\n| B | 2 |');
  assert.equal(r.msgType, 'interactive');
  assert.equal(r.reason, 'markdown');
  const parsed = JSON.parse(r.content);
  assert.equal(parsed.schema, '2.0');
});

test('CLI 命令输出走纯文本', () => {
  const r = buildOutboundPayload('git status\n**on branch main**');
  assert.equal(r.msgType, 'text');
  assert.equal(r.reason, 'command');
});

test('emoji 开头的短消息走纯文本', () => {
  const r = buildOutboundPayload('\u{1F525} **完成**');
  assert.equal(r.msgType, 'text');
  assert.equal(r.reason, 'emoji-lead');
});

test('纯 ASCII 短内容走纯文本', () => {
  const r = buildOutboundPayload('**OK**');
  assert.equal(r.msgType, 'text');
});

test('冒号结尾的引出行走纯文本', () => {
  // 关键：判定用的是「去掉围栏后的整段文本」的最后一个字符，
  // 所以内容必须以冒号真正收尾（不能被 ** 包住），同时别处命中 Markdown 才会进这条分支。
  const content = '**注意** 下面是本次升级的完整改动清单和每一项的具体影响范围说明：';
  const r = buildOutboundPayload(content);
  assert.equal(r.msgType, 'text');
  assert.equal(r.reason, 'colon');
});

test('无 Markdown 的纯文本原样发', () => {
  const r = buildOutboundPayload('今天天气不错，出去走走吧，顺便买点水果回来吃');
  assert.equal(r.msgType, 'text');
  assert.equal(r.reason, 'plain');
});

console.log('\n=== 6. Markdown 剥离 ===');

test('粗体/斜体/行内代码被剥离', () => {
  assert.equal(stripMarkdownToPlainText('**粗**和*斜*和`码`'), '粗和斜和码');
});

test('链接保留标签和目标', () => {
  assert.equal(stripMarkdownToPlainText('[官网](https://example.com)'), '官网 (https://example.com)');
});

test('引用块标记被剥离', () => {
  assert.equal(stripMarkdownToPlainText('> 引用内容'), '引用内容');
});

test('删除线与下划线被剥离', () => {
  assert.equal(stripMarkdownToPlainText('~~删除~~和<u>下划</u>'), '删除和下划');
});

console.log('\n=== 7. post 载荷 ===');

test('无代码块时单行', () => {
  const rows = JSON.parse(buildMarkdownPostPayload('普通文本')).zh_cn.content;
  assert.equal(rows.length, 1);
  assert.equal(rows[0][0].tag, 'md');
});

test('代码块单独成行', () => {
  const payload = JSON.parse(buildMarkdownPostPayload('说明\n```js\nconst a=1\n```\n结尾'));
  const rows = payload.zh_cn.content;
  assert.ok(rows.length >= 3, `代码块应拆行，实际 ${rows.length} 行`);
  assert.ok(rows.some((r) => r[0].text.includes('const a=1')));
});

console.log('\n=== 8. 入站归一化 ===');

test('text 消息剥出正文', () => {
  const r = normalizeFeishuMessage({ messageType: 'text', rawContent: '{"text":"你好"}' });
  assert.equal(r.textContent, '你好');
  assert.equal(r.rawType, 'text');
});

test('mention 占位符还原为 @名字', () => {
  const mentions = [{ key: '@_user_1', name: '张三', id: { open_id: 'ou_abc' } }];
  const r = normalizeFeishuMessage({
    messageType: 'text',
    rawContent: '{"text":"@_user_1 你好"}',
    mentions,
  });
  assert.ok(r.textContent.includes('@张三'), `实际：${r.textContent}`);
});

test('@_all 识别', () => {
  const r = normalizeFeishuMessage({ messageType: 'text', rawContent: '{"text":"@_all 通知"}' });
  assert.ok(r.textContent.includes('@all'));
  assert.ok(r.mentions.some((m) => m.isAll));
});

test('post 富文本解析出文本与图片 key', () => {
  const raw = JSON.stringify({
    zh_cn: {
      title: '标题',
      content: [
        [{ tag: 'text', text: '第一段 ' }, { tag: 'a', text: '链接', href: 'https://x.com' }],
        [{ tag: 'img', image_key: 'img_v2_abc' }],
      ],
    },
  });
  const r = normalizeFeishuMessage({ messageType: 'post', rawContent: raw });
  assert.ok(r.textContent.includes('标题'), r.textContent);
  assert.ok(r.textContent.includes('第一段'), r.textContent);
  assert.ok(r.textContent.includes('[链接](https://x.com)'), r.textContent);
  assert.deepEqual(r.imageKeys, ['img_v2_abc']);
  assert.equal(r.relationKind, 'post');
});

test('post 代码块还原成围栏', () => {
  const raw = JSON.stringify({
    zh_cn: { content: [[{ tag: 'code_block', language: 'js', text: 'const a=1;' }]] },
  });
  const r = normalizeFeishuMessage({ messageType: 'post', rawContent: raw });
  assert.ok(r.textContent.includes('```js'), r.textContent);
  assert.ok(r.textContent.includes('const a=1;'), r.textContent);
});

test('post 里的文件元素产生 mediaRefs', () => {
  const raw = JSON.stringify({
    zh_cn: { content: [[{ tag: 'file', file_key: 'file_v2_x', file_name: '报告.pdf' }]] },
  });
  const r = normalizeFeishuMessage({ messageType: 'post', rawContent: raw });
  assert.equal(r.mediaRefs.length, 1);
  assert.equal(r.mediaRefs[0].fileKey, 'file_v2_x');
  assert.equal(r.mediaRefs[0].fileName, '报告.pdf');
});

test('image 消息取 image_key', () => {
  const r = normalizeFeishuMessage({ messageType: 'image', rawContent: '{"image_key":"img_1"}' });
  assert.deepEqual(r.imageKeys, ['img_1']);
  assert.equal(r.preferredMessageType, 'photo');
});

test('file 消息取 file_key 与占位文本', () => {
  const r = normalizeFeishuMessage({
    messageType: 'file',
    rawContent: '{"file_key":"f_1","file_name":"合同.docx"}',
  });
  assert.equal(r.mediaRefs[0].fileKey, 'f_1');
  assert.equal(r.mediaRefs[0].fileName, '合同.docx');
  assert.ok(r.metadata.placeholderText.includes('合同.docx'));
});

test('audio 消息标记为音频', () => {
  const r = normalizeFeishuMessage({ messageType: 'audio', rawContent: '{"file_key":"f_2","duration":3000}' });
  assert.equal(r.preferredMessageType, 'audio');
  assert.equal(r.mediaRefs[0].resourceType, 'audio');
});

test('share_chat 消息解析群名', () => {
  const r = normalizeFeishuMessage({ messageType: 'share_chat', rawContent: '{"chat_name":"产品群"}' });
  assert.ok(r.textContent.includes('产品群'));
});

test('interactive 卡片消息能提取文字', () => {
  const raw = JSON.stringify({ title: { content: '卡片标题' }, elements: [{ content: '正文' }] });
  const r = normalizeFeishuMessage({ messageType: 'interactive', rawContent: raw });
  assert.ok(r.textContent.includes('卡片标题'), r.textContent);
  assert.ok(r.textContent.includes('正文'), r.textContent);
});

test('未知类型不报错', () => {
  const r = normalizeFeishuMessage({ messageType: 'sticker', rawContent: '{}' });
  assert.equal(r.textContent, '');
});

console.log('\n=== 9. 文件路由 ===');

test('ogg 走语音', () => {
  const r = resolveOutboundFileRouting('a/b/voice.ogg');
  assert.equal(r.fileType, 'opus');
  assert.equal(r.messageType, 'audio');
});

test('mp4 走视频', () => {
  const r = resolveOutboundFileRouting('clip.MP4');
  assert.equal(r.fileType, 'mp4');
  assert.equal(r.messageType, 'media');
});

test('pdf/docx/pptx 走对应文件类型', () => {
  assert.equal(resolveOutboundFileRouting('a.pdf').fileType, 'pdf');
  assert.equal(resolveOutboundFileRouting('a.docx').fileType, 'doc');
  assert.equal(resolveOutboundFileRouting('a.pptx').fileType, 'ppt');
  assert.equal(resolveOutboundFileRouting('a.xlsx').fileType, 'xls');
});

test('未知扩展名走 stream', () => {
  const r = resolveOutboundFileRouting('data.bin');
  assert.equal(r.fileType, 'stream');
  assert.equal(r.messageType, 'file');
});

console.log('\n=== 10. 音频时长 ===');

test('非 OGG 返回 0', () => {
  assert.equal(getAudioDurationMs(Buffer.from('not an ogg file at all')), 0);
});

test('伪造 OGG 头能算出时长', () => {
  // 构造一个最小 OggS 页：granule=48000 -> 1000ms
  const buf = Buffer.alloc(40);
  buf.write('OggS', 0, 'ascii');
  buf.writeBigInt64LE(48000n, 6);
  buf[26] = 0; // 0 segments -> pos += 0+0
  const ms = getAudioDurationMs(buf);
  assert.equal(ms, 1000);
});

console.log(`\n${'='.repeat(60)}`);
console.log(`通过 ${passed} / ${passed + failed}`);
if (failed > 0) {
  console.log(`失败 ${failed}：`);
  for (const f of failures) console.log(`  - ${f.name}: ${f.error.message}`);
  process.exit(1);
}
console.log('全部通过 ✅');
