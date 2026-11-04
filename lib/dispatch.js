// dsh-hermes-feishu — 入站 → dsh agent → 回卡片。
//
// 收到飞书消息后：
//   1) 归一化（inbound.js）
//   2) 按会话查/建 dsh session，跑 `dsh --profile <p> --json [--session-id X] "<任务>"`
//   3) 把最终文本用我们的渲染器发回飞书（表格 -> 原生 table 组件）
//
/** 会话连续性：每个 chat 记住自己的 sessionId（持久化到 ~/.dsh/feishu-plugin-sessions.json）。 */

import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { normalizeFeishuMessage } from './inbound.js';
import { parseAllowFrom } from './config.js';
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

// 所有会话映射写入排一条队：两个 chat 同时处理时，各自拿到的是同一份旧快照，
// 后写的会把先写的那条覆盖掉（会话连续性丢失）；两个 writeFile 同时写同一路径
// 还可能互相截断，产出坏 JSON（loadSessions 的 catch 会静默当空表，全部映射一次性丢光）。
let _sessionWriteChain = Promise.resolve();

/** 只改自己的那条 key：在串行区内重新读取，再合并，最后原子替换。 */
function updateSessions(mutate) {
  _sessionWriteChain = _sessionWriteChain.catch(() => undefined).then(async () => {
    const target = sessionStorePath();
    const current = await loadSessions();
    mutate(current);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    await writeFile(tmp, JSON.stringify(current, null, 2), 'utf8');
    await rename(tmp, target);   // 原子替换，避免读到半截文件
  });
  return _sessionWriteChain;
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
// ── 入站附件：把飞书图片/文件真正下载下来，交给 dsh 的附件通道 ────────────
//
// 飞书消息本身只给 file_key，字节要另外调 /resources 拉。以前只有语音走了这条路，
// 图片和文件解析出来就没人管，最后被「空消息」判断丢掉。
//
// 这里统一收：图片 -> { kind:'image', mediaType, base64, name }
//             文件 -> { kind:'file', base64, name }
// agent-session 再拿它们去 ctx.attachments 准入，生成 image/file content block。

/** 飞书图片可能是这四种之外的格式，附件服务只认这四个。 */
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** 按文件头嗅探真实格式，返回 null 表示不是附件服务认得的图片。 */
function sniffImageMediaType(buffer, contentType) {
  if (buffer.length > 8) {
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
    if (buffer.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
    if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  }
  const declared = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  return IMAGE_MEDIA_TYPES.has(declared) ? declared : null;
}

/** 单个附件上限：太大的内容塞进对话只会把上下文撑爆。 */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * 把一条飞书消息里的图片和文件全部下载下来。
 * 任何一个失败都不影响其它附件，也不会阻塞整条消息。
 */
async function collectAttachments({ client, msg, parsed, log = () => {} }) {
  const images = [];
  const files = [];
  const notes = [];

  const imageKeys = Array.isArray(parsed.imageKeys) ? parsed.imageKeys : [];
  for (const [index, fileKey] of imageKeys.entries()) {
    try {
      const media = await client.downloadResource({ messageId: msg.message_id, fileKey, type: 'image' });
      const buffer = media?.buffer;
      if (!buffer?.length) throw new Error('下载到 0 字节');
      if (buffer.length > MAX_ATTACHMENT_BYTES) throw new Error(`超过 ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB`);
      const mediaType = sniffImageMediaType(buffer, media.contentType);
      if (!mediaType) throw new Error(`不支持的图片格式 ${media.contentType || '未知'}`);
      images.push({
        kind: 'image',
        mediaType,
        base64: buffer.toString('base64'),
        name: imageKeys.length > 1 ? `image-${index + 1}` : 'image',
      });
    } catch (error) {
      log(`[attach-image-failed] key=${fileKey} ${error.message}`);
      notes.push(`[图片下载失败：${error.message}]`);
    }
  }

  const mediaRefs = Array.isArray(parsed.mediaRefs) ? parsed.mediaRefs : [];
  for (const ref of mediaRefs) {
    // 语音已经在上面走 STT 变成文字了，这里只管文件和视频
    if (ref.resourceType === 'audio') continue;
    try {
      const media = await client.downloadResource({ messageId: msg.message_id, fileKey: ref.fileKey, type: 'file' });
      const buffer = media?.buffer;
      if (!buffer?.length) throw new Error('下载到 0 字节');
      if (buffer.length > MAX_ATTACHMENT_BYTES) throw new Error(`超过 ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB`);
      files.push({
        kind: 'file',
        base64: buffer.toString('base64'),
        name: ref.fileName || `${ref.resourceType || 'file'}`,
      });
    } catch (error) {
      log(`[attach-file-failed] key=${ref.fileKey} ${error.message}`);
      notes.push(`[文件下载失败 ${ref.fileName || ref.fileKey}：${error.message}]`);
    }
  }

  return { images, files, notes };
}

// 机器人的 open_id：优先读环境变量，没有就向飞书查一次并缓存在进程里。
// 查失败只记一次日志，不重复打接口。
let botOpenIdCache = null;
let botOpenIdFailed = false;
async function resolveBotOpenId(client) {
  const fromEnv = process.env.FEISHU_PLUGIN_BOT_OPEN_ID;
  if (fromEnv) return fromEnv;
  if (botOpenIdCache || botOpenIdFailed) return botOpenIdCache;
  try {
    const info = await client.getBotInfo();
    botOpenIdCache = info?.open_id ?? info?.bot?.open_id ?? null;
    if (!botOpenIdCache) {
      botOpenIdFailed = true;
      return null;
    }
    return botOpenIdCache;
  } catch {
    botOpenIdFailed = true;
    return null;
  }
}

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
  /** 有 ask_user_question 在等回答时，把用户这条文字当成答案吃掉（返回 true）。 */
  onQuestionText = null,
}) {
  // 同一个会话串行处理，避免并发跑同一个 session
  const queues = new Map();
  // 每个对话当前「活动」的进度气泡。插入消息时旧气泡封口、新气泡接管，
  // 保证后续进度不再往旧气泡上堆（跟 Hermes 一样：一条消息一条气泡）。
  const activeProgress = new Map();

  const handleOne = async (event) => {
    // 每次现读，不做启动快照——设置页保存后下一条消息就用新值。
    const rt = typeof getRuntime === 'function' ? getRuntime() ?? {} : {};
    const {
      progressOptions = {},
      sttProvider = 'baidu',
      sttLanguage = 'auto',
      dmPolicy = 'allowlist',
      groupPolicy = 'allowlist',
      allowFrom = '',
    } = rt;

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

    // ── 发送方准入（默认拒绝）──────────────────────────────────────
    //
    // 🔴 这里以前只看「是不是机器人自己发的」+「群里有没有 @ 我」，等于
    //    任何能给机器人发消息的飞书成员都能直接驱动 agent —— 用的是本机的
    //    模型额度、文件权限和 shell 执行权限。
    //
    // 现在按会话类型分别套策略（dmPolicy / groupPolicy），并在 allowlist
    // 策略下比对 allowFrom 白名单。默认 deny，白名单留空 = 谁都不放行。
    // deny 一律打日志并把发送方 ID 打出来（否则用户根本不知道要填哪个 ID）。
    const isGroup = (msg.chat_type ?? '') === 'group';
    const policy = (
      isGroup ? groupPolicy : dmPolicy
    ).toLowerCase();
    if (policy === 'disabled') {
      log(`[deny] ${isGroup ? '群聊' : '单聊'}策略为 disabled，已忽略 chat=${chatId}`);
      return;
    }
    if (policy === 'allowlist') {
      const allowSet = parseAllowFrom(allowFrom);
      if (allowSet !== null) {
        const ids = [
          sender.sender_id?.open_id,
          sender.sender_id?.user_id,
          sender.sender_id?.union_id,
        ].filter(Boolean);
        const ok = ids.some((id) => allowSet.has(id));
        if (!ok) {
          log(
            `[deny] 发送方不在白名单（${isGroup ? 'groupPolicy' : 'dmPolicy'}=allowlist）` +
              ` chat=${chatId} open_id=${sender.sender_id?.open_id || '(无)'}` +
              ` user_id=${sender.sender_id?.user_id || '(无)'}` +
              ` — 要放行就把该 open_id 填进 allowFrom`,
          );
          return;
        }
      }
      // allowSet === null（allowFrom 填了 *）→ 放行所有人，继续往下走
    }

    // 群聊只处理被 @ 的。
    // bot 的 open_id 不能只靠环境变量：没配的话空字符串永远匹配不上，
    // 群聊消息会被静默吞掉（一点反应都没有、也没报错）。所以拿不到就现查一次并缓存。
    const chatType = msg.chat_type ?? '';
    const mentions = msg.mentions ?? [];
    const botOpenId = await resolveBotOpenId(client);
    if (chatType === 'group') {
      // 取不到自己的 id 就没法判断是否被 @：放行并记录，好过静默丢弃。
      if (!botOpenId) {
        log('[mention] 拿不到 bot open_id，群聊消息不做 @ 过滤（直接处理）');
      } else {
        const mentioned = mentions.some((m) => m?.id?.open_id && m.id.open_id === botOpenId);
        if (!mentioned) return;
      }
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

    // 图片 / 文件：飞书只给 file_key，字节得自己拉。
    // 以前这里没有分支，纯图片和纯文件解析出来的 textContent 是空的，
    // 直接被下面的「空消息」判断丢掉 —— 用户发了张图，机器人一声不吭。
    const { images, files, notes: attachNotes } = await collectAttachments({ client, msg, parsed, log });
    if (attachNotes.length) prompt = [prompt, ...attachNotes].filter(Boolean).join('\n');
    const attachments = [...images, ...files];

    if (!prompt && !attachments.length) {
      log(`[skip] 空消息 chat=${chatId} type=${msg.message_type}`);
      return;
    }
    // 纯附件（没有文字）也要给模型一句话，否则它不知道用户想干嘛
    if (!prompt && attachments.length) {
      const parts = [];
      if (images.length) parts.push(`${images.length} 张图片`);
      if (files.length) parts.push(`${files.length} 个文件`);
      prompt = `（用户发来了 ${parts.join('、')}，没有附带文字。先看清楚内容再决定怎么回应。）`;
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

    // 有提问卡片在等回答：这条文字就是答案。
    // 不能让它走 steer —— agent 正卡在 ask_user_question 里等，step 边界永远不会到达，
    // 插进去的消息也就永远没人处理。
    if (typeof onQuestionText === 'function' && onQuestionText(chatId, prompt)) {
      log(`[ask] 文字答案已消费 chat=${chatId} len=${prompt.length}`);
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

    // 把 agent 事件转到某个气泡上（换气泡时复用同一份逻辑）。
    const sinkFor = (bubble) => (event) => {
      if (event.type === 'tool_call') bubble.toolStart(event);
      else if (event.type === 'tool_result') bubble.toolEnd(event);
      else if (event.type === 'thinking') bubble.thinking(event.text);
    };
    // 本轮的旧气泡（如果这轮其实是插进别人正在跑的任务，就是它负责封口）
    const prevProgress = activeProgress.get(chatId) ?? null;

    let text = '';
    let sessionId = prior ?? '';
    let failed = false;
    let reason = '';
    let cancelled = false;   // 本轮被 /new 或 dispose 强行结束 → 静默收尾，不发回复
    // steered=true：这条消息被插进了正在跑的任务，不新起一轮、
    // 也不再单独回最终答案（结果跟原任务一起出来）。
    let steered = false;
    try {
      if (runner) {
        // 进程内 agent：空闲时 followup 起新一轮，运行中 steer 原地插入。
        const sent = await runner.send(chatId, prompt, {
          onEvent: sinkFor(progress),
          attachments,
        });
        if (sent.mode === 'steer') {
          steered = true;
          // 插入生效：旧气泡到此为止，新气泡接管后续进度。
          if (prevProgress && prevProgress !== progress) await prevProgress.finish();
          activeProgress.set(chatId, progress);
          // 整轮由「起这一轮」的消息负责收尾，插入方不等 done；
          // 但万一那一轮先挂了，这里的气泡也要收掉，不能留个半截。
          void Promise.resolve(sent.done)
            .catch(() => undefined)
            .then(() => {
              if (activeProgress.get(chatId) === progress) activeProgress.delete(chatId);
              return progress.finish();
            });
          log('[steer] 已插入正在执行的任务；旧气泡封口，新气泡接管后续进度');
        } else {
          activeProgress.set(chatId, progress);
          const result = await sent.done;
          text = result.text;
          // 被 /new 拆了会话或 agent 被 dispose：这一轮已经没有主语了，
          // 静默收尾，别补发一条「没有产生回答」。
          if (result.cancelled) {
            log('[cancelled] 本轮被外部结束（/new 或会话重置），不发最终回复');
            cancelled = true;
          }
        }
      } else {
      // headless 是子进程模式，没法走附件通道：这里只能明确告诉模型
      // 「有附件但拿不到」，别让它以为用户在说胡话。
      if (attachments.length) {
        log(`[attach-headless] headless 模式不支持附件，已降级（图片 ${images.length} / 文件 ${files.length}）`);
        prompt = `${prompt}\n\n[注意：本条消息包含 ${attachments.length} 个附件，但当前运行模式无法把它们送进模型。]`;
      }
      const run = (sid) =>
        runAgentTask({
          profile,
          prompt,
          sessionId: sid,
          onEvent: sinkFor(progress),
        });

      let result;
      try {
        result = await run(prior);
      } catch (error) {
        // 旧会话可能属于别的工作目录（改过 workspace 就会这样），
        // dsh 会拒绝在另一个 cwd 下续接。这时丢掉旧会话重新开一个。
        //
        // ⚠️ 只认 cwd / workspace 这几种明确由「会话与工作目录不匹配」引起的错误。
        // 原来还匹配 session / not found，范围太宽：模型侧 404、provider 的
        // "model not found"、工具报错里带 session 字样，都会被当成会话坏了，
        // 于是把同一个 prompt 原样重跑一遍 —— 任务可能已经写过文件、调过外部 API，
        // 重跑等于重复执行。
        if (prior && /workspace|cwd|does not match/i.test(error.message)) {
          log(`[session-reuse-failed] ${error.message}；改为新建会话重试`);
          delete sessions[chatId];
          await updateSessions((map) => {
            delete map[chatId];
          });
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

    // 存会话失败不能连累收尾：一旦这里抛出去，下面的摘 Typing、收气泡、
    // 发回复全都会被跳过 —— 用户消息上永远挂着 Typing，气泡永远停在半截，
    // 而且这条消息已被 alreadyHandled 标记，飞书重投也会被丢掉。
    if (sessionId && sessionId !== prior) {
      sessions[chatId] = sessionId;
      try {
        await updateSessions((map) => {
          map[chatId] = sessionId;
        });
      } catch (error) {
        log(`[session-save-failed] ${error.message}（不影响本轮回复）`);
      }
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

    // 进度气泡收尾，最终回答另发一条。
    // 这一轮中途可能被插入过消息：那时进度已经换到新气泡上，
    // 所以要收的是「当前活动气泡」，不能只管自己这一个，
    // 否则新气泡里还没发完的行会永远卡住。
    const active = activeProgress.get(chatId) ?? progress;
    if (activeProgress.get(chatId) === active) activeProgress.delete(chatId);
    // 收尾本身也可能抛（编辑被撤回的消息等）。抛出就会跳过后面的摘表情
    // 和最终回复 —— 用户消息上永远挂着 Typing，也拿不到回答。
    try {
      await active.finish();
    } catch (error) {
      log(`[progress-finish-failed] ${error.message}`);
    }

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
    // 生图补发失败不能连累最终回复
    try {
      await sendGeneratedImages({ client, chatId, replyTo: msg.message_id, text, log });
    } catch (error) {
      log(`[send-images-failed] ${error.message}`);
    }

    if (cancelled) return;
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
    // 链尾自己清理：不删的话这条 chat 的条目永久留在 Map 里，
    // 而且一旦某次 task 卡住，后续所有消息都排在它后面永不执行。
    void next.finally(() => {
      if (queues.get(chatId) === next) queues.delete(chatId);
    });
    // 不 return / 不 await：立即完成，让飞书马上收到 ack。
  };
}