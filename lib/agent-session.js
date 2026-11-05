// dsh-hermes-feishu — 进程内 agent 会话。
//
// 为什么不用 `dsh --profile headless` 子进程：
//   子进程是一次性任务，任务跑起来之后没有任何入口能往里塞新消息，
//   所以「执行中插入需求」做不到。
//
// dsh 自己的 agent 支持这件事：
//   agent.followup(msg) —— 排到下一轮
//   agent.steer(msg)    —— 插到当前轮的**下一个 step 边界**，正在跑的 agent
//                          会在下一次工具调用之间把这条消息读进去
//   https://.../dsh-agent 的 Agent 接口注释原文：
//   "Submit steering for the nearest step. An idle driver starts a turn;
//    a running driver consumes it at its next step boundary."
//
// 本模块把 ctx.agents 包一层，按飞书 chat 维护常驻 agent：
//   - 空闲时收到消息 -> followup（起新一轮）
//   - 运行中收到消息 -> steer（原地插入）
//
// 只依赖 node: 内置，不 import @deepseek-ai/*（会让 cordis 静默跳过整个 bundle）。
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** 会话映射落盘位置：{ [chatId]: sessionId }。dsh 重启后靠它续接会话。 */
function agentStorePath() {
  const home = process.env.DSH_HOME;
  const root = typeof home === 'string' && home.length > 0 ? home : join(homedir(), '.dsh');
  return join(root, 'feishu-plugin-agents.json');
}

