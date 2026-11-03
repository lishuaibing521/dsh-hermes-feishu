// dsh-hermes-feishu — 入站消息归一化。
//
// 移植自 adapter.py 的 normalize_feishu_message 及其依赖：
//   - post（富文本）解析：text / code_block / a / at / img / media / emotion / code / br / hr
//   - image / file / audio / media / merge_forward / share_chat / interactive
//   - mention 占位符还原、空白归一化
//
// 输出统一结构：
//   {
//     rawType, textContent, preferredMessageType,
//     imageKeys: [], mediaRefs: [{fileKey, fileName, resourceType}],
//     mentions: [{key, name, openId, userId, isAll, isSelf}],
//     relationKind, metadata
//   }

const MENTION_PLACEHOLDER_RE = /@_user_\d+/g;
const MULTISPACE_RE = /[ \t]{2,}/g;

const FALLBACK_POST_TEXT = '[富文本消息]';
const FALLBACK_IMAGE_TEXT = '[图片]';
const FALLBACK_ATTACHMENT_TEXT = '[附件]';

const STATIC_POST_TAGS = {
  br: '\n',
  hr: '\n\n---\n\n',
  divider: '\n\n---\n\n',
};

const TEXT_STYLE_WRAPPERS = [
  ['bold', '**', '**'],
  ['italic', '*', '*'],
  ['underline', '<u>', '</u>'],
  ['strikethrough', '~~', '~~'],
];

const MARKDOWN_SPECIAL_CHARS_RE = /([\\`*_{}[\]()#+\-!|>~])/g;

function escapeMarkdownText(text) {
  return String(text ?? '').replace(MARKDOWN_SPECIAL_CHARS_RE, '\\$1');
}

function styleEnabled(style, key) {
  return Boolean(style && typeof style === 'object' && style[key]);
}

function wrapInlineCode(text) {
  const runs = [...String(text).matchAll(/`+/g)].map((m) => m[0].length);
  const maxRun = runs.length > 0 ? Math.max(...runs) : 0;
  const fence = '`'.repeat(maxRun + 1);
  const body = String(text).startsWith('`') || String(text).endsWith('`') ? ` ${text} ` : String(text);
  return `${fence}${body}${fence}`;
}

function renderTextElement(element) {
  const text = String(element?.text ?? '');
  const style = element?.style && typeof element.style === 'object' ? element.style : undefined;
  if (styleEnabled(style, 'code')) return wrapInlineCode(text);
  let rendered = text;
  if (!rendered) return '';
  for (const [key, prefix, suffix] of TEXT_STYLE_WRAPPERS) {
    if (styleEnabled(style, key)) rendered = `${prefix}${rendered}${suffix}`;
  }
  return rendered;
}

function renderCodeBlockElement(element) {
  const language = String(element?.language ?? element?.lang ?? '')
    .trim()
    .replace(/[\n\r]/g, ' ');
  const code = String(element?.text ?? element?.content ?? '').replace(/\r\n/g, '\n');
  const trailing = code.endsWith('\n') ? '' : '\n';
  return `\`\`\`${language}\n${code}${trailing}\`\`\``;
}

/** 归一化飞书文本：还原 mention 占位符、压空白、去空行。 */
export function normalizeFeishuText(text, mentionsMap = new Map()) {
  let cleaned = String(text ?? '').replace(MENTION_PLACEHOLDER_RE, (match) => {
    const ref = mentionsMap.get(match);
    return ref ? `@${ref.name || ref.openId || 'user'}` : ' ';
  });
  cleaned = cleaned.replace(/@_all/g, '@all');
  cleaned = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // 逐行处理，但 ``` 围栏块内原样保留 —— 缩进和空行是代码的语法，
  // 无差别压空白会把用户贴的 Python 代码变成跑不了的一坨。
  const out = [];
  let inFence = false;
  for (const raw of cleaned.split('\n')) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      out.push(raw.trim());
      continue;
    }
    if (inFence) {
      out.push(raw.replace(/\s+$/, ''));   // 只削行尾空白，缩进照留
      continue;
    }
    const line = raw.replace(/\s+/g, ' ').replace(MULTISPACE_RE, ' ').trim();
    if (line) out.push(line);              // 正文里的空行丢掉
  }
  return out.join('\n').trim();
}

