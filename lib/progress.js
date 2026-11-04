// dsh-hermes-feishu — 进度气泡（模仿 Hermes 的 tool progress）。
//
// Hermes 的做法不是把工具调用塞进回答卡片，而是单独开一条「可编辑的进度气泡」，
// 每来一个工具就往里追加一行、原地编辑；内容回答完成时这条气泡收尾，
// 最终回答再另发一条消息。
//
// 这里照做：
//   - 第一个工具调用时创建进度气泡（普通 text 消息，reply 到用户消息下）
//   - 后续工具每次追加一行，节流编辑（600ms 合并）
//   - 气泡超过长度上限就收尾、另起一条
//   - 结束时编辑成「已完成」状态并停手

const THROTTLE_MS = 600;
const TEXT_LIMIT = 3000;
const MAX_DETAIL = 60;

// 模型习惯把「用户说了什么」当思考开头复述一遍，这类没有信息量，不往气泡里放。
// 中英两种写法都覆盖；只匹配开头，避免误杀正文里正常提到用户的内容。
const USER_ECHO_RE =
  /^(The user|User)\s+(says|said|asks|asked|wants|wanted|is asking|requested|repeated|confirmed|approved|told me|tells me|asks me)|^用户\s*(说|问|要求|想|表示|确认|同意|补充|重复|让|叫|指出|提到|又)/i;

/** 工具显示名 + emoji（没配色表就统一用 🔧）。 */
const TOOL_EMOJI = {
  ops_bash: '💻',
  ops_glob: '🔍',
  ops_grep: '🔍',
  ops_read: '📖',
  ops_inspect_local_file: '📖',
  ops_write: '✍️',
  ops_edit: '✏️',
  ops_discover_tools: '🧭',
  working_directory: '📁',
  web_search: '🌐',
  web_fetch: '🌐',
  delegate_task: '🤝',
  todo_list: '📋',
};

function emojiFor(name) {
  return TOOL_EMOJI[name] ?? '🔧';
}

// 去掉已有的 ` (×N)` 尾巴，还原出可比较的原始行。
const REPEAT_RE = / \(×\d+\)$/;
function stripRepeat(line) {
  return typeof line === 'string' ? line.replace(REPEAT_RE, '') : line;
}

// ── shell 命令摘要（照搬 Hermes agent/display.py 的 summarize_shell_command）──
//
// 为什么必须做这一步：显示行只截前 N 个字符，如果直接拿原始命令去截，
// 一堆都以 `cd D:/project/xxx && ...` 开头的命令会砍成完全一样的字符串，
// 去重时被误判成「同一个动作做了 N 次」，冒出假的 (×N)。
// Hermes 的处理是先把命令摘要化（丢掉 cd/export 这类静默头、丢掉 | head/tail 管道尾、
// 多段命令合成 `first + N 条命令`），再截断。摘要后不同的命令就能区分开，
// 真正相同的命令也仍然相同 —— 这套口径在 Hermes 侧已经用了很久。
const SHELL_SILENT_HEADS = new Set(['cd', 'pushd', 'popd', 'export', 'set', 'unset', 'source', '.', 'true', 'false', ':']);
const SHELL_PIPE_TAIL_HEADS = new Set(['head', 'tail', 'wc', 'sort', 'uniq']);

function shellBasename(head) {
  return head ? head.slice(head.lastIndexOf('/') + 1) : '';
}

/** 逐字符扫描，产出 (index, char, insideQuotes)。 */
function scanQuoted(text) {
  const out = [];
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      out.push([i, ch, true]);
      if (ch === quote && (i === 0 || text[i - 1] !== '\\')) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      out.push([i, ch, true]);
    } else {
      out.push([i, ch, false]);
    }
  }
  return out;
}

function splitShellWords(segment) {
  const parts = [[]];
  for (const [, ch, quoted] of scanQuoted(segment)) {
    if (!quoted && /\s/.test(ch)) parts.push([]);
    else parts[parts.length - 1].push(ch);
  }
  return parts.filter((p) => p.length).map((p) => p.join(''));
}

