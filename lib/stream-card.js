// dsh-hermes-feishu — 流式运行卡片。
//
// 收到消息先立刻发一张卡片（用户马上有反馈），随后把 dsh agent 的
// tool_call / tool_result / text 事件实时渲染进这张卡片并原地更新。
//
// 关键约束：
//   - 飞书更新卡片必须用 PATCH（文本才是 PUT）；
//   - 更新要节流，官方对卡片更新有频率限制（这里 300ms 合并一次）；
//   - 卡片 JSON 不能无限增长，工具条目要截断（最多保留 30 条）。
import { mdHeadingsToBold, parseNextTable, buildNativeTable } from './render.js';

const THROTTLE_MS = 300;
const MAX_TOOLS = 30;
const MAX_DETAIL = 70;
const MAX_TEXT = 12000;

/** 把一段 markdown 拆成「markdown 元素 + 原生 table 组件」。 */
function markdownElements(content) {
  const elements = [];
  const lines = mdHeadingsToBold(content ?? '').split('\n');
  let i = 0;
  let buffer = [];

  const flush = () => {
    const text = buffer.join('\n');
    if (text.trim()) elements.push({ tag: 'markdown', content: text });
    buffer = [];
  };

  while (i < lines.length) {
    const hit = parseNextTable(lines, i);
    if (hit) {
      flush();
      elements.push(buildNativeTable(hit.rows));
      i = hit.next;
      continue;
    }
    buffer.push(lines[i]);
    i += 1;
  }
  flush();
  return elements;
}

/** 从工具入参里挑一段最能说明「在干嘛」的摘要。 */
const DETAIL_KEYS = ['command', 'cmd', 'path', 'file_path', 'filePath', 'pattern', 'query', 'url', 'prompt', 'text', 'name'];
function toolDetail(input) {
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return input;
  if (typeof input !== 'object') return String(input);
  for (const key of DETAIL_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  const entries = Object.entries(input).filter(([, v]) => v !== undefined);
  if (!entries.length) return '';
  return entries
    .slice(0, 2)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v) ?? ''}`)
    .join(' ');
}

function oneLine(text) {
  const flat = String(text).replace(/\s+/g, ' ').replace(/`/g, "'").trim();
  return flat.length <= MAX_DETAIL ? flat : `${flat.slice(0, MAX_DETAIL - 1)}…`;
}

const STATUS_ICON = {
  running: '🔄',
  completed: '✅',
  failed: '❌',
  error: '❌',
  cancelled: '⏹',
};

/**
 * 一张会自己更新的运行卡片。
 */
export class RunCard {
  constructor({ client, chatId, replyTo, botName = '', log = () => {} }) {
    this.client = client;
    this.chatId = chatId;
    this.replyTo = replyTo;
    this.botName = botName;
    this.log = log;

    this.messageId = null;
    this.tools = [];        // { callId, name, detail, status }
    this.byCallId = new Map();
    this.text = '';
    this.thinking = '';
    this.status = 'running'; // running | done | error
    this.reason = '';

    this.pending = null;
    this.timer = null;
    this.lastPaint = 0;
    this.closed = false;
  }

  /** 发初始卡片。失败则退化成纯文本，保证用户至少能收到回复。 */
  async start() {
    const card = this.render();
    try {
      const data = await this.client.replyMessage({
        messageId: this.replyTo,
        msgType: 'interactive',
        content: JSON.stringify(card),
      });
      this.messageId = data?.message_id ?? null;
    } catch (error) {
      this.log(`[card-start-failed] ${error.message}，降级为普通发送`);
      try {
        const data = await this.client.sendMessage({
          receiveId: this.chatId,
          receiveIdType: 'chat_id',
          msgType: 'interactive',
          content: JSON.stringify(card),
        });
        this.messageId = data?.message_id ?? null;
      } catch (inner) {
        this.log(`[card-start-failed-2] ${inner.message}`);
      }
    }
    this.lastPaint = Date.now();
    return this.messageId;
  }