/** 从 mention 对象里取 (openId, userId)。event 给嵌套对象，message.get 给字符串 + id_type。 */
function extractMentionIds(mention) {
  const mentionId = mention?.id;
  if (typeof mentionId === 'string') {
    const idType = String(mention?.id_type ?? '').toLowerCase();
    if (idType === 'open_id') return [mentionId, ''];
    if (idType === 'user_id') return ['', mentionId];
    return ['', ''];
  }
  if (mentionId && typeof mentionId === 'object') {
    return [String(mentionId.open_id ?? ''), String(mentionId.user_id ?? '')];
  }
  return ['', ''];
}

/** 构建 mention 占位符 -> 引用 的映射。 */
export function buildMentionsMap(mentions = [], bot = {}) {
  const result = new Map();
  for (const mention of mentions ?? []) {
    const key = String(mention?.key ?? '');
    if (!key) continue;
    if (key === '@_all') {
      result.set(key, { key, isAll: true });
      continue;
    }
    const [openId, userId] = extractMentionIds(mention);
    const name = String(mention?.name ?? '').trim();
    const isSelf =
      (bot.openId && openId === bot.openId) ||
      (bot.userId && userId === bot.userId) ||
      (bot.name && name && name === bot.name);
    result.set(key, { key, name, openId, userId, isSelf: Boolean(isSelf) });
  }
  return result;
}

/** 判断消息是否 @ 了机器人。 */

function joinNestedPosts(values, imageKeys, mediaRefs, mentionsMap) {
  return [...values]
    .map((item) => renderPostElement(item, imageKeys, mediaRefs, mentionsMap))
    .filter(Boolean)
    .join(' ');
}

/** 渲染单个 post 元素为 Markdown 文本。 */
export function renderPostElement(element, imageKeys, mediaRefs, mentionsMap) {
  if (typeof element === 'string') return element;
  // 某些富文本节点的子元素直接是数组；不先展开的话会掉进下面的对象分支，
  // tag 为空、字段都是 undefined，最后一个字都读不出来（静默丢内容）。
  if (Array.isArray(element)) {
    return element
      .map((child) => renderPostElement(child, imageKeys, mediaRefs, mentionsMap))
      .filter(Boolean)
      .join('');
  }
  if (!element || typeof element !== 'object') return '';

  const tag = String(element.tag ?? '').toLowerCase();
  if (STATIC_POST_TAGS[tag] !== undefined) return STATIC_POST_TAGS[tag];

  if (tag === 'text') return renderTextElement(element);
  if (tag === 'code_block' || tag === 'pre') return renderCodeBlockElement(element);

  if (tag === 'a') {
    const href = String(element.href ?? '').trim();
    const label = String(element.text ?? href ?? '').trim();
    if (!label) return '';
    const escaped = escapeMarkdownText(label);
    return href ? `[${escaped}](${href})` : escaped;
  }

  if (tag === 'at') {
    const placeholder = String(element.user_id ?? '').trim();
    if (placeholder === '@_all') {
      if (mentionsMap && !mentionsMap.has('@_all')) mentionsMap.set('@_all', { key: '@_all', isAll: true });
      return '@all';
    }
    const ref = mentionsMap?.get(placeholder);
    const displayName = ref
      ? ref.name || ref.openId || 'user'
      : String(element.user_name ?? '').trim() || 'user';
    return `@${escapeMarkdownText(displayName)}`;
  }

  if (tag === 'img' || tag === 'image') {
    const imageKey = String(element.image_key ?? '').trim();
    if (imageKey && !imageKeys.includes(imageKey)) imageKeys.push(imageKey);
    const alt = String(element.text ?? '').trim() || String(element.alt ?? '').trim();
    return alt ? `[Image: ${alt}]` : '[Image]';
  }

  if (['media', 'file', 'audio', 'video'].includes(tag)) {
    const fileKey = String(element.file_key ?? '').trim();
    const fileName =
      [element.file_name, element.title, element.text].map((v) => String(v ?? '').trim()).find(Boolean) ?? '';
    const placeholder = fileName ? `[Attachment: ${fileName}]` : '[Attachment]';
    if (!fileKey) return placeholder;
    if (!mediaRefs.some((ref) => ref.fileKey === fileKey)) {
      mediaRefs.push({
        fileKey,
        fileName,
        resourceType: tag === 'audio' || tag === 'video' ? tag : 'file',
      });
      return placeholder;
    }
    return '';
  }

  if (tag === 'emotion' || tag === 'emoji') {
    const label = String(element.text ?? '').trim() || String(element.emoji_type ?? '').trim();
    return label ? `:${escapeMarkdownText(label)}:` : '[Emoji]';
  }

  if (tag === 'code') {
    const code = String(element.text ?? '') || String(element.content ?? '');
    return code ? wrapInlineCode(code) : '';
  }

  return joinNestedPosts(
    [element.text, element.title, element.content, element.children, element.elements],
    imageKeys,
    mediaRefs,
    mentionsMap,
  );
}