/** 丢掉结尾的 | head/tail/wc/sort/uniq 管道段。 */
function stripShellPipeTail(segment) {
  let words = splitShellWords(segment);
  for (let i = 0; i < words.length; i += 1) {
    if (words[i] === '|' && SHELL_PIPE_TAIL_HEADS.has(shellBasename(words[i + 1] ?? ''))) {
      words = words.slice(0, i);
      break;
    }
  }
  return words.join(' ').trim();
}

/** 按未加引号的 && / || / ; / 换行切段，每段再丢掉管道尾。 */
function splitShellCompound(command) {
  const raw = [[]];
  let skip = false;
  for (const [i, ch, quoted] of scanQuoted(command)) {
    const two = command.slice(i, i + 2);
    if (skip) skip = false;
    else if (!quoted && (two === '&&' || two === '||')) {
      raw.push([]);
      skip = true;
    } else if (!quoted && (ch === ';' || ch === '\n')) raw.push([]);
    else raw[raw.length - 1].push(ch);
  }
  return raw.map((buf) => stripShellPipeTail(buf.join('').trim())).filter(Boolean);
}

/** 段的命令名，跳过开头的 VAR=value 赋值。 */
function shellHeadWord(segment) {
  const words = splitShellWords(segment);
  while (words.length && /^[A-Za-z_]\w*=/.test(words[0])) words.shift();
  return shellBasename(words[0] ?? '');
}

/** 丢掉重定向（> file、2>&1）。 */
function cleanShellSegment(segment) {
  const words = splitShellWords(segment);
  const out = [];
  let i = 0;
  while (i < words.length) {
    const word = words[i];
    if (/^\d*(?:>>?|<)$/.test(word)) i += 2;
    else if (/^\d*(?:>&|<&)\d+$/.test(word)) i += 1;
    else {
      out.push(word);
      i += 1;
    }
  }
  return out.join(' ').trim();
}

/** 是否为 shell 边界用的 echo（--xxx / $_exit= / $? / PIPESTATUS 之类）。 */
function isShellBoundaryEcho(segment) {
  const words = splitShellWords(segment);
  if (shellBasename(words[0] ?? '') !== 'echo') return false;
  return /-{2,}|_exit=|(?:^|\s|=)\$[?{]|PIPESTATUS/.test(words.slice(1).join(' '));
}

export function summarizeShellCommand(command) {
  const original = String(command).split(/\s+/).filter(Boolean).join(' ');
  if (!original) return '';
  const segments = splitShellCompound(original);
  if (segments.length <= 1) return cleanShellSegment(segments[0] ?? original) || original;
  const core = [];
  for (const segment of segments) {
    const cleaned = cleanShellSegment(segment);
    if (cleaned && !SHELL_SILENT_HEADS.has(shellHeadWord(cleaned)) && !isShellBoundaryEcho(cleaned)) {
      core.push(cleaned);
    }
  }
  if (!core.length) return original;
  const count = core.length - 1;
  if (!count) return core[0];
  return count === 1 ? `${core[0]} + 1 条命令` : `${core[0]} + ${count} 条命令`;
}

const DETAIL_KEYS = ['command', 'cmd', 'path', 'file_path', 'filePath', 'pattern', 'query', 'url', 'prompt', 'text', 'name'];
function detailOf(input) {
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return input;
  if (typeof input !== 'object') return String(input);
  for (const key of DETAIL_KEYS) {
    const v = input[key];
    if (typeof v === 'string' && v.trim()) return v;
    if (Array.isArray(v) && v.length) return v.join(' ');
  }
  const entries = Object.entries(input).filter(([, v]) => v !== undefined && v !== null);
  if (!entries.length) return '';
  return entries
    .slice(0, 2)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v) ?? ''}`)
    .join(' ');
}

function oneLine(text, limit = MAX_DETAIL) {
  const flat = String(text).replace(/\s+/g, ' ').replace(/`/g, "'").trim();
  if (!limit || limit <= 0 || flat.length <= limit) return flat;
  return `${flat.slice(0, limit - 3)}...`;
}

/** 从工具返回里挑出「说人话」的那部分错误信息。 */
function reasonOf(result) {
  if (!result) return '';
  const text = String(result);
  // dsh 的错误一般是 "[error: XXX] ..." 或 "Error: XXX"，优先取这一句
  const bracket = text.match(/\[error:\s*([^\]]+)\]/i);
  if (bracket) return bracket[1];
  const errLine = text.match(/^(?:Error|错误)[:：]\s*(.+)$/im);
  if (errLine) return errLine[1];
  // 拿不到结构化错误就用首行，别整段倒出来
  return text.split('\n').find((line) => line.trim()) ?? '';
}