  /** 吃一个 dsh --json 事件。 */
  onEvent(event) {
    if (!event || typeof event !== 'object') return;
    switch (event.type) {
      case 'thinking':
        if (typeof event.text === 'string') this.thinking = event.text;
        break;
      case 'tool_call': {
        const name = event.tool ?? 'tool';
        const detail = oneLine(toolDetail(event.input));
        const entry = { callId: event.callId ?? name, name, detail, status: 'running' };
        this.tools.push(entry);
        this.byCallId.set(entry.callId, entry);
        if (this.tools.length > MAX_TOOLS) this.tools.splice(0, this.tools.length - MAX_TOOLS);
        break;
      }
      case 'tool_result': {
        const entry = this.byCallId.get(event.callId);
        if (entry) entry.status = event.status ?? 'completed';
        break;
      }
      case 'text':
        if (typeof event.text === 'string') {
          this.text = (this.text + event.text).slice(-MAX_TEXT);
        }
        break;
      case 'final':
        if (typeof event.text === 'string' && event.text.trim()) this.text = event.text.slice(-MAX_TEXT);
        break;
      default:
        break;
    }
    this.schedule();
  }

  /** 节流更新：窗口内的多次事件合并成一次 PATCH。 */
  schedule() {
    if (this.closed) return;
    if (this.timer) return;
    const wait = Math.max(0, THROTTLE_MS - (Date.now() - this.lastPaint));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, wait);
  }

  async flush() {
    if (this.closed || !this.messageId) return;
    this.lastPaint = Date.now();
    try {
      await this.client.updateMessage({
        messageId: this.messageId,
        msgType: 'interactive',
        content: JSON.stringify(this.render()),
      });
    } catch (error) {
      // 卡片被撤回/过期就没法再更新了，静默放弃，最终结果另发
      this.log(`[card-update-failed] ${error.message}`);
    }
  }

  /** 结束：把状态收尾并做最后一次更新。 */
  async finish({ status = 'done', reason = '' } = {}) {
    this.closed = true;
    this.status = status;
    this.reason = reason;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.messageId) return null;

    const card = this.render();
    try {
      await this.client.updateMessage({
        messageId: this.messageId,
        msgType: 'interactive',
        content: JSON.stringify(card),
      });
    } catch (error) {
      this.log(`[card-finish-failed] ${error.message}`);
      // 最终结果不能丢：再发一条新卡片
      try {
        await this.client.sendMessage({
          receiveId: this.chatId,
          receiveIdType: 'chat_id',
          msgType: 'interactive',
          content: JSON.stringify(this.render()),
        });
      } catch (inner) {
        this.log(`[card-finish-fallback-failed] ${inner.message}`);
      }
    }
    return this.messageId;
  }

  /** 组装卡片 JSON 2.0。 */
  render() {
    const elements = [];
    const running = this.status === 'running';

    // 正文：优先用最终/流式文本；还没输出就先显示占位
    const bodyText = this.text.trim() || (running ? '_🤖 正在处理…_' : '_(无输出)_');
    elements.push(...markdownElements(bodyText));

    // 工具调用过程：折叠面板，展开看细节
    if (this.tools.length > 0) {
      const lines = this.tools.map((t) => {
        const icon = STATUS_ICON[t.status] ?? '•';
        const detail = t.detail ? ` · ${t.detail}` : '';
        return `${icon} \`${t.name}\`${detail}`;
      });
      elements.push({
        tag: 'collapsible_panel',
        expanded: running && this.tools.length <= 6,
        header: {
          title: { tag: 'markdown', content: `**🛠 工具调用（${this.tools.length}）**` },
          vertical_align: 'center',
          icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
          icon_position: 'right',
          icon_expanded_angle: -180,
        },
        border: { color: 'grey', corner_radius: '5px' },
        elements: [{ tag: 'markdown', content: lines.join('\n') }],
      });
    }

    // 状态行
    const footer = running
      ? '🧠 正在思考…'
      : this.status === 'error'
        ? `❌ 出错了${this.reason ? `：${this.reason}` : ''}`
        : '✅ 已完成';
    elements.push({ tag: 'markdown', content: `<font color='grey'>${footer}</font>`, text_size: 'notation' });

    const card = {
      schema: '2.0',
      config: {
        update_multi: true,
        streaming_mode: running,
        summary: { content: running ? '🤖 正在处理…' : (this.text.trim().slice(0, 80) || '已完成') },
      },
      body: { elements },
    };

    if (this.botName) {
      card.header = {
        title: { tag: 'plain_text', content: `🤖 ${this.botName}` },
        template: running ? 'blue' : this.status === 'error' ? 'red' : 'green',
      };
    }

    return card;
  }
}