/** 选择要用的 locale 载荷（zh_cn / en_us 优先）。 */
function resolveLocalePayload(payload) {
  const toPost = (candidate) => {
    if (!candidate || typeof candidate !== 'object') return undefined;
    if (Array.isArray(candidate.content)) return candidate;
    return undefined;
  };
  const direct = toPost(payload);
  if (direct) return direct;
  if (!payload || typeof payload !== 'object') return undefined;
  const preferred = ['zh_cn', 'en_us'];
  for (const key of preferred) {
    const candidate = toPost(payload[key]);
    if (candidate) return candidate;
  }
  for (const value of Object.values(payload)) {
    const candidate = toPost(value);
    if (candidate) return candidate;
  }
  return undefined;
}

function resolvePostPayload(payload) {
  return resolveLocalePayload(payload) ?? resolveLocalePayload(payload?.post) ?? undefined;
}

/** 解析 post 富文本载荷。 */
export function parsePostPayload(payload, outerMentions = null) {
  const resolved = resolvePostPayload(payload);
  if (!resolved) return { textContent: FALLBACK_POST_TEXT, imageKeys: [], mediaRefs: [], mentions: [] };
  const imageKeys = [];
  const mediaRefs = [];
  // 复用外层已经建好的映射：post 里的 <at> 只带 user_id，不带名字，
  // 自己 new 一个空 Map 的话查不到 name，mention 只能退化成 "@user"。
  const mentionsMap = new Map(outerMentions ?? []);
  const parts = [];
  const title = normalizeFeishuText(resolved.title ?? '');
  if (title) parts.push(title);
  for (const row of resolved.content ?? []) {
    if (!Array.isArray(row)) continue;
    const rowText = normalizeFeishuText(
      row.map((item) => renderPostElement(item, imageKeys, mediaRefs, mentionsMap)).join(''),
    );
    if (rowText) parts.push(rowText);
  }
  for (const entry of resolved.files ?? []) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.is_folder) continue;
    if (!String(entry.file_key ?? '').trim()) continue;
    const placeholder = renderPostElement({ ...entry, tag: 'file' }, imageKeys, mediaRefs, mentionsMap);
    if (placeholder) parts.push(placeholder);
  }
  const textContent = parts.join('\n').trim() || FALLBACK_POST_TEXT;
  return { textContent, imageKeys, mediaRefs, mentions: [...mentionsMap.values()] };
}

function firstTextField(payload, keys) {
  for (const key of keys) {
    const value = payload?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function attachmentPlaceholder(fileName) {
  const normalized = normalizeFeishuText(fileName ?? '');
  return normalized ? `[Attachment: ${normalized}]` : FALLBACK_ATTACHMENT_TEXT;
}

function buildMediaRefFromPayload(payload, resourceType) {
  const fileKey = String(payload?.file_key ?? '').trim();
  const fileName = firstTextField(payload, ['file_name', 'title', 'text']);
  const effectiveType = resourceType === 'audio' || resourceType === 'video' ? resourceType : 'file';
  return { fileKey, fileName, resourceType: effectiveType };
}

/** 递归收集卡片里的文本行（用于解析 interactive 消息）。 */
function collectCardLines(payload, out = [], depth = 0) {
  if (payload === null || payload === undefined) return out;
  if (depth > 12) return out;   // 防环 / 防超深嵌套
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (!trimmed || trimmed === '[卡片消息]') return out;
    // 合并转发的 body.content 是「JSON 字符串」，里面才是真正的正文
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        collectCardLines(JSON.parse(trimmed), out, depth + 1);
        return out;
      } catch {
        /* 不是 JSON 就按普通文本收 */
      }
    }
    out.push(trimmed);
    return out;
  }
  if (Array.isArray(payload)) {
    for (const item of payload) collectCardLines(item, out, depth + 1);
    return out;
  }
  if (typeof payload === 'object') {
    // 补 header / body：飞书卡片 2.0 把内容藏在 header.title 和 body.elements 里，
    // 老白名单只认 1.0 的 title/elements，导致本插件自己发的卡片读回来只剩占位符。
    // 补 message_list：合并转发的每条正文都在这里面。
    for (const key of [
      'header', 'body', 'title', 'content', 'text', 'elements', 'fields',
      'columns', 'rows', 'lines', 'message_list', 'messages',
    ]) {
      if (payload[key] !== undefined) collectCardLines(payload[key], out, depth + 1);
    }
  }
  return out;
}

