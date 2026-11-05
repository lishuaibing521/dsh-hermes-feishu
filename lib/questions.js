// dsh-hermes-feishu — 飞书「用户提问」桥接。
//
// dsh 的 ask_user_question 工具走的是另一个 waterfall 事件：`user-questions/request`。
// 应答者要么返回结构化答案认领请求，要么 next() 交给下一个。
// 返回结构：{ answers: [{ id, selected: string[], custom?: string }] }
//
// 没有应答者时会抛 NO_PROVIDER，工具调用直接失败；更糟的是——如果用户界面上
// 没人接，agent 会一直挂着等。飞书这边以前只桥接了 approval，没桥接提问，
// 所以 agent 一问就把整轮卡死，后面插的消息也只能排队。
//
// 这个模块补上应答者：收到请求就发一张带按钮的飞书卡片，用户点完把答案回传。
//
// 只依赖 node: 内置，不 import @deepseek-ai/*。
import { randomUUID } from 'node:crypto';

/** 没人回答的话多久放行（交给 agent 自己继续，避免整轮卡死）。 */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function plain(text) {
  return String(text ?? '').replace(/<[^>]*>/g, '').trim();
}

/**
 * 把一批问题渲染成一张飞书卡片。
 * 单选：点一下就是答案。
 * 多选：点按钮切换选中态（再点一次取消），点「确认」才算答完 ——
 *       直接点一下就结算的话，用户根本没法选第二个。
 */
function buildCard({ id, questions, picked = new Map() }) {
  const elements = [];

  for (const [index, q] of questions.entries()) {
    const lines = [];
    if (q.header) lines.push(`**${plain(q.header)}**`);
    lines.push(plain(q.question));
    if (q.detail) lines.push('', plain(q.detail));
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: lines.join('\n') },
    });

    const options = Array.isArray(q.options) ? q.options : [];
    if (options.length) {
      const multi = q.multiSelect === true;
      const chosen = picked.get(q.id)?.selected ?? [];
      const actions = options.map((opt, oi) => {
        const label = plain(opt.label);
        const isOn = multi && chosen.includes(label);
        return {
          tag: 'button',
          text: { tag: 'plain_text', content: isOn ? `✓ ${label}` : label },
          // 多选：已选的高亮；单选：沿用第一个选项为强调色
          type: isOn || (!multi && oi === 0) ? 'primary' : 'default',
          value: { ask_id: id, question_id: q.id, option_index: oi },
        };
      });
      if (multi) {
        actions.push({
          tag: 'button',
          text: { tag: 'plain_text', content: '✅ 确认' },
          type: 'primary',
          value: { ask_id: id, question_id: q.id, confirm: true },
        });
      }
      elements.push({ tag: 'action', actions });
      // 按钮放不下第二个问题的选项时，飞书会挤；这里加分隔
      if (index < questions.length - 1) elements.push({ tag: 'hr' });
    }
  }

  if (elements.length === 0) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: '模型提了一个问题，但没有给出选项。直接回复文字即可。' },
    });
  }

  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: '❓ 需要你回答' },
    },
    elements: [
      ...elements,
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: '点按钮选择；也可以直接发文字作为自定义回答。10 分钟不答则按默认继续。',
          },
        ],
      },
    ],
  };
}

/** 回答之后的卡片（把按钮换成结论，避免重复点）。 */
function buildAnsweredCard({ picked, questions }) {
  const lines = questions.map((q) => {
    const answer = picked.get(q.id);
    const text = answer?.custom || (answer?.selected ?? []).join('、') || '(未回答)';
    return `**${plain(q.question)}**\n${text}`;
  });
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: 'green',
      title: { tag: 'plain_text', content: '✅ 已回答' },
    },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: lines.join('\n\n') } }],
  };
}

/**
 * @param {object} options
 * @param {object} options.client - FeishuClient
 * @param {(agentId: string) => string|undefined} options.resolveChat - agent id -> chat
 * @param {(msg: string) => void} [options.log]
 * @param {number} [options.timeoutMs]
 */
