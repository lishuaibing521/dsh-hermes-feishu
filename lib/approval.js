// dsh-hermes-feishu — 飞书审批桥接。
//
// dsh 的审批是一个 waterfall 事件：`approval/request`。
// 应答者要么给一个结果认领请求，要么 `next()` 交给下一个。
// 结果词汇：allowed-once（一次性放行）/ rejected（拒绝）/ cancelled（撤回）/ unavailable（没人应答，按拒绝关闭）。
//
// 没有应答者时，dsh 会 fail-closed 成 unavailable —— 也就是「问都不问，直接不给过」。
// 我们之前就是这个状态：飞书里跑任务碰到要审批的操作，只会莫名失败。
//
// 这个模块补上应答者：收到请求就发一张带按钮的飞书卡片，等用户点。
// 点完把结果回传给 dsh。
//
// 只依赖 node: 内置，不 import @deepseek-ai/*。
import { randomUUID } from 'node:crypto';

/** 没人点的话多久按拒绝处理。 */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** 结果常量，和 dsh 的 ApprovalOutcome 对齐。 */
const ALLOW = 'allowed-once';
const DENY = 'rejected';
const CANCEL = 'cancelled';
const UNAVAILABLE = 'unavailable';

/**
 * 生成审批卡片。
 * 用飞书卡片 1.0 的 interactive 结构 —— 兼容性最好，按钮回调稳定。
 */
function buildCard({ id, toolName, reason, displayReason }) {
  const why = displayReason?.zh ?? displayReason?.en ?? reason ?? '';
  const lines = [`**工具**：\`${toolName}\``];
  if (why) lines.push(`**原因**：${why}`);
  lines.push('');
  lines.push('点下面的按钮决定这次操作是否放行。批准只对这一次生效。');

  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: '🔐 需要你审批' },
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: lines.join('\n') },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✅ 允许' },
            type: 'primary',
            value: { approval_id: id, decision: 'allow' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '❌ 拒绝' },
            type: 'danger',
            value: { approval_id: id, decision: 'deny' },
          },
        ],
      },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: '5 分钟内不点视为拒绝；任务被中止时这条审批自动作废。',
          },
        ],
      },
    ],
  };
}

/** 决策后的卡片（把按钮换成结论）。 */
function buildDecidedCard({ toolName, outcome }) {
  const map = {
    [ALLOW]: { emoji: '✅', text: '已允许（仅这一次）', template: 'green' },
    [DENY]: { emoji: '⛔', text: '已拒绝', template: 'red' },
    [CANCEL]: { emoji: '⌛', text: '已作废', template: 'grey' },
    [UNAVAILABLE]: { emoji: '⚠️', text: '无人处理，已按拒绝关闭', template: 'grey' },
  };
  const picked = map[outcome] ?? map[CANCEL];
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: picked.template,
      title: { tag: 'plain_text', content: `${picked.emoji} ${picked.text}` },
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: `**工具**：\`${toolName}\`\n**结果**：${picked.text}` },
      },
    ],
  };
}

/**
 * @param {object} options
 * @param {object} options.client 飞书客户端
 * @param {(agentId: string) => string|undefined} options.resolveChat 从 agent 反查 chatId
 * @param {(msg: string) => void} [options.log]
 * @param {number} [options.timeoutMs]
 */
