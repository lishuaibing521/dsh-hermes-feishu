// dsh-hermes-feishu — 入站 → dsh agent → 回卡片。
//
// 收到飞书消息后：
//   1) 归一化（inbound.js）
//   2) 按会话查/建 dsh session，跑 `dsh --profile <p> --json [--session-id X] "<任务>"`
//   3) 把最终文本用我们的渲染器发回飞书（表格 -> 原生 table 组件）
//
/** 会话连续性：每个 chat 记住自己的 sessionId（持久化到 ~/.dsh/feishu-plugin-sessions.json）。 */

import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { normalizeFeishuMessage } from './inbound.js';
import { buildOutboundPayload } from './render.js';
import { ProgressBubble } from './progress.js';
import { transcribeAudio, sttConfigured } from './stt.js';
import { FeishuClient } from './feishu.js';

// 飞书在「事件处理完才 ack」时会因超时重投同一事件。去重表必须是模块级，
// 否则多个 handler 实例各记一份，重复投递照样跑两遍。
const _seenMessageIds = new Map(); // messageId -> 首次处理时间戳
const SEEN_TTL_MS = 10 * 60 * 1000;
function alreadyHandled(messageId) {
  if (!messageId) return false;
  const now = Date.now();
  for (const [id, ts] of _seenMessageIds) {
    if (now - ts > SEEN_TTL_MS) _seenMessageIds.delete(id);
  }
  if (_seenMessageIds.has(messageId)) return true;
  _seenMessageIds.set(messageId, now);
  return false;
}


function dshHome() {
  const home = process.env.DSH_HOME;
  return typeof home === 'string' && home.length > 0 ? home : join(homedir(), '.dsh');
}

function sessionStorePath() {
  return join(dshHome(), 'feishu-plugin-sessions.json');
}