export function createFeishuQuestions({
  client,
  resolveChat,
  resolveOwner = null,
  checkActor = null,
  log = () => {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  /** id -> { resolve, chatId, messageId, questions, timer, answers, ownerId } */
  const pending = new Map();
  let installed = false;

  /** 结算一条提问；返回 true 表示确实结算了。 */
  function settle(id, answers) {
    const item = pending.get(id);
    if (!item) return false;
    pending.delete(id);
    if (item.timer) clearTimeout(item.timer);
    item.resolve(answers);
    return true;
  }

  /** 结算一条提问：清定时器 + resolve + 删表，幂等。 */
  function settle(id, answers) {
    const item = pending.get(id);
    if (!item) return false;
    pending.delete(id);
    if (item.timer) clearTimeout(item.timer);
    item.resolve(answers);
    return true;
  }

  /** 用默认值填满没答的问题（单选取第一个选项，多选全选）。 */
  function defaultAnswers(questions, partial = new Map()) {
    return {
      answers: questions.map((q) => {
        const got = partial.get(q.id);
        if (got) {
          const out = { id: q.id, selected: got.selected ?? [] };
          if (got.custom) out.custom = got.custom;
          return out;
        }
        const options = Array.isArray(q.options) ? q.options : [];
        if (!options.length) return { id: q.id, selected: [], custom: '(用户未回答)' };
        if (q.multiSelect) return { id: q.id, selected: options.map((o) => o.label) };
        return { id: q.id, selected: [options[0].label] };
      }),
    };
  }

  /** 请求回答。作为 `user-questions/request` waterfall 的应答者。 */
  async function ask(req) {
    const agentId = req?.agent?.id ?? req?.agent?.session?.header?.id;
    const chatId = resolveChat?.(agentId);
    if (!chatId) {
      // 不是飞书这条链路起的 agent，交给下一个应答者
      log(`[ask] 无对应 chat，交给下一个应答者 agent=${agentId ?? '(空)'}`);
      return null;
    }

    const questions = Array.isArray(req?.questions) ? req.questions : [];
    if (!questions.length) return null;

    const id = randomUUID();
    const answers = new Map();
    // 记下发起人：只有他本人能点这张提问卡作答。
    const owner = typeof resolveOwner === 'function' ? resolveOwner(agentId) : undefined;
    const ownerId = owner?.openId || '';

    const result = new Promise((resolve) => {
      const timer = setTimeout(() => {
        log(`[ask] 超时未回答，按默认值继续 id=${id.slice(0, 8)}`);
        settle(id, defaultAnswers(questions, answers));
      }, timeoutMs);
      pending.set(id, { resolve, chatId, messageId: null, questions, timer, answers, ownerId });
    });

    // 任务被中止 -> 撤回提问
    if (req.signal && typeof req.signal.addEventListener === 'function') {
      try {
        req.signal.addEventListener(
          'abort',
          () => {
            // 必须真的结算（resolve），不能只删表：waterfall 那边还 await 着
            // 这个 promise，光删表它要空等到 10 分钟超时才返回。
            if (settle(id, defaultAnswers(questions, answers))) {
              log(`[ask] 任务中止，提问作废 id=${id.slice(0, 8)}`);
            }
          },
          { once: true },
        );
      } catch {
        /* 拿不到信号就只靠超时兜底 */
      }
    }

    try {
      const data = await client.sendMessage({
        receiveId: chatId,
        receiveIdType: 'chat_id',
        msgType: 'interactive',
        content: JSON.stringify(buildCard({ id, questions })),
      });
      const item = pending.get(id);
      if (item) {
        item.messageId = data?.message_id ?? null;
      } else {
        // 卡片发出去之前就已经超时/中止了：把刚发的卡片改成就绪态，别留个死按钮
        const mid = data?.message_id;
        if (mid) log(`[ask] 请求已失效，卡片 id=${id.slice(0, 8)} 仍然保留`);
      }
      log(`[ask] 已发提问卡片 id=${id.slice(0, 8)} 问题数=${questions.length}`);
    } catch (error) {
      log(`[ask] 卡片发送失败：${error.message}`);
      // 发不出去就交给下一个应答者，别把整轮卡死。
      // 注意顺序：先取出 item（拿到定时器句柄）再删表 ——
      // 反过来 delete 之后 pending.get(id) 永远是 undefined，
      // 定时器清不掉，会留一个 10 分钟后对死 promise 调 resolve 的幽灵。
      const item = pending.get(id);
      pending.delete(id);
      if (item?.timer) clearTimeout(item.timer);
      return null;
    }

    return result;
  }

  /**
   * 处理卡片按钮点击。
   *
   * 🔴 与 approval.js 同理：卡片回调绕过了消息侧的准入，必须在这里补两道门
   *    （白名单 + 只有发起人本人能作答）。
   *
   * @param {object} event 飞书卡片回调事件
   * @param {object} actor 点击者身份 {openId,userId,unionId}
   * @returns {boolean|'expired'|'denied'} true=已消费；'expired'=已失效；
   *          'denied'=无权限，不改变提问状态
   */
  function handleCardAction(event, actor = null) {
    const value = event?.action?.value;
    const id = value?.ask_id;
    if (!id) return false;

    // ── 门 1：发送方准入（与消息侧同一份白名单）──────────────
    if (typeof checkActor === 'function') {
      const verdict = checkActor(actor ?? {});
      if (!verdict?.ok) {
        log(
          `[deny] 提问卡点击被拒 reason=${verdict?.reason ?? 'unknown'}` +
            ` open_id=${actor?.openId || '(无)'} ask_id=${String(id).slice(0, 8)}`,
        );
        return 'denied';
      }
    }

    const item = pending.get(id);
    if (!item) {
      log(`[ask] 收到过期提问点击 id=${String(id).slice(0, 8)}`);
      return 'expired';
    }

    // ── 门 2：只有发起人能作答 ───────────────────────────────
    if (item.ownerId && actor?.openId && actor.openId !== item.ownerId) {
      log(
        `[deny] 提问卡只允许发起人作答 ask_id=${String(id).slice(0, 8)}` +
          ` owner=${item.ownerId} clicker=${actor.openId}`,
      );
      return 'denied';
    }

    const questionId = value?.question_id;
    const question = item.questions.find((q) => q.id === questionId);
    if (!question) return true;

    const options = Array.isArray(question.options) ? question.options : [];
    const multi = question.multiSelect === true;

    // 多选的「确认」：把这个问题的选中集合定格，然后走统一结算流程。
    if (multi && value?.confirm) {
      // 一个都没选就点确认：按「都不选」结算，别让用户卡在这儿没反应。
      if (!item.answers.has(questionId)) {
        item.answers.set(questionId, { selected: [] });
        log(`[ask] 多选未选直接确认，按空选择处理 id=${String(id).slice(0, 8)}`);
      }
    } else {
      const option = options[Number(value?.option_index)];
      if (!option) return true;

      if (multi) {
        // 多选：点一下切换，再点一次取消；不结算，等「确认」。
        const got = item.answers.get(questionId) ?? { selected: [] };
        const label = plain(option.label);
        const set = new Set(got.selected ?? []);
        if (set.has(label)) {
          set.delete(label);
          if (set.size === 0) item.answers.delete(questionId);
          else item.answers.set(questionId, { selected: [...set] });
        } else {
          set.add(label);
          item.answers.set(questionId, { selected: [...set] });
        }
        // 重绘卡片：把已选项打勾，让用户看得见自己选了什么
        if (item.messageId) {
          void client
            .updateMessage({
              messageId: item.messageId,
              msgType: 'interactive',
              content: JSON.stringify(
                buildCard({ id, questions: item.questions, picked: item.answers }),
              ),
            })
            .catch((error) => log(`[ask] 卡片刷新失败：${error.message}`));
        }
        return true;
      }
      item.answers.set(questionId, { selected: [plain(option.label)] });
    }

    // 只有「所有问题都答了」才结算，否则等剩下几个。
    // 多选必须显式点确认（上面 switch 分支直接 return），走到这里的多选都是确认过的。
    const allAnswered = item.questions.every((q) => item.answers.has(q.id));
    if (!allAnswered) {
      log(`[ask] 已答 ${item.answers.size}/${item.questions.length}，继续等待 id=${id.slice(0, 8)}`);
      return true;
    }

    const finalAnswers = defaultAnswers(item.questions, item.answers);
    settle(id, finalAnswers);
    log(`[ask] 用户已回答 id=${id.slice(0, 8)}`);

    if (item.messageId) {
      void (async () => {
        try {
          await client.updateMessage({
            messageId: item.messageId,
            msgType: 'interactive',
            content: JSON.stringify(buildAnsweredCard({ picked: item.answers, questions: item.questions })),
          });
        } catch (error) {
          log(`[ask] 卡片更新失败：${error.message}`);
        }
      })();
    }
    return true;
  }

  /**
   * 用户直接回文字时，当成当前提问的自定义答案。
   * @returns {boolean} true 表示这条消息被当作答案消费掉了
   */
  function handleFreeText(chatId, text, actor = null) {
    const trimmed = String(text ?? '').trim();
    if (!trimmed) return false;
    // 找到这个 chat 最早一条还没答完的提问
    for (const [id, item] of pending) {
      if (item.chatId !== chatId) continue;

      // 🔴 只认发起人：卡片只给本人点，文字补答也必须同一个口径，
      //    否则群里另一个白名单用户打一行字就能替发起人把问题答了。
      if (item.ownerId && actor?.openId && actor.openId !== item.ownerId) {
        log(
          `[deny] 提问文字答案被拒（只允许发起人作答）ask=${id.slice(0, 8)}`
            + ` owner=${item.ownerId} sender=${actor.openId}`,
        );
        continue;
      }

      // 只填「第一个还没答的问题」。
      // 原来是把这句话同时塞给所有未答问题，agent 会以为用户对每个问题
      // 都给了同样的自定义回答。多个问题时，用户后续再发文字补答下一个。
      const target = item.questions.find((q) => !item.answers.has(q.id));
      if (!target) continue;
      item.answers.set(target.id, { selected: [], custom: trimmed });
      log(`[ask] 用文字回答 id=${id.slice(0, 8)} 问题=${target.id}：${trimmed.slice(0, 60)}`);
      // 还有别的问题没答：先刷新卡片表示已记下，等剩下的
      const allAnswered = item.questions.every((q) => item.answers.has(q.id));
      if (!allAnswered) {
        if (item.messageId) {
          void client
            .updateMessage({
              messageId: item.messageId,
              msgType: 'interactive',
              content: JSON.stringify(buildCard({ id, questions: item.questions, picked: item.answers })),
            })
            .catch((error) => log(`[ask] 卡片刷新失败：${error.message}`));
        }
        return true;
      }
      const finalAnswers = defaultAnswers(item.questions, item.answers);
      settle(id, finalAnswers);
      if (item.messageId) {
        void (async () => {
          try {
            await client.updateMessage({
              messageId: item.messageId,
              msgType: 'interactive',
              content: JSON.stringify(buildAnsweredCard({ picked: item.answers, questions: item.questions })),
            });
          } catch (error) {
            log(`[ask] 卡片更新失败：${error.message}`);
          }
        })();
      }
      return true;
    }
    return false;
  }

  /** 挂到 cordis 上，成为 user-questions/request 的应答者。 */
  function install(ctx) {
    if (installed) return;
    installed = true;
    ctx.effect(() => {
      const off = ctx.on('user-questions/request', async (req, next) => {
        try {
          const result = await ask(req);
          if (result === null) return next();
          return result;
        } catch (error) {
          log(`[ask] 应答出错，交回下一个应答者：${error.message}`);
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
    log('[ask] 飞书用户提问应答者已注册');
  }

  return { install, handleCardAction, handleFreeText, pending, _buildCard: buildCard };
}