export function createFeishuApproval({ client, resolveChat, log = () => {}, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  /** id -> { resolve, chatId, messageId, toolName, timer } */
  const pending = new Map();
  /** 已经被别的应答者认领过的 agent，避免跨通道重复弹。 */
  let installed = false;

  /** 结算一个请求；返回 true 表示确实结算了。 */
  function settle(id, outcome) {
    const item = pending.get(id);
    if (!item) return false;
    pending.delete(id);
    if (item.timer) clearTimeout(item.timer);
    item.resolve(outcome);
    return true;
  }

  /** 请求决策。作为 `approval/request` waterfall 的应答者。 */
  async function ask(req) {
    const agentId = req?.agent?.id ?? req?.agent?.session?.header?.id;
    const chatId = resolveChat?.(agentId);
    if (!chatId) {
      // 不认识这个 agent（不是飞书这条链路起的），交给下一个应答者
      log(`[approval] 无对应 chat，交给下一个应答者 agent=${agentId ?? '(空)'}`);
      return UNAVAILABLE;
    }

    const id = randomUUID();
    const toolName = req.toolName ?? '(未知工具)';

    const outcome = new Promise((resolve) => {
      const timer = setTimeout(() => {
        log(`[approval] 超时自动拒绝 id=${id.slice(0, 8)} tool=${toolName}`);
        settle(id, DENY);
      }, timeoutMs);
      pending.set(id, { resolve, chatId, messageId: null, toolName, timer });
    });

    // 任务被中止 -> 撤回审批，别让用户对着作废的卡片点
    if (req.signal && typeof req.signal.addEventListener === 'function') {
      try {
        req.signal.addEventListener(
          'abort',
          () => {
            if (settle(id, CANCEL)) log(`[approval] 任务中止，审批作废 id=${id.slice(0, 8)}`);
          },
          { once: true },
        );
      } catch {
        /* 拿不到信号就只靠超时兜底 */
      }
    }

    try {
      const card = buildCard({
        id,
        toolName,
        reason: req.reason,
        displayReason: req.displayReason,
      });
      const data = await client.sendMessage({
        receiveId: chatId,
        receiveIdType: 'chat_id',
        msgType: 'interactive',
        content: JSON.stringify(card),
      });
      const item = pending.get(id);
      if (item) item.messageId = data?.message_id ?? null;
      log(`[approval] 已发审批卡片 id=${id.slice(0, 8)} tool=${toolName}`);
    } catch (error) {
      log(`[approval] 卡片发送失败：${error.message}`);
      settle(id, UNAVAILABLE);
      return UNAVAILABLE;
    }

    return outcome;
  }

  /**
   * 处理卡片按钮点击。
   * @returns {boolean} true 表示这次点击属于审批卡片（已消费）
   */
  function handleCardAction(event) {
    const value = event?.action?.value;
    const id = value?.approval_id;
    if (!id) return false;

    const item = pending.get(id);
    if (!item) {
      log(`[approval] 收到过期审批点击 id=${String(id).slice(0, 8)}`);
      return true;
    }

    const decision = value?.decision === 'allow' ? ALLOW : DENY;
    const toolName = item.toolName;
    const messageId = item.messageId;
    const chatId = item.chatId;

    settle(id, decision);
    log(`[approval] 用户选择 ${decision === ALLOW ? '允许' : '拒绝'} tool=${toolName}`);

    // 把卡片改成结论态，避免用户重复点
    if (messageId) {
      void (async () => {
        try {
          await client.updateMessage({
            messageId,
            msgType: 'interactive',
            content: JSON.stringify(buildDecidedCard({ toolName, outcome: decision })),
          });
        } catch (error) {
          log(`[approval] 卡片更新失败：${error.message}`);
        }
      })();
    }
    void chatId;
    return true;
  }

  /** 挂到 cordis 上，成为 approval/request 的应答者。 */
  function install(ctx) {
    if (installed) return;
    installed = true;
    ctx.effect(() => {
      const off = ctx.on('approval/request', async (req, next) => {
        try {
          const result = await ask(req);
          if (result === UNAVAILABLE) return next();
          return result;
        } catch (error) {
          log(`[approval] 应答出错，按拒绝关闭：${error.message}`);
          return next();
        }
      });
      return () => {
        try {
          off?.();
        } catch {
          /* ignore */
        }
        installed = false;
      };
    });
    log('[approval] 飞书审批应答者已注册');
  }

  return { install, handleCardAction, pending, _buildCard: buildCard };
}