/** 读会话映射：{ [chatId]: sessionId } */
async function loadSessions() {
  try {
    const raw = await readFile(sessionStorePath(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function saveSessions(sessions) {
  const target = sessionStorePath();
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(sessions, null, 2), 'utf8');
}


/**
 * 从回答文本里认出本地图片路径并发送。
 * dsh-image-gen 出图后会把路径写在回答里（例如 C:\...\dsh-image-gen\image-xxxx.png），
 * 聊天里只看到路径很别扭，所以这里直接把图发出去。
 */
async function sendGeneratedImages({ client, chatId, replyTo, text, log }) {
  if (!text) return;
  const candidates = new Set();
  const re = /((?:[A-Za-z]:[\\/]|\/)[^\n\r"'<>|?*]*?\.(?:png|jpe?g|webp|gif))\b/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    candidates.add(m[1].trim());
  }
  if (candidates.size === 0) return;

  for (const path of candidates) {
    try {
      const buffer = await readFile(path);
      if (buffer.byteLength === 0) continue;
      const fileName = path.split(/[\\/]/).pop() || 'image.png';
      const imageKey = await client.uploadImage({ buffer, fileName });
      await client.sendMessage({
        receiveId: chatId,
        receiveIdType: 'chat_id',
        msgType: 'image',
        content: JSON.stringify({ image_key: imageKey }),
      });
      log(`[image-sent] ${fileName} (${buffer.byteLength} 字节)`);
    } catch (error) {
      log(`[image-send-failed] ${path}: ${error.message}`);
    }
  }
}

/**
 * agent 的工作目录。
 *
 * dsh-ops 的沙箱要求 workspace root 的 ACL owner 是当前用户，而 C:\Users\<user>
 * 这层目录的 owner 往往是 NT AUTHORITY\SYSTEM，直接用它会让 ops_bash 起不来
 * （"the workspace root ... does not meet the sandbox prerequisite"）。
 * 所以默认落在一个自己创建的、owner 一定是当前用户的目录里。
 */
function agentWorkdir() {
  const configured = process.env.FEISHU_PLUGIN_WORKSPACE;
  if (typeof configured === 'string' && configured.trim()) return configured.trim();
  return join(dshHome(), 'workspace');
}

/** 确保工作目录存在（同步创建，spawn 之前必须就绪）。 */
function ensureWorkdir(dir) {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* 建不了就交给 spawn 报错 */
  }
  return dir;
}

/** 找到 dsh 可执行（优先用当前进程的 node + 全局 bin.js） */
function resolveDshCommand() {
  const explicit = process.env.DSH_PLUGIN_DSH_BIN;
  if (explicit) return { cmd: process.execPath, args: [explicit] };

  // 默认：AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/bin.js
  const home = homedir();
  const candidate = join(
    home,
    'AppData',
    'Roaming',
    'npm',
    'node_modules',
    '@deepseek-ai',
    'dsh',
    'lib',
    'bin.js',
  );
  return { cmd: process.execPath, args: [candidate] };
}

/**
 * 跑一次 dsh agent，返回 { sessionId, text }。
 * 用 --json 逐行读事件：session 事件给 sessionId，final 事件给最终文本。
 */
export function runAgentTask({ profile, prompt, sessionId, cwd, timeoutMs = 600000, onEvent }) {
  return new Promise((resolve, reject) => {
    const dsh = resolveDshCommand();
    const args = [...dsh.args, '--profile', profile, '--json'];
    if (sessionId) args.push('--session-id', sessionId);
    args.push(prompt);

    let child;
    try {
      child = spawn(dsh.cmd, args, {
        cwd: cwd || ensureWorkdir(agentWorkdir()),
        windowsHide: true,
        env: {
          ...process.env,
          // 关键：子进程（headless agent）也会加载本插件。若不显式关掉，
          // 它会再起一条飞书长连接，形成递归并抢走消息。
          FEISHU_PLUGIN_INBOUND: '0',
        },
      });
    } catch (error) {
      reject(error);
      return;
    }

    let outBuf = '';
    let errBuf = '';
    let newSessionId = '';
    let finalText = '';
    const texts = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      reject(new Error(`dsh agent 超时（${Math.round(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      outBuf += chunk;
      let idx;
      while ((idx = outBuf.indexOf('\n')) >= 0) {
        const line = outBuf.slice(0, idx).trim();
        outBuf = outBuf.slice(idx + 1);
        if (!line.startsWith('{')) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === 'session' && event.sessionId) newSessionId = event.sessionId;
        else if (event.type === 'text' && typeof event.text === 'string') texts.push(event.text);
        else if (event.type === 'final' && typeof event.text === 'string') finalText = event.text;
        // 把事件交给调用方（流式卡片用），单条事件异常不能影响主流程
        try {
          onEvent?.(event);
        } catch {
          /* ignore */
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      errBuf += chunk;
      if (errBuf.length > 20000) errBuf = errBuf.slice(-20000);
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const answer = finalText || texts.join('');
      if (code !== 0 && !answer) {
        reject(new Error(`dsh agent 退出码 ${code}：${errBuf.trim().slice(-500) || '(无 stderr)'}`));
        return;
      }
      resolve({ sessionId: newSessionId || sessionId || '', text: answer.trim() });
    });
  });
}

/**
 * 创建一个入站处理器：消息 -> agent -> 卡片回复。
 *
 * @param {object} options
 * @param {FeishuClient} options.client
 * @param {string} options.profile        跑哪个 dsh profile（默认 headless）
 * @param {string} [options.botName]      卡片标题
 * @param {(msg: string) => void} [options.log]
 */
export function createMessageHandler({
  client,
  profile = 'headless',
  botName = '',
  log = () => {},
  runner = null,
  /** 每次处理消息现读的运行期配置（进度气泡行为 + STT 选择），改设置即刻生效。 */
  getRuntime = null,
  /** 由 index.js 注入：优先走 dsh 的 speechToText 服务，拿不到再退回直连百度。 */
  transcribe = null,
}) {
  // 同一个会话串行处理，避免并发跑同一个 session
  const queues = new Map();

  const handleOne = async (event) => {
    // 每次现读，不做启动快照——设置页保存后下一条消息就用新值。
    const rt = typeof getRuntime === 'function' ? getRuntime() ?? {} : {};
    const { progressOptions = {}, sttProvider = 'baidu', sttLanguage = 'auto' } = rt;

    const msg = event?.message ?? {};
    const sender = event?.sender ?? {};

    // 去重：同一条消息只处理一次（用模块级 seen，避免多个 handler 实例各记一份）
    if (alreadyHandled(msg.message_id)) {
      log(`[skip] 重复投递 message_id=${msg.message_id}`);
      return;
    }

    // 忽略机器人自己发的消息（防回环）
    if (sender.sender_type === 'app' || sender.sender_type === 'bot') return;

    // chatId 必须在任何发送/日志之前声明——下面 STT 分支就要用它
    const chatId = msg.chat_id;

    // 群聊只处理被 @ 的
    const chatType = msg.chat_type ?? '';
    const mentions = msg.mentions ?? [];
    const botOpenId = process.env.FEISHU_PLUGIN_BOT_OPEN_ID ?? '';
    if (chatType === 'group') {
      const mentioned = mentions.some((m) => m?.id?.open_id && m.id.open_id === botOpenId);
      if (!mentioned) return;
    }

    const parsed = normalizeFeishuMessage({
      messageType: msg.message_type,
      rawContent: msg.content,
      mentions,
      bot: { openId: botOpenId },
    });

    let prompt = (parsed.textContent ?? '').trim();

    // 语音消息：下载 -> 百度 STT -> 用识别出来的文字当 prompt
    const audioRef = (parsed.mediaRefs ?? []).find((ref) => ref.resourceType === 'audio');
    if (audioRef) {
      if (!sttConfigured()) {
        log('[stt] 缺少百度语音凭据，跳过语音识别');
        await client
          .sendMessage({
            receiveId: chatId,
            receiveIdType: 'chat_id',
            msgType: 'text',
            content: JSON.stringify({ text: '⚠️ 收到语音，但语音识别未配置（缺 BAIDU_VOICE_API_KEY / BAIDU_VOICE_SECRET_KEY）' }),
          })
          .catch(() => undefined);
        return;
      }
      try {
        log(`[stt] 下载语音 file_key=${audioRef.fileKey}`);
        const media = await client.downloadResource({
          messageId: msg.message_id,
          fileKey: audioRef.fileKey,
          type: 'file',
        });
        // downloadResource 返回 { buffer, contentType }
        const text = transcribe
          ? await transcribe(media.buffer, '.opus', { providerId: sttProvider, language: sttLanguage })
          : await transcribeAudio(media.buffer, '.opus', { language: sttLanguage });
        if (text && text.trim()) {
          prompt = text.trim();
          log(`[stt] 识别结果：${prompt.slice(0, 60)}`);
        } else {
          prompt = '[语音消息，未能识别出文字]';
        }
      } catch (error) {
        log(`[stt-failed] ${error.message}`);
        prompt = `[语音消息识别失败：${error.message}]`;
      }
    }

    if (!prompt) {
      log(`[skip] 空消息 chat=${chatId} type=${msg.message_type}`);
      return;
    }


    // 急停 / 重开：长任务跑起来之后用户唯一的逃生口，必须在队列最前面拦。
    const cmd = prompt.trim().toLowerCase();
    if (cmd === '/stop' || cmd === '/停') {
      const ok = runner ? runner.cancel(chatId) : false;
      log(`[cmd] /stop chat=${chatId} ok=${ok}`);
      try {
        await client.replyMessage({
          messageId: msg.message_id,
          msgType: 'text',
          content: JSON.stringify({ text: ok ? '⏹ 已中止当前任务' : '当前没有在跑的任务' }),
        });
      } catch (error) {
        log(`[cmd-reply-failed] ${error.message}`);
      }
      return;
    }
    if (cmd === '/new' || cmd === '/新') {
      if (runner) await runner.reset(chatId);
      log(`[cmd] /new chat=${chatId}`);
      try {
        await client.replyMessage({
          messageId: msg.message_id,
          msgType: 'text',
          content: JSON.stringify({ text: '🆕 已开新会话' }),
        });
      } catch (error) {
        log(`[cmd-reply-failed] ${error.message}`);
      }
      return;
    }

    const sessions = await loadSessions();
    const prior = sessions[chatId];

    log(`[run] chat=${chatId} session=${prior ?? '(new)'} len=${prompt.length}`);

    // 开工反馈用「表情回复」而不是发一条消息 —— 和 Hermes 一致：
    // 处理中给消息挂 Typing（敲键盘那个），成功就摘掉，失败换成 CrossMark。
    // 发文本占位会在聊天里多出一条无用消息，用户看得到但没信息量。
    let reactionId = null;
    try {
      const data = await client.addReaction({ messageId: msg.message_id, emojiType: 'Typing' });
      reactionId = data?.reaction_id ?? null;
    } catch (error) {
      log(`[reaction-add-failed] ${error.message}`);
    }

    const progress = new ProgressBubble({
      client,
      chatId,
      replyTo: msg.message_id,
      enabled: true,
      log,
      ...progressOptions,
    });

    let text = '';
    let sessionId = prior ?? '';
    let failed = false;
    let reason = '';
    // steered=true：这条消息被插进了正在跑的任务，不新起一轮、
    // 也不再单独回最终答案（结果跟原任务一起出来）。
    let steered = false;
    try {
      if (runner) {
        // 进程内 agent：空闲时 followup 起新一轮，运行中 steer 原地插入。
        const sent = await runner.send(chatId, prompt, {
          onEvent: (event) => {
            if (event.type === 'tool_call') progress.toolStart(event);
            else if (event.type === 'tool_result') progress.toolEnd(event);
            else if (event.type === 'thinking') progress.thinking(event.text);
          },
        });
        if (sent.mode === 'steer') {
          steered = true;
          log('[steer] 已插入正在执行的任务');
        } else {
          const result = await sent.done;
          text = result.text;
        }
      } else {
      const run = (sid) =>
        runAgentTask({
          profile,
          prompt,
          sessionId: sid,
          onEvent: (event) => {
            if (event.type === 'tool_call') progress.toolStart(event);
            else if (event.type === 'tool_result') progress.toolEnd(event);
            else if (event.type === 'thinking') progress.thinking(event.text);
          },
        });

      let result;
      try {
        result = await run(prior);
      } catch (error) {
        // 旧会话可能属于别的工作目录（改过 workspace 就会这样），
        // dsh 会拒绝在另一个 cwd 下续接。这时丢掉旧会话重新开一个，
        // 不要让用户看到一条失败就没了。
        if (prior && /workspace|session|not found|does not match|cwd/i.test(error.message)) {
          log(`[session-reuse-failed] ${error.message}；改为新建会话重试`);
          delete sessions[chatId];
          await saveSessions(sessions);
          result = await run('');
        } else {
          throw error;
        }
      }
      text = result.text;
      sessionId = result.sessionId || sessionId;
      }
    } catch (error) {
      failed = true;
      reason = error.message;
      log(`[agent-failed] ${error.message}`);
    }

    if (sessionId && sessionId !== prior) {
      sessions[chatId] = sessionId;
      await saveSessions(sessions);
    }

    // 插入型消息：跟 Hermes 一样「静默吸收」—— 消息已经并进正在跑的那一轮，
    // 不再单独回一条确认。只把 Typing 表情摘掉，不留痕迹。
    if (steered) {
      if (reactionId) {
        try {
          await client.removeReaction({ messageId: msg.message_id, reactionId });
        } catch (error) {
          log(`[reaction-remove-failed] ${error.message}`);
        }
      }
      return;
    }

    // 进度气泡收尾，最终回答另发一条
    await progress.finish();

    // 摘掉 Typing；失败的换成 CrossMark（成功不额外加标记，回复本身就是信号）
    if (reactionId) {
      try {
        await client.removeReaction({ messageId: msg.message_id, reactionId });
      } catch (error) {
        log(`[reaction-remove-failed] ${error.message}`);
      }
    }
    if (failed) {
      try {
        await client.addReaction({ messageId: msg.message_id, emojiType: 'CrossMark' });
      } catch (error) {
        log(`[reaction-mark-failed] ${error.message}`);
      }
    }

    // agent 用 dsh-image-gen 生图时会存到本地并把路径写进回答。
    // 这里把图片文件找出来直接发过去 —— 用户要看到图，不是看到路径。
    await sendGeneratedImages({ client, chatId, replyTo: msg.message_id, text, log });

    const answer = failed ? `❌ 处理失败：${reason}` : (text || '(没有产生回答)');
    const routed = buildOutboundPayload(answer, { botName });
    try {
      await client.replyMessage({
        messageId: msg.message_id,
        msgType: routed.msgType,
        content: routed.content,
      });
    } catch (error) {
      log(`[reply-failed] ${error.message}，改为普通发送`);
      await client.sendMessage({
        receiveId: chatId,
        receiveIdType: 'chat_id',
        msgType: routed.msgType,
        content: routed.content,
      });
    }
  };

  // ⚠️ 必须「立刻返回」：飞书长连接只在事件回调 resolve 后才 ack，
  // 而跑一轮 agent 要十几秒，超过 ack 超时就会被重投一遍（同一条消息答两次）。
  // 所以这里只登记任务、不等待，agent 在后台跑。
  //
  // 关键：不能再无脑串行排队。任务在跑时收到的消息必须「立刻」处理，
  // 交给 runner.send() 走 steer 插进当前轮；排进队列只会让插入失效
  // （等前一个任务跑完再执行 = 变成下一条独立消息，也就插不进正在跑的任务）。
  // 只有 /stop /new 这类控制命令和 agent 空闲时的消息需要排队，防止乱序。
  return function onMessage(event) {
    const chatId = event?.message?.chat_id ?? 'unknown';

    const task = () =>
      handleOne(event).catch((error) => {
        log(`[error] chat=${chatId} ${error.message}`);
      });

    // 有任务在跑 -> 并发投递，让它 steer 插进去；否则按顺序来。
    if (runner && runner.isRunning(chatId)) {
      log(`[queue] 任务进行中，直接投递（将走 steer）chat=${chatId}`);
      task();
      return;
    }

    const prev = queues.get(chatId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(task);
    queues.set(chatId, next);
    // 不 return / 不 await：立即完成，让飞书马上收到 ack。
  };
}