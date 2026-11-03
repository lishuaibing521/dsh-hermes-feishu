// dsh-hermes-feishu — 渲染层。
//
// 直接移植自 Hermes Agent 的飞书平台适配器
// (hermes-agent/plugins/platforms/feishu/adapter.py)。这里保留它全部的输出
// 渲染逻辑：Markdown -> 飞书交互卡片(schema 2.0)、Markdown 表格 -> 飞书
// 原生 table 组件、多级标题降级为粗体、代码块拆行、纯文本降级、
// post(md) 富文本载荷。
//
// 零依赖：只用 node: 内置模块。

/** 表格行：`| a | b |` */
const TABLE_ROW_RE = /^\s*\|(.+)\|\s*$/;
/** 表格分隔行：`|---|---|` */
const TABLE_SEP_RE = /^\s*\|[-|: ]+\|\s*$/;
/** 是否含有 Markdown 表格（表头 + 分隔行） */
const HAS_TABLE_RE = /\|[\s\-:|]+\|/;
/** Markdown 特征检测（与 Python 版逐条对应） */
const MARKDOWN_HINT_RE = new RegExp(
  [
    // 管道表格：表头行 + 分隔行都以 | 开头
    String.raw`(^\|.*\|\s*\n\|[-:|\s]+\|)`,
    // 标题、列表、代码、粗体/斜体/删除线/下划线、链接、引用
    String.raw`(^#{1,6}\s)`,
    String.raw`(^\s*[-*]\s)`,
    String.raw`(^\s*\d+\.\s)`,
    String.raw`(^\s*---+\s*$)`,
    String.raw`(\x60\x60\x60)`,
    String.raw`(\x60[^\x60\n]+\x60)`,
    String.raw`(\*\*[^*\n].+?\*\*)`,
    String.raw`(~~[^~\n].+?~~)`,
    String.raw`(<u>.+?</u>)`,
    String.raw`(\*[^*\n]+\*)`,
    String.raw`(\[[^\]]+\]\([^)]+\))`,
    String.raw`(^>\s)`,
  ].join('|'),
  'm',
);
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/;
const MARKDOWN_FENCE_OPEN_RE = /^```([^\n`]*)\s*$/;
const MARKDOWN_FENCE_CLOSE_RE = /^```\s*$/;
const NEWLINE_SQUEEZE_RE = /\n{3,}/g;

/** strip_markdown 的规则表，顺序与 Python 版一致。 */
const STRIP_RULES = [
  [/\*\*(.+?)\*\*/gs, '$1'],
  [/\*(.+?)\*/gs, '$1'],
  [/\b__(?![\s_])(.+?)(?<![\s_])__\b/gs, '$1'],
  [/\b_(?![\s_])(.+?)(?<![\s_])_\b/gs, '$1'],
  [/```[a-zA-Z0-9_+-]*\n?/g, ''],
  [/`(.+?)`/g, '$1'],
  [/^#{1,6}\s+/gm, ''],
];

/**
 * 去掉 Markdown 标记，得到纯文本。
 * 对应 helpers.py 的 strip_markdown + 飞书特有的 blockquote / ~~ / <u> / hr 处理。
 */
export function stripMarkdownToPlainText(text) {
  if (typeof text !== 'string') return '';
  let plain = text.replace(/\r\n/g, '\n');
  plain = plain.replace(MARKDOWN_LINK_RE, (_m, label, url) => `${label} (${url.trim()})`);
  plain = plain.replace(/^>\s?/gm, '');
  plain = plain.replace(/^\s*---+\s*$/gm, '---');
  plain = plain.replace(/~~([^~\n]+)~~/g, '$1');
  plain = plain.replace(/<u>([\s\S]*?)<\/u>/g, '$1');
  for (const [pattern, repl] of STRIP_RULES) plain = plain.replace(pattern, repl);
  plain = plain.replace(MARKDOWN_LINK_RE, '$1');
  return plain.replace(NEWLINE_SQUEEZE_RE, '\n\n').trim();
}

/** 多级标题（## 及更深）降级为粗体 —— 飞书卡片不支持多级标题。 */
export function mdHeadingsToBold(text) {
  if (typeof text !== 'string') return '';
  return text
    .split('\n')
    .map((line) => {
      const m = /^(#{2,6})\s+(.+?)(\s+#*)?$/.exec(line.trim());
      return m ? `**${m[2]}**` : line;
    })
    .join('\n');
}

/**
 * 从 lines[start] 开始解析一段 Markdown 表格。
 * 返回 { rows, next } 或 null（不是表格）。
 */
export function parseNextTable(lines, start) {
  const rows = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    const rowMatch = TABLE_ROW_RE.exec(line);
    if (rowMatch) {
      const cells = rowMatch[1].split('|').map((x) => x.trim());
      rows.push(cells);
      i += 1;
      continue;
    }
    if (TABLE_SEP_RE.test(line)) {
      i += 1;
      continue;
    }
    break;
  }
  if (rows.length < 2 || !lines[start + 1] || !TABLE_SEP_RE.test(lines[start + 1])) return null;
  return { rows, next: i };
}