async function loadAgentMap() {
  try {
    const parsed = JSON.parse(await readFile(agentStorePath(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// 和 dispatch.js 的会话映射同一套问题：读-改-写非原子，两个 chat 并发时
// 后写的覆盖先写的；两个 writeFile 撞同一路径还可能截断成坏 JSON
// （loadAgentMap 的 catch 会静默当空表）。这里串行化 + 写前重读 + 原子替换。
let _agentMapWriteChain = Promise.resolve();

function updateAgentMap(mutate) {
  _agentMapWriteChain = _agentMapWriteChain.catch(() => undefined).then(async () => {
    const target = agentStorePath();
    const current = await loadAgentMap();
    mutate(current);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    await writeFile(tmp, JSON.stringify(current, null, 2), 'utf8');
    await rename(tmp, target);
  });
  return _agentMapWriteChain;
}

/** 构造一条 dsh 认的 user message（等价于 dsh-llm 的 createUserMessage）。
 *
 *  content 可以是纯字符串，也可以是 dsh-llm ContentBlock 数组。
 *  dsh 的 ContentBlockMap 明确支持 text / image / file 三种用户可见块：
 *    { type: 'text', text }
 *    { type: 'image', attachment: ImageAttachmentRef }
 *    { type: 'file', attachment: FileAttachmentRef }
 *  附件 ref 必须由 ctx.attachments 签发（admitPromptContent），不能自己造。
 */
function makeUserMessage(content) {
  const blocks =
    typeof content === 'string'
      ? [{ type: 'text', text: content }]
      : Array.isArray(content) && content.length
        ? content
        : [{ type: 'text', text: '' }];
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze(blocks.map((block) => Object.freeze({ ...block }))),
    source: Object.freeze({ kind: 'user' }),
  });
}

/** 从 assistant/message 事件里把纯文本抠出来。 */
function textOfAssistantEvent(event) {
  const data = event?.data ?? event;
  const blocks = data?.message?.content ?? data?.content ?? [];
  if (!Array.isArray(blocks)) return '';
  let out = '';
  for (const b of blocks) {
    if (b && b.type === 'text' && typeof b.text === 'string') out += b.text;
  }
  return out;
}

/** 从 assistant/message 事件里把 reasoning 块抠出来。
 *  这是模型在工具调用之间的思考过程，dsh 一直在给，之前被解析层丢掉了。 */
function reasoningOfAssistantEvent(event) {
  const data = event?.data ?? event;
  const blocks = data?.message?.content ?? data?.content ?? [];
  if (!Array.isArray(blocks)) return '';
  let out = '';
  for (const b of blocks) {
    if (b && b.type === 'reasoning' && typeof b.text === 'string') out += b.text;
  }
  return out;
}

/** dsh 启动后这段时间内创建的会话，插件工具还没注册齐，要等。 */
const BOOT_GRACE_S = 60;

/** 一轮失败后最多用几个备用模型重开（防止死循环烧额度）。 */
const MAX_MODEL_RETRIES = 8;

export function createInProcessRunner({
  ctx,
  log = () => {},
  cwd,
  agentOptions = {},
  agentPreset,
  /**
   * 模型故障转移。可以传实例，也可以传 `() => 实例` 的取值函数 ——
   * 传函数更稳：插件重载后外层变量会换成新实例，传实例就只拿到已废弃的旧对象。
   */
  modelFallback = null,
  /**
   * 由 index.js 注入：resolveActor(chatId) 返回这条会话最近一次通过准入的发送方。
   * 只在**创建会话那一刻**取一次，作为该会话的卡片归属人 —— 之后别人再发言
   * 也不会改变归属，否则群聊里两个白名单用户交替说话会互相顶掉对方的审批权。
   */
  resolveActor = null,
}) {
  /** chatId -> { handle, sessionId, agent, createdAt, owner } */
  const slots = new Map();
  /** sessionId -> 一轮运行的状态 */
  const runs = new Map();

  const otherSessionOf = (sessionId) => {
    return sessionId ? sessionId : '';
  };

  /** 等 agent 回到 idle（失败收尾是异步的，不 waiting 直接 followup 会排错边界）。 */
  async function waitIdle(agent, timeoutMs = 10_000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      let status = '';
      try {
        status = agent?.status ?? '';
      } catch {
        status = '';
      }
      if (status !== 'running') return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  /** 往外发进度事件：渲染出错绝不能冒进 dsh 的事件分发，否则可能掐断整轮。 */
  function emit(run, event) {
    try {
      run.onEvent?.(event);
    } catch (error) {
      log(`[progress-event-failed] ${event?.type}: ${error.message}`);
    }
  }

  // ── 订阅 agent 状态：running -> idle 表示这一轮结束 ────────────────
  ctx.effect(() => {
    const off = ctx.on('agent/status', ({ agent, status }) => {
      if (process.env.FEISHU_PLUGIN_DEBUG === '1') log(`[status] ${agent.id} -> ${status}`);
      const run = runs.get(agent.id);
      if (!run) return;
      run.status = status;
      if (status === 'idle' && typeof run.settle === 'function') {
        const settle = run.settle;
        run.settle = null;
        settle();
      }
    });
    const offErr = ctx.on('agent/error', ({ agent, error }) => {
      log(`[agent-error] ${agent?.id}: ${error?.message || error}`);
      // 必须结算：agent 报错后通常不会再抛 idle 事件，
      // 而 dispatch 那边还 await 着 done —— 不结算就是永久挂起
      // （用户没回复、Typing 不摘、进度气泡不封口、队列堵死）。
      const run = runs.get(agent?.id);
      if (run && typeof run.settle === 'function') {
        const settle = run.settle;
        run.settle = null;
        settle({ text: run.texts.join('').trim(), tools: run.tools, error: String(error?.message || error || '') });
      }
    });
    return () => {
      try {
        off?.();
        offErr?.();
      } catch {
        /* ignore */
      }
    };
  });

  // ── 订阅 session 事件：工具调用 / 助手文本 ───────────────────────
  ctx.effect(() => {
    const off = ctx.on('session/event', (session, event) => {
      const sid = session?.header?.id;
      if (!sid) return;
      const run = runs.get(sid);
      if (!run) return;
      const type = event?.type;
      if (process.env.FEISHU_PLUGIN_DEBUG === '1') {
        log(`[event] ${type}`);
      }
      if (type === 'tool/call') {
        // dsh 的真实结构：{ turn, step, callId, name, arguments }
        // arguments 是「JSON 字符串」，要自己 parse 才能拿到 command/query 这类参数。
        const d = event.data ?? {};
        run.tools += 1;
        let input = d.arguments ?? d.input ?? d.args;
        if (typeof input === 'string') {
          try {
            input = JSON.parse(input);
          } catch {
            /* 不是 JSON 就原样带着 */
          }
        }
        emit(run, { type: 'tool_call', tool: d.name ?? d.tool ?? '', input, callId: d.callId });
      } else if (type === 'tool/result') {
        // dsh 的真实结构：{ turn, step, message: { role:'tool', content:[{type:'text',text}] } }
        const d = event.data ?? {};
        const blocks = d.message?.content;
        let out = '';
        if (Array.isArray(blocks)) {
          for (const b of blocks) {
            if (b && typeof b.text === 'string') out += b.text;
          }
        }
        const bad = d.isError === true || d.message?.isError === true;
        emit(run, {
          type: 'tool_result',
          status: bad ? 'failed' : 'completed',
          result: out || (typeof d.result === 'string' ? d.result : ''),
          callId: d.toolCallId ?? d.message?.toolCallId,
        });
      } else if (type === 'assistant/message') {
        const t = textOfAssistantEvent(event);
        if (t) run.texts.push(t);
        // 思考过程：照 Hermes 口径（gateway/run_turn_progress.py 的 _thinking），
        // 取首行 80 字，作为进度气泡里的 💬 行，跟工具行混排在同一条气泡。
        const think = reasoningOfAssistantEvent(event);
        if (think) emit(run, { type: 'thinking', text: think });
      }
    });
    return () => {
      try {
        off?.();
      } catch {
        /* ignore */
      }
    };
  });

  /** 取（或创建）某个 chat 的常驻 agent。 */
  async function ensure(chatId) {
    // agentOptions 支持传函数：每次建/恢复会话现读，设置页改完主模型即刻生效。
    const resolveAgentOptions = () =>
      typeof agentOptions === 'function' ? agentOptions() : agentOptions;

    const existing = slots.get(chatId);
    if (existing) {
      // 已经注册过、且 agent 还活着就直接复用
      try {
        if (existing.agent && existing.agent.status !== undefined) return existing;
      } catch {
        /* fall through to recreate */
      }
      // 要重建：先把旧的收干净。否则旧 handle 不 dispose、旧 run 不结算，
      // 会留下一个还在跑的孤儿 agent 和一条被遗弃的会话记录。
      try {
        await existing.handle?.dispose?.();
      } catch {
        /* ignore */
      }
      settleRun(existing.sessionId, { text: '', tools: 0, cancelled: true });
      slots.delete(chatId);
    }

    // dsh 刚启动的前 60 秒，插件工具还没全部注册进 agent scope。
    // 这时候 create() 会把残缺的工具表（59 个，缺 win_bash 等 19 个）快照进
    // 会话，第一轮 agent 就会说"没有这个工具"，要跑完一轮 tool-registry 才补。
    // 实测启动满 60 秒后建会话工具就齐了，所以这里按启动时长补足等待。
    // 日常（dsh 已跑超过 60 秒）这步直接跳过，零延迟。

    // ── agent preset 挂载 ───────────────────────────────────────
    // 官方 web 端建会话走 session-controller 的 composeAgent()：解析 preset 并
    // presets.mount(agentCtx, id) 把预设子树挂到 agent 上。严格的工具（web_search /
    // web_fetch 所属的 tool-web）在 root 层是 disabled，只在 preset 里启用——
    // 不挂 preset，agent 就只有 root 树的工具，搜不了网。
    const presets = ctx.get('agentPresets');
    let resolvedPreset;
    let presetSetup;
    if (!presets || typeof presets.resolve !== 'function' || typeof presets.mount !== 'function') {
      log(`[preset] agentPresets 服务不可用（${typeof presets}），agent 只有 root 工具树`);
    }
    if (presets && typeof presets.resolve === 'function' && typeof presets.mount === 'function') {
      try {
        resolvedPreset = (await presets.resolve(agentPreset))?.id;
        if (resolvedPreset) {
          presetSetup = async (agentCtx, agent) => {
            // 挂载失败只降级，绝不能让建会话失败——否则整个飞书机器人就哑了。
            try {
              await presets.mount(agentCtx, resolvedPreset);
              log(`[preset] 已挂载 ${resolvedPreset}（agent=${agent?.id ?? '?'}）`);
            } catch (error) {
              log(`[preset] 挂载 ${resolvedPreset} 失败，继续用 root 工具树：${error.message}`);
            }
          };
          log(`[preset] 解析到 agent preset: ${resolvedPreset}`);
        }
      } catch (error) {
        log(`[preset] 解析失败，退回 root 工具树：${error.message}`);
        resolvedPreset = undefined;
        presetSetup = undefined;
      }
    }

    if (process.uptime() < BOOT_GRACE_S) {
      const waitMs = Math.round((BOOT_GRACE_S - process.uptime()) * 1000);
      log(`[agent] dsh 刚启动，等 ${Math.round(waitMs / 1000)}s 让插件工具注册完再建会话`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    // 先看盘里有没有这个 chat 用过的 session：有就 resume，接着原来的上下文聊。
    const map = await loadAgentMap();
    const saved = map[chatId];
    let handle;
    let sessionId;

    if (saved) {
      try {
        handle = await ctx.agents.resume({
          resumeSessionId: saved,
          ...(presetSetup ? { setup: presetSetup } : {}),
          agentOptions: { ...resolveAgentOptions() },
        });
        sessionId = saved;
        log(`[agent] 恢复会话 chat=${chatId} session=${saved}`);
      } catch (error) {
        log(`[agent] 恢复失败（${error.message}），改为新建`);
        handle = null;
      }
    }

    if (!handle) {
      // ⚠️ 走到这里说明 resume 已失败（saved 就是刚才失败的那个 id）。
      // 绝不能复用它去 create——会撞上残留的会话记录。一律新开。
      sessionId = `feishu-${chatId}-${randomUUID().slice(0, 8)}`;
      handle = await ctx.agents.create({
        sessionId,
        meta: {
          cwd: cwd || process.cwd(),
          ...(resolvedPreset ? { agentPreset: resolvedPreset } : {}),
        },
        // agentOptions 必须给 provider/model —— 不给的话 persona 模板里的
        // {{model}} 变量没有值，agent 会直接 agent-error 退出（turn/end + idle）。
        ...(presetSetup ? { setup: presetSetup } : {}),
        agentOptions: { ...resolveAgentOptions() },
      });
      log(`[agent] 新建会话 chat=${chatId} session=${sessionId}`);
    }

    // 卡片归属人：建会话这一刻的发送方。之后不再改变。
    const owner = typeof resolveActor === 'function' ? resolveActor(chatId) : undefined;
    const slot = { handle, sessionId, agent: handle.agent, owner };
    slots.set(chatId, slot);

    // 落盘，供 dsh 重启后 resume。只写自己这一条 key，
    // 避免把并发处理中别的 chat 刚写进去的映射覆盖掉。
    if (map[chatId] !== sessionId) {
      map[chatId] = sessionId;
      await updateAgentMap((current) => {
        current[chatId] = sessionId;
      });
    }
    return slot;
  }

  /**
   * 发一条消息。
   * @returns {{mode:'steer'|'followup', done: Promise<{text:string, tools:number}>}}
   */
  async function send(chatId, prompt, { onEvent, attachments = [] } = {}) {
    const slot = await ensure(chatId);
    const agent = slot.agent;

    // 富媒体走 dsh 自身的附件通道：图片交给 attachments 准入（校验 + 落盘 + 签发 ref），
    // 文件同理。准入失败不能连累文字 —— 退化成纯文本并把原因带回 prompt。
    let content = prompt;
    let attachNote = '';
    if (Array.isArray(attachments) && attachments.length) {
      try {
        const store = ctx.attachments;
        if (!store) throw new Error('dsh 没有 attachments 服务');
        const parts = [];
        if (prompt) parts.push({ type: 'text', text: prompt });
        for (const item of attachments) {
          if (item.kind === 'image') {
            parts.push({ type: 'image', mediaType: item.mediaType, data: item.base64, name: item.name });
          } else {
            // 文件先落成 durable ref，再作为 file block 并入同一条消息
            const ref = await store.admitEncodedFile({ data: item.base64, name: item.name });
            parts.push({ type: 'file', attachment: ref });
          }
        }
        // 图片在这里一次性校验+入库；纯文件/纯文本会原样穿过
        content = await store.admitPromptContent(parts);
      } catch (error) {
        log(`[attachment-rejected] ${error.message}；降级为纯文本`);
        attachNote = `\n\n[附件未能送入模型：${error.message}]`;
        content = `${prompt || ''}${attachNote}`.trim();
      }
    }

    const msg = makeUserMessage(content);

    // ⚠️ 状态必须在所有 await 之后再读。
    // 原来在附件准入之前就取 `running` 快照，准入要走磁盘/校验（带图时是真实耗时），
    // 这期间这一轮可能已经结束、run 记录被结算删除。那样就会：
    //   ① 对着空闲 agent 调 steer（它会自己开一轮）
    //   ② run 查不到 → 又调一次 followup → 同一条消息被投递两遍
    //   ③ 还返回一个已 resolve 的空 done，真正的回答没人接
    const running = agent.status === 'running';
    let run = runs.get(slot.sessionId);
    if (running) {
      if (run && typeof onEvent === 'function') {
        // 先换事件出口再 steer：agent.steer() 之后可能立刻吐下一个事件，
        // 换晚了那几个事件还会落进旧气泡。
        run.onEvent = onEvent;
        run.steered = (run.steered ?? 0) + 1;
      }
      agent.steer(msg);
      log(`[agent] steer 插入任务 chat=${chatId} session=${slot.sessionId}`);
      if (run) {
        return { mode: 'steer', done: run.promise };
      }
      // agent 在跑但没有 run 记录（极端竞态）：消息已经由 steer 交出去了，
      // 绝不能再 followup 一次（那是同一条消息投两遍）。
      // 这里返回一个永不 resolve 的 done 也不对——上层会一直等，
      // 所以返回一个立即完成、但明确标注「已由 steer 接管」的结果：
      // 上层据此不补发最终回复（消息内容已经进了正在跑的那轮）。
      log('[agent] steer 时没有 run 记录，消息已交给当前轮，不再补发回复');
      return { mode: 'steer', done: Promise.resolve({ text: '', tools: 0, steered: true }) };
    }

    // 先登记 run 再 followup：否则 agent 跑得极快时，
    // status -> idle 事件到达时 runs 里还查不到记录，永远等不到结算。
    run = {
      status: 'running',
      texts: [],
      tools: 0,
      steered: 0,
      onEvent,
      settle: null,
    };
    run.promise = new Promise((resolve) => {
      // override 用于「外部强制结束」（/new 拆会话、dispose）：这时没有真实回答，
      // 用 cancelled 标记让上层安静收尾，而不是补一条「没有产生回答」。
      run.settle = (override) => {
        runs.delete(slot.sessionId);
        resolve(override ?? { text: run.texts.join('').trim(), tools: run.tools });
      };
    });
    runs.set(slot.sessionId, run);

    agent.followup(msg);
    log(`[agent] followup 开新一轮 chat=${chatId} session=${slot.sessionId}`);

    // ── 模型故障转移（dsh 0.2.2+ 的逐轮重试路径）──────────────────
    //
    // 0.2.2 把 agent/request 的路由冻结了，不能在同一轮里换模型；
    // 官方通道 agent.model.select() 只对「下一个 step」生效，而重试循环
    // 复用的是同一个 decision.selection，所以 step 内换模型这条路不存在。
    //
    // 解法：这一轮失败 → 用链上下一个模型重开一轮。
    // 会话不变，历史全在，已经跑过的工具调用不会重放。
    // 每轮现取：传函数时能拿到重载后的新实例，传实例时就是它自己。
    const readFallback = () =>
      typeof modelFallback === 'function' ? modelFallback() : modelFallback;

    const retryDone = run.promise.then(async (result) => {
      const fallbackNow = readFallback();
      if (!fallbackNow || result?.cancelled) return result;
      if (!result?.error) {
        fallbackNow.reset(agent.id);   // 这一轮成功，下轮回到主模型
        return result;
      }

      let attempt = 0;
      let current = result;
      while (attempt < MAX_MODEL_RETRIES) {
        const verdict = fallbackNow.shouldRetry(agent);
        if (!verdict?.retry || !verdict.route) break;

        attempt += 1;
        const { provider, model } = verdict.route;
        log(
          `[fallback] 本轮失败（${current.error?.slice(0, 120) || 'unknown'}），`
            + `改用 ${provider}/${model} 重开一轮（第 ${attempt} 次重试）`,
        );

        // 官方通道：把下一个 step 的选择切到备用模型
        try {
          agent.model.select({ provider, model });
        } catch (error) {
          log(`[fallback] model.select 失败，放弃重试：${error.message}`);
          break;
        }

        // 重开一轮：同一个 agent、同一个 session，只是换了模型
        // 先等 agent 真正回到 idle：失败时 run 可能是被 agent/error 结算的，
        // 而 kick 这时还在收尾（phase 还是 running）。此时 followup 进去的
        // 消息会排在队列里，等收尾完才被唤醒——多等一会儿更稳。
        await waitIdle(agent);

        const retryRun = {
          status: 'running',
          texts: [],
          tools: run.tools,     // 工具计数接着算，不归零
          steered: 0,
          onEvent: run.onEvent,
          settle: null,
        };
        const retryPromise = new Promise((res) => {
          retryRun.settle = (override) => {
            runs.delete(slot.sessionId);
            res(override ?? { text: retryRun.texts.join('').trim(), tools: retryRun.tools });
          };
        });
        runs.set(slot.sessionId, retryRun);

        agent.followup(makeUserMessage(content));
        current = await retryPromise;

        if (!current?.error) {
          log(`[fallback] 备用模型 ${provider}/${model} 成功`);
          break;
        }
      }

      fallbackNow.reset(agent.id);
      return current;
    });

    return { mode: 'followup', done: retryDone };
  }

  /** 中止当前任务（保留会话本身）。返回 true 表示确实有东西被中断。 */
  function cancel(chatId) {
    const slot = slots.get(chatId);
    if (!slot) return false;
    // 没在跑就别谎报「已中止」——agent.cancel 在空闲时是 no-op。
    const hasRun = runs.has(slot.sessionId);
    let running = false;
    try {
      running = slot.agent?.status === 'running';
    } catch {
      running = false;
    }
    if (!hasRun && !running) {
      log(`[agent] /stop 时无任务在跑 chat=${chatId}`);
      return false;
    }
    try {
      slot.agent.cancel({ kind: 'user' });
      log(`[agent] 已中止 chat=${chatId} session=${slot.sessionId}`);
      return true;
    } catch (error) {
      log(`[agent] 取消失败：${error.message}`);
      return false;
    }
  }

  /** 丢掉会话、下次重开（/new）。同时清掉盘上的映射。 */
  async function reset(chatId) {
    await dispose(chatId);
    await updateAgentMap((map) => {
      delete map[chatId];
    });
    log(`[agent] 已重置会话 chat=${chatId}`);
  }

  /**
   * 由 agent id（= session id）反查飞书 chat —— 审批卡片要发到对应会话。
   *
   * 三级兜底，因为 agent 的 id 未必等于我们建的 sessionId：
   *   ① sessionId / agent.id 精确匹配
   *   ② 只有一个会话时直接用它（绝大多数情况都是单聊）
   *   ③ 都给不出就返回 undefined，让调用方用自己的默认 chat
   */
  function chatOfAgent(agentId) {
    if (agentId) {
      for (const [chatId, slot] of slots) {
        if (slot.sessionId === agentId || slot.agent?.id === agentId) return chatId;
      }
      // 拿到了一个「不属于我们」的 id：直接返回 undefined 交给下一个应答者。
      // 原来这里会回落到「唯一的那个会话」，结果 dsh Web UI 里的会话
      // 发起审批/提问时，会被飞书这边认领并弹卡片到那个飞书会话，
      // Web 端用户的操作被另一个通道代答（或卡到超时按默认值继续）。
      log(`[agent] agent=${agentId} 不属于飞书会话，交给下一个应答者`);
      return undefined;
    }
    // 拿不到 id 时（极少数事件不带 agent）才允许回落到唯一会话
    if (slots.size === 1) {
      const only = slots.keys().next().value;
      log('[agent] agent 为空，会话只有一个，回落到 chat=' + only);
      return only;
    }
    return undefined;
  }

  /** 某个 chat 当前是否在跑。 */
  function isRunning(chatId) {
    const slot = slots.get(chatId);
    if (!slot) return false;
    try {
      return slot.agent?.status === 'running';
    } catch {
      return false;
    }
  }

  /** 结算某个 session 上挂着的 run（幂等）。dispose / cancel 都要用。 */
  function settleRun(sessionId, override) {
    const run = runs.get(sessionId);
    if (!run) return false;
    if (typeof run.settle === 'function') {
      const settle = run.settle;
      run.settle = null;
      settle(override);
    }
    runs.delete(sessionId);
    return true;
  }

  async function dispose(chatId) {
    const slot = slots.get(chatId);
    if (!slot) return;
    slots.delete(chatId);
    // 必须先结算再删记录：上一轮那边还 await 着 done，
    // 记录被直接删掉的话 settle 永远不会被调用，那一轮就永久卡死了
    // （Typing 不摘、进度气泡不收、后续消息全排在这条队列后面）。
    settleRun(slot.sessionId, { text: '', tools: 0, cancelled: true });
    try {
      await slot.handle.dispose();
    } catch {
      /* ignore */
    }
  }

  /**
   * 由 agent id 反查这条会话的卡片归属人（建会话时固定下来的发送方）。
   * 审批/提问卡片只认这个人点击。
   */
  function ownerOfAgent(agentId) {
    if (!agentId) return undefined;
    for (const slot of slots.values()) {
      if (slot.sessionId === agentId || slot.agent?.id === agentId) return slot.owner;
    }
    return undefined;
  }

  return {
    send,
    isRunning,
    ensure,
    dispose,
    cancel,
    reset,
    chatOfAgent,
    ownerOfAgent,
    _slots: slots,
  };
}