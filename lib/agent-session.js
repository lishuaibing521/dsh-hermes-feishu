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
import { readFile, writeFile, mkdir } from 'node:fs/promises';
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

async function saveAgentMap(map) {
  const target = agentStorePath();
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(map, null, 2), 'utf8');
}

/** 构造一条 dsh 认的 user message（等价于 dsh-llm 的 createUserMessage）。 */
function makeUserMessage(text) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
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

export function createInProcessRunner({ ctx, log = () => {}, cwd, agentOptions = {}, agentPreset }) {
  /** chatId -> { handle, sessionId, agent, createdAt } */
  const slots = new Map();
  /** sessionId -> 一轮运行的状态 */
  const runs = new Map();

  const otherSessionOf = (sessionId) => {
    return sessionId ? sessionId : '';
  };

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
        run.onEvent?.({ type: 'tool_call', tool: d.name ?? d.tool ?? '', input });
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
        run.onEvent?.({
          type: 'tool_result',
          status: bad ? 'failed' : 'completed',
          result: out || (typeof d.result === 'string' ? d.result : ''),
        });
      } else if (type === 'assistant/message') {
        const t = textOfAssistantEvent(event);
        if (t) run.texts.push(t);
        // 思考过程：照 Hermes 口径（gateway/run_turn_progress.py 的 _thinking），
        // 取首行 80 字，作为进度气泡里的 💬 行，跟工具行混排在同一条气泡。
        const think = reasoningOfAssistantEvent(event);
        if (think) run.onEvent?.({ type: 'thinking', text: think });
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

    const slot = { handle, sessionId, agent: handle.agent };
    slots.set(chatId, slot);

    // 落盘，供 dsh 重启后 resume
    if (map[chatId] !== sessionId) {
      map[chatId] = sessionId;
      await saveAgentMap(map);
    }
    return slot;
  }

  /**
   * 发一条消息。
   * @returns {{mode:'steer'|'followup', done: Promise<{text:string, tools:number}>}}
   */
  async function send(chatId, prompt, { onEvent } = {}) {
    const slot = await ensure(chatId);
    const agent = slot.agent;
    const running = agent.status === 'running';

    const msg = makeUserMessage(prompt);

    // 运行中 -> 插入当前轮；空闲 -> 起新一轮
    let run = runs.get(slot.sessionId);
    if (running) {
      agent.steer(msg);
      log(`[agent] steer 插入任务 chat=${chatId} session=${slot.sessionId}`);
      if (run) {
        run.steered = (run.steered ?? 0) + 1;
        // 不要替换 run.onEvent：进度气泡归「起这一轮的那条消息」所有。
        // 插入的消息只负责把内容送进 agent，不该抢走进度回调。
        return { mode: 'steer', done: run.promise };
      }
      // 没有 run 记录（理论上不该发生）——按 followup 处理
      agent.followup(msg);
      return { mode: 'followup', done: Promise.resolve({ text: '', tools: 0 }) };
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
      run.settle = () => {
        runs.delete(slot.sessionId);
        resolve({ text: run.texts.join('').trim(), tools: run.tools });
      };
    });
    runs.set(slot.sessionId, run);

    agent.followup(msg);
    log(`[agent] followup 开新一轮 chat=${chatId} session=${slot.sessionId}`);
    return { mode: 'followup', done: run.promise };
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
    const map = await loadAgentMap();
    if (map[chatId]) {
      delete map[chatId];
      await saveAgentMap(map);
    }
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
    }
    if (slots.size === 1) {
      const only = slots.keys().next().value;
      log(`[agent] agent=${agentId ?? '(空)'} 未精确匹配，会话只有一个，回落到 chat=${only}`);
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

  async function dispose(chatId) {
    const slot = slots.get(chatId);
    if (!slot) return;
    slots.delete(chatId);
    runs.delete(slot.sessionId);
    try {
      await slot.handle.dispose();
    } catch {
      /* ignore */
    }
  }

  return { send, isRunning, ensure, dispose, cancel, reset, chatOfAgent, _slots: slots };
}