/**
 * 一条可编辑的进度气泡。
 */
export class ProgressBubble {
  constructor({
    client,
    chatId,
    replyTo,
    enabled = true,
    log = () => {},
    thinkingEnabled = false,
    filterUserEcho = true,
    previewChars = MAX_DETAIL,
  }) {
    this.client = client;
    this.chatId = chatId;
    this.replyTo = replyTo;
    this.enabled = enabled;
    this.log = log;
    this.thinkingEnabled = thinkingEnabled;
    this.filterUserEcho = filterUserEcho;
    this.previewChars = previewChars;

    this.messageId = null;
    this.lines = [];      // 待发送的行（发送成功才出队）
    this.chunk = '';      // 当前这条消息已累积的正文
    this.lastText = '';   // 当前这条消息最后一次写上去的正文
    this.timer = null;
    this.lastPaint = 0;
    this.closed = false;
    this.canEdit = true;
    this.failures = 0;
    this.takeCount = 0;
    this.splitAt = 0;
    this.finishing = null;
    this.flushing = null;          // flush 的 in-flight promise（互斥用）
    this.silentCalls = new Set();  // 被吞掉的空参数调用（按 callId），它们的失败结果也不显示
    this.lastLine = null;          // 上一行原文（去重基准）
    this.repeat = 0;               // 连续重复次数（不含第一行）
    this.dirty = false;            // chunk 被原地改写过，即使队列为空也要补发一次
  }

  /** 追加一行进度；首次会自动创建气泡。
   *
   *  连续两行完全一样（模型卡在循环里反复跑同一条命令）时不再堆叠，
   *  而是把最后一行原地改写成 `… (×N)`，如实表达「这个动作做了 N 次」。
   *  这是照搬 Hermes 核心 _progress_emit 的 dedup 口径。 */
  push(line) {
    if (!this.enabled || this.closed) return;
    const tail = this.lines.length - 1;
    // 基准认「当前队尾」优先，其次才是上一条发出去的行 —— 发送成功后队尾会被移除，
    // 只看 lastLine 会让重复写在已经被清空的队列里。
    const base = tail >= 0 ? stripRepeat(this.lines[tail]) : this.lastLine;
    if (base !== null && line === base) {
      this.repeat += 1;
      const merged = `${line} (×${this.repeat + 1})`;
      if (tail >= 0) {
        this.lines[tail] = merged;
      } else if (this.rewriteChunkTail(merged)) {
        // 上一行已经进了气泡正文（或已发出）→ 原地改写它，不再追加一行。
        // 这是 Hermes 核心的口径：一条 (×N) 顶替前面所有重复，而不是堆成一串。
        this.dirty = true;
      } else {
        this.lines.push(merged);
      }
      this.schedule();
      return;
    }
    this.lastLine = line;
    this.repeat = 0;
    this.lines.push(line);
    this.schedule();
  }

  /** 把 chunk 的最后一行替换成 next；chunk 为空返回 false（调用方回退到入队）。 */
  rewriteChunkTail(next) {
    if (!this.chunk) return false;
    const nl = this.chunk.lastIndexOf('\n');
    this.chunk = nl >= 0 ? this.chunk.slice(0, nl + 1) + next : next;
    return true;
  }

  /** 记录一次工具调用开始。
   *
   *  参数为空（模型发了 {}）直接不显示：这种调用必然会被 dsh 拒绝，
   *  对用户没有任何信息量，只是噪音。跳过它，同时记下「这一条已经吞了」，
   *  好让紧随其后的失败结果也别再补一行。 */
  toolStart(event) {
    const name = event.tool ?? 'tool';
    const input = event.input ?? {};
    // shell 类工具先按 Hermes 的口径摘要（丢 cd / 丢管道尾 / 多段合成 +N 条命令），
    // 再截断。直接截原始命令会让一堆同前缀的命令变成同一行，去重时冒出假 (×N)。
    const raw = typeof input === 'object' && input && typeof input.command === 'string'
      ? summarizeShellCommand(input.command)
      : detailOf(input);
    const detail = oneLine(raw, this.previewChars);
    if (!detail) {
      // 空参数：不显示；按 callId 记一笔，等它那条失败结果也一起吞掉
      if (event.callId) this.silentCalls.add(event.callId);
      return;
    }
    const head = `${emojiFor(name)} \`${name}\``;
    this.push(`${head} · ${detail}`);
  }