/** Markdown 表格 -> 飞书原生 table 组件。 */
export function buildNativeTable(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { tag: 'table', columns: [], rows: [] };
  }
  const headerRow = rows[0];
  const bodyRows = rows.slice(2); // 跳过表头 + 分隔行
  const nCols = headerRow.length;
  const colNames = Array.from({ length: nCols }, (_v, i) => `col_${i}`);
  const columns = colNames.map((name, i) => ({
    name,
    display_name: stripMarkdownToPlainText((headerRow[i] ?? '').trim()) || ' ',
    data_type: 'text',
    width: 'auto',
  }));
  const tableRows = bodyRows.map((row) => {
    const cells = {};
    for (let j = 0; j < Math.min(row.length, nCols); j += 1) {
      cells[colNames[j]] = row[j] ? stripMarkdownToPlainText(row[j].trim()) : ' ';
    }
    return cells;
  });
  return { tag: 'table', columns, rows: tableRows };
}

/** 判断首字符是否是 emoji（Unicode 类别 So）。 */
function isEmojiLead(text) {
  if (!text) return false;
  const first = [...text][0];
  return /\p{So}/u.test(first);
}

/**
 * 构建飞书交互卡片（schema 2.0）。
 * 对应 adapter.py 的 _build_feishu_interactive_card。
 */
export function buildInteractiveCard(content, options = {}) {
  const { botName = '', model = '', provider = '', footer = true } = options;
  const text = mdHeadingsToBold(content);
  const elements = [];
  const lines = text.split('\n');
  let textBuf = [];
  const flushText = () => {
    if (textBuf.length === 0) return;
    const joined = textBuf.join('\n').trim();
    if (joined) elements.push({ tag: 'markdown', content: joined });
    textBuf = [];
  };
  let i = 0;
  while (i < lines.length) {
    const table = parseNextTable(lines, i);
    if (table && table.rows.length >= 2) {
      flushText();
      elements.push(buildNativeTable(table.rows));
      i = table.next;
    } else {
      textBuf.push(lines[i]);
      i += 1;
    }
  }
  flushText();

  const name = (botName || '').trim() || 'AI 助手';
  const cardTitle = isEmojiLead(name) ? name : `\u{1F916} ${name}`;

  // 只在内容确实含表格/多代码块时补 footer，避免每条短消息都挂一行。
  if (footer && model && provider && (content.split('|').length - 1 >= 6 || content.split('```').length - 1 >= 2)) {
    const footerName = isEmojiLead(name) ? name.slice(2) : name;
    const shortModel = String(model).split('/').pop();
    elements.push({ tag: 'hr', margin: '-6px 0px -6px 0px' });
    elements.push({
      tag: 'markdown',
      content: `Agent:${footerName} | Model:${shortModel} | Provider:${provider}`,
      margin: '0px',
    });
  }

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: cardTitle }, template: 'blue' },
    body: { elements: elements.length > 0 ? elements : [{ tag: 'markdown', content: '\u200b' }] },
  };
}

/** 卡片 -> JSON 字符串载荷。 */
export function buildInteractivePayload(content, options = {}) {
  return JSON.stringify(buildInteractiveCard(content, options));
}

/**
 * 构建 post(md) 富文本载荷，把每个围栏代码块单独成行。
 * 飞书的 md 渲染器在单个大元素里遇到代码块时会吞掉后面的内容。
 */
export function buildMarkdownPostRows(content) {
  if (!content) return [[{ tag: 'md', text: '' }]];
  if (!content.includes('```')) return [[{ tag: 'md', text: content }]];

  const rows = [];
  let current = [];
  let inCodeBlock = false;
  const flush = () => {
    const segment = current.join('\n');
    if (segment.trim()) rows.push([{ tag: 'md', text: segment }]);
    current = [];
  };
  for (const rawLine of content.split('\n')) {
    const fenceRe = inCodeBlock ? MARKDOWN_FENCE_CLOSE_RE : MARKDOWN_FENCE_OPEN_RE;
    const isFence = fenceRe.test(rawLine.trim());
    if (isFence && !inCodeBlock) flush(); // 开围栏：之前的正文单独成行
    current.push(rawLine);
    if (isFence) {
      inCodeBlock = !inCodeBlock;
      if (!inCodeBlock) flush(); // 闭围栏：代码块单独成行
    }
  }
  flush();
  return rows.length > 0 ? rows : [[{ tag: 'md', text: content }]];
}

/** post 载荷 JSON。 */
export function buildMarkdownPostPayload(content) {
  return JSON.stringify({ zh_cn: { content: buildMarkdownPostRows(content) } });
}

/** 媒体 post 载荷：正文 + 一个媒体标签。 */
export function buildMediaPostPayload({ caption = '', mediaTag }) {
  const payload = JSON.parse(buildMarkdownPostPayload(caption));
  const content = (payload.zh_cn ??= {}).content ?? (payload.zh_cn.content = []);
  content.push([mediaTag]);
  return JSON.stringify(payload);
}