/**
 * 归一化一条入站飞书消息。
 * @param {object} params
 * @param {string} params.messageType text | post | image | file | audio | media | merge_forward | share_chat | interactive
 * @param {string|object} params.rawContent 飞书给的 content（JSON 字符串或已解析对象）
 * @param {Array} [params.mentions]
 * @param {object} [params.bot] { openId, userId, name }
 */
export function normalizeFeishuMessage({ messageType, rawContent, mentions = [], bot = {} }) {
  const normalizedType = String(messageType ?? '').trim().toLowerCase();
  let payload = {};
  try {
    payload = typeof rawContent === 'string' ? JSON.parse(rawContent) : rawContent ?? {};
  } catch {
    payload = { text: String(rawContent ?? '') };
  }
  const mentionsMap = buildMentionsMap(mentions, bot);

  if (normalizedType === 'text') {
    const text = String(payload.text ?? '');
    if (text.includes('@_all') && !mentionsMap.has('@_all')) {
      mentionsMap.set('@_all', { key: '@_all', isAll: true });
    }
    return {
      rawType: normalizedType,
      textContent: normalizeFeishuText(text, mentionsMap),
      imageKeys: [],
      mediaRefs: [],
      mentions: [...mentionsMap.values()],
      relationKind: undefined,
      metadata: {},
    };
  }

  if (normalizedType === 'post') {
    const parsed = parsePostPayload(payload, mentionsMap);
    const merged = new Map(mentionsMap);
    for (const ref of parsed.mentions) if (ref.key) merged.set(ref.key, ref);
    return {
      rawType: normalizedType,
      textContent: parsed.textContent,
      imageKeys: parsed.imageKeys,
      mediaRefs: parsed.mediaRefs,
      mentions: [...merged.values()],
      relationKind: 'post',
      metadata: {},
    };
  }

  const mentionRefs = [...mentionsMap.values()];

  if (normalizedType === 'image') {
    const imageKey = String(payload.image_key ?? '').trim();
    const alt = normalizeFeishuText(
      String(payload.text ?? '') || String(payload.alt ?? '') || FALLBACK_IMAGE_TEXT,
      mentionsMap,
    );
    return {
      rawType: normalizedType,
      textContent: alt === FALLBACK_IMAGE_TEXT ? '' : alt,
      preferredMessageType: 'photo',
      imageKeys: imageKey ? [imageKey] : [],
      mediaRefs: [],
      mentions: mentionRefs,
      relationKind: 'image',
      metadata: {},
    };
  }

  if (['file', 'audio', 'media'].includes(normalizedType)) {
    const mediaRef = buildMediaRefFromPayload(payload, normalizedType);
    return {
      rawType: normalizedType,
      textContent: '',
      preferredMessageType: normalizedType === 'audio' ? 'audio' : 'document',
      imageKeys: [],
      mediaRefs: mediaRef.fileKey ? [mediaRef] : [],
      mentions: mentionRefs,
      relationKind: normalizedType,
      metadata: { placeholderText: attachmentPlaceholder(mediaRef.fileName) },
    };
  }

  if (normalizedType === 'merge_forward') {
    const entries = collectCardLines(payload);
    return {
      rawType: normalizedType,
      textContent: entries.join('\n') || '[合并转发消息]',
      imageKeys: [],
      mediaRefs: [],
      mentions: mentionRefs,
      relationKind: 'merge_forward',
      metadata: {},
    };
  }

  if (normalizedType === 'share_chat') {
    const title = String(payload.chat_name ?? payload.name ?? '').trim();
    return {
      rawType: normalizedType,
      textContent: title ? `[群名片：${title}]` : '[群名片]',
      imageKeys: [],
      mediaRefs: [],
      mentions: mentionRefs,
      relationKind: 'share_chat',
      metadata: {},
    };
  }

  if (normalizedType === 'interactive' || normalizedType === 'card') {
    const lines = collectCardLines(payload);
    return {
      rawType: normalizedType,
      textContent: lines.join('\n').trim() || '[卡片消息]',
      imageKeys: [],
      mediaRefs: [],
      mentions: mentionRefs,
      relationKind: 'interactive',
      metadata: {},
    };
  }

  return {
    rawType: normalizedType,
    textContent: '',
    imageKeys: [],
    mediaRefs: [],
    mentions: mentionRefs,
    relationKind: undefined,
    metadata: {},
  };
}