  /** 记录一次模型的思考（工具调用之间的 scratch text）。
   *  显示完整内容、不截断；压成单行以保持气泡「一行一个事件」的结构。 */
  thinking(text) {
    if (!this.enabled || this.closed || this.thinkingEnabled === false) return;
    const flat = String(text ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!flat) return;
    // 「用户说什么」这类复述，配置里可关掉
    if (this.filterUserEcho !== false && USER_ECHO_RE.test(flat)) return;
    this.push(`💬 ${flat}`);
  }

  /** 记录一次工具调用结束。
   *  失败时把原因也带上 —— 只换个 ❌ 图标，用户根本不知道错在哪，
   *  只能干瞪眼。 */
  toolEnd(event) {
    if (!this.enabled || this.closed) return;
    // 这次调用的开始行被吞了（空参数）：它的失败结果同样没有信息量。
    if (event.callId && this.silentCalls.delete(event.callId)) return;
    const status = event.status ?? 'completed';
    if (status === 'completed') return; // 成功不刷屏
    const failed = status === 'failed' || status === 'error';
    const icon = failed ? '❌' : '⏹';

    // 错误原因：取第一条有效信息，压成一行，别把整段堆栈塞进气泡
    const why = failed ? oneLine(reasonOf(event.result), this.previewChars) : '';

    // 给最近一行补个失败标记
    for (let i = this.lines.length - 1; i >= 0; i -= 1) {
      if (!this.lines[i].startsWith('❌') && !this.lines[i].startsWith('⏹')) {
        // 这行可能带着 (×N)：先摘下来，改写完再缀回末尾 ——
        // 否则会卡在中间变成「❌ ops_bash · ls (×3) · 错误原因」。
        const rep = (this.lines[i].match(REPEAT_RE) ?? [''])[0];
        const body = stripRepeat(this.lines[i]).replace(/^[^\s]+\s/, '');
        this.lines[i] = why ? `${icon} ${body} · ${why}${rep}` : `${icon} ${body}${rep}`;
        break;
      }
    }
    this.schedule();
  }