/** 走纯文本的 CLI 命令词表（照抄 Python 版）。 */
const COMMAND_KEYWORDS = new Set(
  `rtk rm find git lint curl next ls grep read docker summary test playwright python python3 tasklist cd cat head tail cp mv chmod chown touch mkdir rmdir pwd which where file stat tree more less ps top htop kill whoami uname hostname date clear env set echo export alias history reboot shutdown wget ssh scp ftp telnet netstat ipconfig ping traceroute mount df du free fdisk chkdsk sfc npm npx yarn pnpm pip brew apt yum make cmake gcc go rustc java javac awk sed sort uniq wc diff cut tr tee xargs nano vim code open start man info dir type copy move del cls exit call choice systeminfo taskkill reg sc schtasks netsh format bash sh zsh source sudo cargo pytest node powershell powershell.exe sleep cmd cmd.exe kubectl gh hermes openclaw timeout`.split(
    /\s+/,
  ),
);

/** 前缀判定表：`A=1`、`C=abc` 这类赋值行也走纯文本。 */
const COMMAND_PREFIXES = [
  'a=', 'b=', 'c=', 'd=', 'e=', 'f=', 'g=', 'h=', 'i=', 'j=', 'k=', 'l=', 'm=',
  'n=', 'o=', 'p=', 'q=', 'r=', 's=', 't=', 'u=', 'v=', 'w=', 'x=', 'y=', 'z=',
  'ssh=', 'pid=', 'sshopt=',
];

/**
 * 出站载荷路由：决定用 text 还是 interactive 卡片。
 * 对应 adapter.py 的 _build_outbound_payload。
 * @returns {{ msgType: 'text'|'interactive', content: string, reason: string }}
 */
export function buildOutboundPayload(content, options = {}) {
  const { preferCard = false } = options;
  const withoutFences = content.replace(/^```[^\n]*\n?|```\s*$/gm, '').trim();
  const hasMarkdown = MARKDOWN_HINT_RE.test(content) || HAS_TABLE_RE.test(content);
  const pipeCount = content.split('|').length - 1;
  const asText = (reason) => ({
    msgType: 'text',
    content: JSON.stringify({ text: stripMarkdownToPlainText(content) }),
    reason,
  });
  const asCard = (reason) => ({
    msgType: 'interactive',
    content: buildInteractivePayload(content, options),
    reason,
  });

  // 显式要求卡片时直接走卡片，跳过全部降级判定
  if (preferCard && hasMarkdown) return asCard('forced');

  if (hasMarkdown) {
    const first = withoutFences ? [...withoutFences][0] : '';
    // emoji 开头且表格列少 -> 纯文本
    if (first && isEmojiLead(first) && pipeCount < 9) return asText('emoji-lead');
    // CLI 命令词 / 赋值前缀开头 -> 纯文本
    const firstWord = (withoutFences.split(' ')[0] || '').toLowerCase();
    const lower = withoutFences.toLowerCase();
    if ((COMMAND_KEYWORDS.has(firstWord) || COMMAND_PREFIXES.some((p) => lower.startsWith(p))) && pipeCount < 9) {
      return asText('command');
    }
    // 纯 ASCII 短文本、或极短文本 -> 纯文本
    const isAsciiShort = [...withoutFences].every((ch) => ch.codePointAt(0) < 128) && withoutFences.length < 200;
    if ((isAsciiShort || withoutFences.length < 25) && pipeCount < 9) return asText('short');
    // 以冒号结尾（像是引出行）-> 纯文本
    if (withoutFences && [':', '：'].includes(withoutFences.slice(-1)) && pipeCount < 9) return asText('colon');
    return asCard('markdown');
  }
  return { msgType: 'text', content: JSON.stringify({ text: content }), reason: 'plain' };
}

/** 把 markdown 文本包成内联代码（处理内部已有反引号的情况）。 */
export function wrapInlineCode(text) {
  const runs = [...String(text).matchAll(/`+/g)].map((m) => m[0].length);
  const maxRun = runs.length > 0 ? Math.max(...runs) : 0;
  const fence = '`'.repeat(maxRun + 1);
  const body = String(text).startsWith('`') || String(text).endsWith('`') ? ` ${text} ` : String(text);
  return `${fence}${body}${fence}`;
}

/** 清理围栏语言标记。 */
export function sanitizeFenceLanguage(language) {
  return String(language ?? '').trim().replace(/[\n\r]/g, ' ');
}

/** post 代码块元素 -> Markdown 围栏。 */
export function renderCodeBlockElement(element) {
  const language = sanitizeFenceLanguage(element?.language ?? element?.lang ?? '');
  const code = String(element?.text ?? element?.content ?? '').replace(/\r\n/g, '\n');
  const trailingNewline = code.endsWith('\n') ? '' : '\n';
  return `\`\`\`${language}\n${code}${trailingNewline}\`\`\``;
}
