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
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;   // 必须带 g：不带只换第一个链接
const MARKDOWN_FENCE_OPEN_RE = /^```([^\n`]*)\s*$/;
const MARKDOWN_FENCE_CLOSE_RE = /^```\s*$/;
const NEWLINE_SQUEEZE_RE = /\n{3,}/g;

/** strip_markdown 的规则表，顺序与 Python 版一致。 */
const STRIP_RULES = [
  // 先剥列表标记：`* 第一步` 的星号是 bullet，不是斜体。
  // 交给下面的斜体规则会被吃成空行，列表结构就没了。
  [/^[ \t]*[*+-][ \t]+/gm, ''],
  [/\*\*(.+?)\*\*/gs, '$1'],
  // 斜体只在同一行内配对（去掉 s 标志）：原来 /gs 会跨行把
  // `2 * 3` 和下一行的 `4 * 5` 配成一对，乘号和通配符都被吃掉。
  // 紧邻内容才算斜体：`*强调*` 去掉星号，`2 * 3` 这种星号两侧都是空格的是乘号，保留。
  [/\*(?!\s)([^*\n]*?\S)\*/g, '$1'],
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
  let inFence = false;
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return line;
      }
      // 代码块里的 ## 是注释（bash/python 都这样），不是标题，别改
      if (inFence) return line;
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
  // 列数以「表头」和「正文最长行」的较大者为准：
  // 原来只用表头宽度，正文多出来的单元格会被 Math.min 静默丢掉，
  // 用户发现表格少了一列还不知道为什么。
  const nCols = Math.max(headerRow.length, ...bodyRows.map((r) => r.length), 0);
  const colNames = Array.from({ length: nCols }, (_v, i) => `col_${i}`);
  const columns = colNames.map((name, i) => ({
    name,
    display_name: stripMarkdownToPlainText((headerRow[i] ?? '').trim()) || `列${i + 1}`,
    data_type: 'text',
    width: 'auto',
  }));
  const tableRows = bodyRows.map((row) => {
    const cells = {};
    // 遍历全部列：短行补空格，长行不丢
    for (let j = 0; j < nCols; j += 1) {
      const cell = row[j];
      cells[colNames[j]] = cell ? stripMarkdownToPlainText(cell.trim()) : ' ';
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
 * 剥掉开头的 emoji，返回真正的名字。
 *
 * 不能用 slice(2)：那假设所有 emoji 都占 2 个 UTF-16 码元。
 * 🤖 是代理对（2 码元）没错，但 ⚡(U+26A1)、★、☀ 在 BMP 区只占 1 个，
 * slice(2) 会把名字第一个真字符一起切掉（「⚡助手」→「手」）。
 * 这里按码点逐个判断，连变体选择符和 ZWJ 组合一起处理。
 */
function stripLeadEmoji(text) {
  let rest = String(text ?? '');
  for (;;) {
    const first = [...rest][0];
    if (!first) break;
    const isPict = /\p{So}/u.test(first) || /\p{Extended_Pictographic}/u.test(first);
    if (!isPict && first !== '\uFE0F' && first !== '\u200D') break;
    rest = rest.slice(first.length);
  }
  return rest.trimStart();
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
  let inFence = false;   // 代码块内的竖线不是表格，是 ASCII 画图
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      textBuf.push(line);
      i += 1;
      continue;
    }
    if (inFence) {
      // 围栏内一律按正文处理，不做表格探测 —— 否则 ```sql 里画的表
      // 会被拆成「开围栏 / 原生表 / 闭围栏」三段，渲染出未闭合的代码块。
      textBuf.push(line);
      i += 1;
      continue;
    }
    const table = parseNextTable(lines, i);
    // 只有表头 + 分隔行、没有数据行的「空表」不转原生表格：
    // 飞书对 table 的 rows 有校验，空 rows 很可能让整张卡片发不出去。
    if (table && table.rows.length > 2) {
      flushText();
      elements.push(buildNativeTable(table.rows));
      i = table.next;
    } else {
      textBuf.push(line);
      i += 1;
    }
  }
  flushText();

  const name = (botName || '').trim() || 'AI 助手';
  const cardTitle = isEmojiLead(name) ? name : `\u{1F916} ${name}`;

  // 只在内容确实含表格/多代码块时补 footer，避免每条短消息都挂一行。
  if (footer && model && provider && (content.split('|').length - 1 >= 6 || content.split('```').length - 1 >= 2)) {
    const footerName = stripLeadEmoji(name) || name;
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