  schedule() {
    if (!this.enabled || this.closed) return;
    if (this.timer) return;
    const wait = Math.max(0, THROTTLE_MS - (Date.now() - this.lastPaint));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, wait);
  }

  text() {
    return this.lines.join('\n');
  }

  /** 把剩余的行塞进当前这条消息，塞不下就停 —— 不覆盖已显示的内容。 */
  appendToChunk() {
    let size = this.chunk ? this.chunk.length : 0;
    let consumed = 0;
    this.splitAt = 0;
    for (const line of this.lines) {
      // 单行本身就超限：切一段出来，剩下的留在队首
      if (!this.chunk && line.length > TEXT_LIMIT) {
        this.chunk = `${line.slice(0, TEXT_LIMIT - 1)}…`;
        this.splitAt = TEXT_LIMIT - 1;
        return;
      }
      const add = (this.chunk ? 1 : 0) + line.length;
      if (this.chunk && size + add > TEXT_LIMIT) break;
      this.chunk = this.chunk ? `${this.chunk}\n${line}` : line;
      size += add;
      consumed += 1;
    }
    this.takeCount = consumed;
  }

  async flush() {
    // 互斥：定时器回调是 `void this.flush()`，await updateMessage 期间
    // 又来新事件 → 再排一次 flush；doFinish 也会并发调一次。两个 flush
    // 同时跑 appendToChunk，会把同一批行重复拼进 chunk（气泡里内容重复），
    // 并各自 splice 一次 takeCount（多删掉没展示过的行）。
    if (this.flushing) return this.flushing;
    if (!this.enabled || this.closed) return;
    if (!this.lines.length && !this.dirty) return;
    this.flushing = this.doFlush();
    try {
      await this.flushing;
    } finally {
      this.flushing = null;
    }
  }

  async doFlush() {
    if (!this.enabled || this.closed) return;
    if (!this.lines.length && !this.dirty) return;

    this.appendToChunk();

    // 当前消息已经装不下任何新行（哪怕它还没到硬上限）→ 定稿另起一条。
    // 不这么做的话剩下这几行会永远卡在队列里发不出去。
    if (this.lines.length && this.takeCount === 0 && this.splitAt === 0) {
      this.messageId = null;
      this.lastText = '';
      this.chunk = '';
      this.dirty = false;
      this.appendToChunk();
    }

    const body = this.chunk;
    if (!body.trim()) return;
    if (body === this.lastText && this.messageId) return;

    this.lastPaint = Date.now();
    try {
      if (!this.messageId || !this.canEdit) {
        const data = this.replyTo
          ? await this.client.replyMessage({
              messageId: this.replyTo,
              msgType: 'text',
              content: JSON.stringify({ text: body }),
            })
          : await this.client.sendMessage({
              receiveId: this.chatId,
              receiveIdType: 'chat_id',
              msgType: 'text',
              content: JSON.stringify({ text: body }),
            });
        this.messageId = data?.message_id ?? null;
        this.replyTo = null; // 后续用 send 续开，不再重复 reply
      } else {
        await this.client.updateMessage({
          messageId: this.messageId,
          msgType: 'text',
          content: JSON.stringify({ text: body }),
        });
      }
      this.lastText = body;
      this.dirty = false;
      // 发送成功才出队：内容一条都不丢。
      if (this.splitAt > 0) this.lines[0] = this.lines[0].slice(this.splitAt);
      else this.lines.splice(0, this.takeCount);
      this.takeCount = 0;
      this.failures = 0;
    } catch (error) {
      this.failures = (this.failures ?? 0) + 1;
      this.log(`[progress-send-failed ${this.failures}] ${error.message}`);
      // 这条消息已不可用（被撤回/超限/过期）→ 下条另开，保留的内容重发。
      this.messageId = null;
      this.canEdit = true;
      this.lastText = '';
      this.chunk = '';
      if (this.failures >= 3) {
        this.log('[progress-send-failed] 连续失败 3 次，丢弃这批进度');
        if (this.splitAt > 0) this.lines[0] = this.lines[0].slice(this.splitAt);
        else this.lines.splice(0, this.takeCount || 1);
        this.takeCount = 0;
        this.failures = 0;
      }
      return;
    }

    // 还有没塞下的行 → 下一轮 flush 会另起一条继续。
    if (this.lines.length) this.schedule();
  }

  reset() {
    this.messageId = null;
    this.lines = [];
    this.lastText = '';
    this.chunk = '';
    this.canEdit = true;
    this.closed = false;
    this.failures = 0;
    this.takeCount = 0;
    this.splitAt = 0;
    this.finishing = null;
    this.flushing = null;
    this.silentCalls.clear();
    this.lastLine = null;
    this.repeat = 0;
    this.dirty = false;
  }

  /** 收尾：把剩余内容全部发完，再停止编辑。 */
  async finish() {
    // 幂等：一轮里可能两个调用方同时收尾（起这一轮的消息 / 中途插入的消息）。
    // 不挡住的话同一批行会被发两遍。
    if (this.closed) return;
    if (this.finishing) return this.finishing;
    this.finishing = this.doFinish();
    try {
      await this.finishing;
    } finally {
      this.finishing = null;
    }
  }

  async doFinish() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (let guard = 0; guard < 50 && (this.lines.length || this.dirty); guard += 1) {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      // 进度要看「剩余字符数」而不是行数 —— 超长单行是原地切分的，行数不变。
      const before = this.lines.join('\n').length;
      const beforeId = this.messageId;
      await this.flush();
      if (this.lines.join('\n').length >= before && this.messageId === beforeId && !this.dirty) {
        break; // 真的没有进展了，别死循环
      }
    }
    // 走到这里队列里还有剩：说明重试 50 轮都发不出去（通常是消息被撤回/超限）。
    // 不能再闷头丢掉，至少留一条日志，否则用户看到气泡停在半截也没人知道为什么。
    if (this.lines.length) {
      this.log(`[progress-dropped] 收尾时仍有 ${this.lines.length} 行未能发出（消息可能已被撤回或超长）`);
    }
    this.closed = true;
  }
}