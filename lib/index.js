// dsh-hermes-feishu — DeepSeek Harness 的飞书插件。
//
// 功能对标 Hermes Agent 的飞书平台适配器
// (hermes-agent/plugins/platforms/feishu/adapter.py)，把它的输出渲染能力
// 完整搬进 dsh：
//   - Markdown -> 飞书交互卡片(schema 2.0)
//   - Markdown 表格 -> 飞书原生 table 组件（dsh-lark-bot 没有这个能力）
//   - 多级标题降级粗体、代码块拆行、纯文本降级、消息类型自动路由
//   - post 富文本载荷、入站消息归一化（post/text/interactive/merge_forward/…）
//   - 文本 / 卡片 / 图片 / 文件 / 语音 / 视频发送，回复、编辑、撤回、下载
//
// 依赖只有两个：@deepseek-ai/schemastery（配置 schema）和
// @larksuiteoapi/node-sdk（飞书协议）。渲染、路由、卡片构建、媒体处理都是自己写的。
// 注意：bundle 里 import 未在 package.json 声明的包，cordis 会静默跳过整个插件。
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { appendFileSync, readFileSync, readdirSync, renameSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Config, buildModelChain, unwrapDeep } from './config.js';
import { installModelFallback } from './fallback.js';

import {
  buildInteractiveCard,
  buildInteractivePayload,
  buildMarkdownPostPayload,
  buildOutboundPayload,
  stripMarkdownToPlainText,
} from './render.js';
import {
  FeishuClient,
  clientFromEnv,
  getAudioDurationMs,
  resolveOutboundFileRouting,
} from './feishu.js';
import { normalizeFeishuMessage } from './inbound.js';
import { startInbound } from './inbound-ws.js';
import { createMessageHandler } from './dispatch.js';
import { createInProcessRunner } from './agent-session.js';
import { createFeishuApproval } from './approval.js';
import { createFeishuQuestions } from './questions.js';
import { transcribeAudio, sttConfigured } from './stt.js';
import { toOpusVoice, toSttWav, durationMsOf } from './transcode.js';

const name = 'dsh-hermes-feishu';
const inject = ['tools', 'agents', 'settings', 'attachments'];

const DEFAULT_RECEIVE_ID_TYPE = 'chat_id';

/** 常见图片扩展名 -> MIME。 */
const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

function dshHome() {
  const home = process.env.DSH_HOME;
  return typeof home === 'string' && home.length > 0 ? home : join(homedir(), '.dsh');
}

/** 把工具输出的文本结果统一成 dsh 认的 content 片段。 */
function textResult(text) {
  return [{ type: 'text', text }];
}

/** 插件日志：dsh 不把插件 logger 落进 dsh-web.log，自己写一份文件（超 2MB 自动轮转）。 */
const LOG_MAX_BYTES = 2 * 1024 * 1024;

function pluginLog(msg) {
  const file = join(dshHome(), 'feishu-plugin.log');
  try {
    // 简单按大小轮转：超过 2MB 就把当前文件挪成 .1（覆盖上一次的 .1），再开新文件。
    try {
      if (statSync(file).size > LOG_MAX_BYTES) {
        renameSync(file, `${file}.1`);
      }
    } catch {
      /* 文件不存在或轮转失败都不影响写日志 */
    }
    appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
  } catch {
    /* 日志写不出去不能影响主流程 */
  }
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`dsh-hermes-feishu：${field} 不能为空`);
  }
  return value;
}

/** 从配置 + 参数解析出客户端与默认收件人。 */
function makeContext(config, args = {}) {
  const client = clientFromEnv(process.env, {
    appId: config.appId || undefined,
    appSecret: config.appSecret || undefined,
    domain: config.domain || undefined,
    baseUrl: config.baseUrl || undefined,
  });
  const receiveId =
    args.receiveId ||
    config.defaultChatId ||
    process.env.FEISHU_PLUGIN_CHAT_ID ||
    process.env.DSH_FEISHU_CHAT_ID ||
    process.env.FEISHU_HOME_CHANNEL;
  const receiveIdType = args.receiveIdType || config.defaultReceiveIdType || DEFAULT_RECEIVE_ID_TYPE;
  return { client, receiveId, receiveIdType };
}

/**
 * 发送一条消息的核心路径：文本走 text，Markdown/表格走交互卡片。
 */
async function sendAuto({ client, receiveId, receiveIdType }, text, options = {}) {
  const routed = buildOutboundPayload(text, options);
  const data = await client.sendMessage({
    receiveId,
    receiveIdType,
    msgType: routed.msgType,
    content: routed.content,
    uuid: options.uuid,
  });
  return { ...routed, messageId: data.message_id, chatId: data.chat_id };
}

/** 读本地文件为 Buffer，并给出文件名与大小。 */
async function readLocalFile(filePath) {
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error(`不是文件：${filePath}`);
  return {
    buffer: await readFile(filePath),
    fileName: basename(filePath),
    size: info.size,
  };
}

export function apply(ctx, rawConfig = {}) {
  // config 里带 volatile 标记的字段被 cordis 包成了 { get(): T } 引用对象，
  // 必须解包后才能当普通值用。rawConfig 保留原样，供实时读取。
  // 🔴 配置必须实时读：dsh 的 volatile 字段在设置页保存后【不会重挂载插件】，
  //    所以不能 apply 时解包一次就快照住——那样改完设置必须重启 dsh web 才生效。
  //    用 Proxy 让每次 config.xxx 都重新解包 rawConfig，保存即刻生效。
  const config = new Proxy(
    {},
    {
      // 只解包被访问的那一个字段，避免每次读取都重建整份配置对象
      get: (_t, key) => unwrapDeep(rawConfig?.[key]),
      has: (_t, key) => key in unwrapDeep(rawConfig),
      ownKeys: () => Reflect.ownKeys(unwrapDeep(rawConfig)),
      getOwnPropertyDescriptor: (_t, key) => ({
        configurable: true,
        enumerable: true,
        value: unwrapDeep(rawConfig)[key],
      }),
    },
  );

  // ── 语音转文字代理 ─────────────────────────────────────────────
  // 优先走 dsh 的 speechToText 服务：这样 provider（百度/SenseVoice）由设置页决定，
  // 换了识别插件也能自动生效。服务拿不到（老 profile 没装）才退回本插件直连百度。
  const transcribe = async (buffer, extension, options = {}) => {
    const service = ctx.get('speechToText');
    if (service && typeof service.resolve === 'function' && typeof service.transcribe === 'function') {
      const audio = await toSttWav(buffer, extension);
      const spec = service.resolve({
        audio: new Uint8Array(audio),
        ...(options.providerId ? { providerId: options.providerId } : {}),
        ...(options.language ? { language: options.language } : {}),
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('speech timeout')), 60000);
      try {
        const transcript = await service.transcribe(spec, controller.signal);
        return transcript?.text ?? '';
      } finally {
        clearTimeout(timer);
      }
    }
    return transcribeAudio(buffer, extension, { language: options.language });
  };

  // ── 0. 配置页 + 模型故障转移（先于其它注册，失败也不影响工具面）──────────
  // dsh 的 settings 服务会按 Config schema 自动生成设置页表单，不必自己写前端。
  ctx.effect(() => {
    const settings = ctx.settings;
    if (typeof settings?.configure !== 'function') {
      pluginLog('[config-page] settings 服务不可用，配置页不会挂载');
      return;
    }
    try {
      const dispose = settings.configure({ auto: true }, ctx.fiber);
      pluginLog('[config-page] 配置页已注册（Web 设置页 -> 插件配置）');
      // 自检：describe() 是设置页真正的数据源，它读 entry.fiber.runtime.Config。
      // 拿不到就说明 schema 没被 Loader 认到，页面不会出现。
      setTimeout(() => {
        try {
          const rows = ctx.settings.describe?.() ?? [];
          const mine = rows.find((r) => r.ns === 'hermes-feishu');
          pluginLog(
            `[config-page] 设置页数据源 ${rows.length} 条 | 本插件: `
              + (mine ? `✅ 已挂载 (auto=${mine.autoGenerate}, ns=${mine.ns})` : '❌ 缺失'),
          );
          // 顺便确认 volatile 解包后的配置真的读到了
          pluginLog(
            `[config-page] 解包后配置: provider=${config.agentProvider} model=${config.agentModel}`
              + ` fallback="${config.fallbackModels}" thinking=${config.thinkingEnabled}`
              + ` previewChars=${config.toolPreviewChars} inbound=${config.inbound}`,
          );
        } catch (error) {
          pluginLog(`[config-page] describe 自检失败: ${error.message}`);
        }
      }, 6000);
      return () => dispose?.();
    } catch (error) {
      pluginLog(`[config-page] 注册失败 ${error.message}`);
      return;
    }
  });

  // 媒体配置路由：把另外两个插件的配置也接到自己的设置页里。
  //   image-gen  -> dsh settings 命名空间 "image-gen"（provider + 对应模型字段）
  //   modlens    -> ~/.modlens/config.json（视觉识别 provider/model，由它自己的 CLI 管理）
  // 媒体配置：用 dsh 已配置的模型库（设置里的 llm-pi-ai 提供方）来驱动。
  //   图片生成 -> dsh-image-gen 的 settings 命名空间，统一按 openai-compat 路由写入
  //   媒体识别 -> ~/.modlens/config.json
  // 不硬编码任何厂商清单，provider / 模型全部来自模型库。
  ctx.inject(['webServer', 'settings', 'llm', 'web'], (scope) => {


    /** image-gen 各 provider 对应的模型/地址字段名（取自插件源码的 Config）。 */
    const IMAGE_MODEL_FIELD = {
      'openai-compat': ['openaiCompatModel', 'openaiCompatBaseURL'],
      openai: ['openaiModel', 'openaiBaseURL'],
      google: ['googleModel', 'googleEndpoint'],
      dashscope: ['dashscopeModel', 'dashscopeEndpoint'],
      seedream: ['seedreamModel', 'seedreamBaseURL'],
      xai: ['xaiModel', 'xaiBaseURL'],
      zhipu: ['zhipuModel', 'zhipuBaseURL'],
    };

    const modlensPath = () => join(dshHome(), '..', '.modlens', 'config.json');

    /** 读 dsh 已配置的模型库：llm-pi-ai 的 providers。 */
    /** 已配置的 provider 目录：与「Agent 与模型」同源，都来自 ctx.llm.listProviders()。 */
    /** 已配置的 provider 目录：与「Agent 与模型」同源（ctx.llm.listProviders）。
     *  baseURL / keyEnv 从 llm-pi-ai 的配置里补，因为只有它声明了这两项。 */
    const readLibrary = async () => {
      try {
        const declared = {};
        try {
          const desc = (scope.settings.describe() ?? []).find((d) => d.ns === 'llm-pi-ai');
          for (const [id, cfg] of Object.entries(desc?.value?.providers ?? {})) {
            declared[id] = {
              name: typeof cfg?.displayName === 'string' ? cfg.displayName : '',
              baseUrl: typeof cfg?.baseURL === 'string' ? cfg.baseURL : '',
              keyEnv: typeof cfg?.apiKeyEnv === 'string' ? cfg.apiKeyEnv : '',
            };
          }
        } catch {
          /* 读不到就只靠 provider 注册信息 */
        }

        const out = [];
        for (const info of scope.llm.listProviders() ?? []) {
          let models = [];
          try {
            models = (await scope.llm.listModels(info.id)) ?? [];
          } catch {
            /* 拉不到模型的 provider 视为没配置 */
          }
          if (models.length === 0) continue;
          const meta = declared[info.id] ?? {};
          const name = meta.name || info.name || info.id;
          if (/modlens/i.test(name)) continue;
          out.push({
            id: info.id,
            name,
            models: models.map((m) => m.id),
            baseUrl: meta.baseUrl ?? '',
            keyEnv: meta.keyEnv ?? '',
          });
        }
        return out;
      } catch {
        return [];
      }
    };

    const keyOf = (libEntry) =>
      libEntry && libEntry.keyEnv ? String(process.env[libEntry.keyEnv] ?? '') : '';

    const findLib = (library, matchUrl) => {
      if (!matchUrl) return undefined;
      const norm = (u) => u.replace(/\/+$/, '').toLowerCase();
      return library.find((p) => norm(p.baseUrl) === norm(matchUrl));
    };

    /** 追踪某 provider 的 /v1/models，60 秒缓存。 */
    const modelCache = new Map();
    const fetchLiveModels = async (baseUrl, apiKey) => {
      if (!baseUrl || !apiKey) return [];
      const hit = modelCache.get(baseUrl);
      if (hit && Date.now() - hit.at < 60000) return hit.ids;
      let ids = [];
      try {
        const r = await fetch(baseUrl.replace(/\/+$/, '') + '/models', {
          headers: { authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(12000),
        });
        if (r.ok) {
          const d = await r.json();
          ids = (d?.data ?? d?.models ?? [])
            .map((m) => m?.id ?? m?.name)
            .filter((x) => typeof x === 'string' && x.length > 0);
        }
      } catch {
        /* 网络不通就只给模型库里的静态清单 */
      }
      modelCache.set(baseUrl, { at: Date.now(), ids });
      return ids;
    };

    /** 某个模型库 provider 的候选模型（静态清单 ∪ 实时 /models），不做任何筛选。 */
    /** 某 provider 的候选模型：静态清单 ∪ 实时 /models（没有 baseURL 时就只有静态清单）。 */
    const optionsOf = async (libEntry) => {
      if (!libEntry) return [];
      const live = await fetchLiveModels(libEntry.baseUrl, keyOf(libEntry));
      return [...new Set([...(libEntry.models ?? []), ...live])];
    };

    const readModlens = () => {
      try {
        const parsed = JSON.parse(readFileSync(modlensPath(), 'utf8'));
        const provider = typeof parsed?.provider === 'string' ? parsed.provider : '';
        const entry = provider ? parsed?.providers?.[provider] ?? {} : {};
        return {
          ok: true,
          path: modlensPath(),
          provider,
          providers: Object.keys(parsed?.providers ?? {}),
          model: typeof entry.model === 'string' ? entry.model : '',
          baseUrl: typeof entry.baseUrl === 'string' ? entry.baseUrl : '',
          hasKey: typeof entry.apiKey === 'string' && entry.apiKey.length > 0,
          apiKey: typeof entry.apiKey === 'string' ? entry.apiKey : '',
        };
      } catch (error) {
        return {
          ok: false,
          path: modlensPath(),
          error: error.message,
          provider: '',
          providers: [],
          model: '',
          baseUrl: '',
          hasKey: false,
          apiKey: '',
        };
      }
    };

    const readImageGen = () => {
      try {
        const desc = (scope.settings.describe() ?? []).find((d) => d.ns === 'image-gen');
        if (!desc) return { ok: false, error: '没有 image-gen 命名空间' };
        const value = desc.value ?? {};
        const provider = typeof value.provider === 'string' ? value.provider : '';
        const [modelField, baseField] = IMAGE_MODEL_FIELD[provider] ?? [null, null];
        return {
          ok: true,
          ns: 'image-gen',
          provider,
          model: modelField ? String(value[modelField] ?? '') : '',
          baseUrl: baseField ? String(value[baseField] ?? '') : '',
          revision: desc.revision,
          value,
        };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    };

    /** 写图片生成：模型库里选的 provider 统一落到 openai-compat 路由。 */
    const writeImageGen = async ({ libEntry, model }) => {
      if (!libEntry) throw new Error('没有指定模型库 provider');
      if (!libEntry.baseUrl) throw new Error(`${libEntry.name} 没有声明 baseURL，无法用于图片生成`);
      if (!model) throw new Error('没有指定模型');
      await scope.settings.update('image-gen', {
        provider: 'openai-compat',
        openaiCompatBaseURL: libEntry.baseUrl,
        openaiCompatModel: model,
      });
      pluginLog(`[media-config] 图片生成 -> ${libEntry.id} (${libEntry.baseUrl}) / ${model}`);
    };

    /** 写媒体识别：modlens 的 provider 固定 openai，baseUrl / key 跟模型库走。 */
    const writeModlens = async ({ libEntry, model }) => {
      if (!libEntry) throw new Error('没有指定模型库 provider');
      if (!model) throw new Error('没有指定模型');
      const key = keyOf(libEntry);
      if (!key) throw new Error(`${libEntry.name} 没有可用的 API Key（${libEntry.keyEnv || '未配置 apiKeyEnv'}）`);
      let parsed = {};
      try {
        parsed = JSON.parse(readFileSync(modlensPath(), 'utf8'));
      } catch {
        parsed = {};
      }
      parsed.provider = 'openai';
      parsed.providers = parsed.providers ?? {};
      parsed.providers.openai = {
        ...(parsed.providers.openai ?? {}),
        baseUrl: libEntry.baseUrl,
        apiKey: key,
        model,
        structuredOutput: true,
      };
      mkdirSync(dirname(modlensPath()), { recursive: true });
      writeFileSync(modlensPath(), JSON.stringify(parsed, null, 2) + String.fromCharCode(10), {
        encoding: 'utf8',
        mode: 0o600,
      });
      pluginLog(`[media-config] 媒体识别 -> ${libEntry.id} (${libEntry.baseUrl}) / ${model}`);
    };

    /** 插件依赖体检：装没装、能不能用。 */
    const checkDeps = () => {
      const modulesDir = join(dshHome(), 'profiles', 'web', 'node_modules');
      const exists = (rel) => {
        try {
          statSync(join(modulesDir, rel));
          return true;
        } catch {
          return false;
        }
      };
      const credsOk = Boolean(process.env.BAIDU_VOICE_API_KEY && process.env.BAIDU_VOICE_SECRET_KEY);
      let imageGenVersion = '';
      try {
        imageGenVersion = JSON.parse(readFileSync(join(modulesDir, 'dsh-image-gen', 'package.json'), 'utf8')).version ?? '';
      } catch {
        /* 没装 */
      }
      let modlensVersion = '';
      try {
        modlensVersion = JSON.parse(readFileSync(join(modulesDir, '@liustack', 'modlens', 'package.json'), 'utf8')).version ?? '';
      } catch {
        /* 没装 */
      }
      return {
        'dsh-image-gen': {
          installed: exists('dsh-image-gen'),
          version: imageGenVersion,
          install: 'cd %USERPROFILE%\\.dsh\\profiles\\web && pnpm add dsh-image-gen，然后在 package.json 的 dsh.profile.bundles 里加 "dsh-image-gen"',
          purpose: '图片生成（文生图 / 图生图）',
        },
        '@liustack/modlens': {
          installed: exists(join('@liustack', 'modlens')),

          version: modlensVersion,
          install: 'cd %USERPROFILE%\\.dsh\\profiles\\web && pnpm add @liustack/modlens，然后在 dsh.profile.bundles 里加 "@liustack/modlens"',
          purpose: '媒体识别（给纯文本模型装视觉能力）',
        },
        'dsh-baidu-stt': {
          installed: exists('dsh-baidu-stt'),
          credentials: credsOk,
          install: 'cd %USERPROFILE%\\.dsh\\profiles\\web && pnpm add dsh-baidu-stt，然后在 dsh.profile.bundles 里加 "dsh-baidu-stt"',
          purpose: '语音转文字（飞书发语音，转成文字给模型）',
        },
        'dsh-baidu-tts': {
          installed: exists('dsh-baidu-tts'),
          credentials: credsOk,
          install: 'cd %USERPROFILE%\\.dsh\\profiles\\web && pnpm add dsh-baidu-tts，然后在 dsh.profile.bundles 里加 "dsh-baidu-tts"',
          purpose: '文字转语音（回复用语音气泡发出来）',
        },
      };
    };

    /** 汇总一份给前端的完整快照。 */
    const snapshot = async () => {
      // 语音识别 provider：来自 dsh 的 speechToText 服务（没装就是空列表，界面会提示）
      const voiceProviders = [];
      let voiceState = { providerId: config.sttProvider || 'baidu', language: config.sttLanguage || 'auto' };
      try {
        const speech = ctx.get('speechToText');
        if (speech && typeof speech.listProviders === 'function') {
          for (const p of speech.listProviders() ?? []) {
            voiceProviders.push({
              id: p.id,
              name: p.name ?? p.id,
              location: p.location ?? '',
              languages: Array.isArray(p.languages) ? p.languages : [],
            });
          }
          const snap = typeof speech.snapshot === 'function' ? speech.snapshot() : null;
          if (snap?.selection) {
            voiceState = {
              providerId: config.sttProvider || snap.selection.providerId || 'baidu',
              language: config.sttLanguage || snap.selection.language || 'auto',
            };
          }
        }
      } catch {
        /* 服务不可用就留空 */
      }

      // TTS 在 dsh 里没有统一服务层（只有语音识别有 speechToText），合成能力全是
      // 各自独立的插件工具。所以这里不猜厂商：直接列已注册的 *tts* 工具，
      // 并把每个工具的 inputSchema 一起带给前端——界面按 schema 渲染参数，
      // 换一个 TTS 插件，表单跟着它的声明走，不在插件里写死任何厂商字段。
      const ttsTools = [];
      try {
        const tools = ctx.get('tools');
        const list = typeof tools?.schemas === 'function' ? tools.schemas() ?? [] : [];
        for (const schema of list) {
          const toolName = schema?.name;
          if (typeof toolName !== 'string' || !/(^|_)tts($|_)/i.test(toolName)) continue;
          const params = schema?.parameters ?? {};
          ttsTools.push({
            id: toolName,
            name: toolName,
            description: schema?.description ?? '',
            properties: params.properties ?? {},
            required: Array.isArray(params.required) ? params.required : [],
          });
        }
        ttsTools.sort((a, b) => a.id.localeCompare(b.id));
      } catch {
        /* tools 服务拿不到就是没有 TTS 能力 */
      }
      const ttsSelected = ttsTools.find((t) => t.id === config.ttsTool) ?? ttsTools[0] ?? null;
      let ttsArgsValue = {};
      try {
        const parsed = JSON.parse(config.ttsArgs || '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ttsArgsValue = parsed;
      } catch {
        /* 配置里存了坏 JSON 就当空 */
      }
      const ttsValues = {
        provider: ttsSelected?.id ?? '',
        providers: ttsTools,
        properties: ttsSelected?.properties ?? {},
        required: ttsSelected?.required ?? [],
        args: ttsArgsValue,
      };

      // 联网搜索 / 抓取 provider（全部来自 ctx.web 的实时注册表）
      let webSection = null;
      try {
        const runtime = scope.web;
        const spin = runtime?.searchProviders;
        const fpin = runtime?.fetchProviders;
        const cfgDesc = (scope.settings.describe() ?? []).find((d) => d.ns === 'web');
        const mapOf = (m) => {
          if (!(m instanceof Map)) return [];
          return [...m.entries()].map(([id, provider]) => ({
            id,
            available: typeof provider?.available === 'function' ? provider.available() === true : true,
          }));
        };
        webSection = {
          searchProvider: cfgDesc?.value?.searchProvider ?? '',
          fetchProvider: cfgDesc?.value?.fetchProvider ?? '',
          searchProviderOptions: mapOf(spin),
          fetchProviderOptions: mapOf(fpin),
        };
      } catch {
        webSection = null;
      }


      const library = await readLibrary();
      const imageGen = readImageGen();
      const vision = readModlens();

      const imageLib = findLib(library, imageGen.ok ? imageGen.baseUrl : '');
      const visionLib = findLib(library, vision.ok ? vision.baseUrl : '');

      const imageOptions = imageLib ? await optionsOf(imageLib) : [];
      const visionOptions = visionLib ? await optionsOf(visionLib) : [];

      const imageModel = imageGen.ok ? imageGen.model : '';
      const visionModel = vision.ok ? vision.model : '';

      return {
        web: webSection,
        deps: checkDeps(),
        voice: {
          stt: {
            provider: voiceState.providerId,
            language: voiceState.language,
            providers: voiceProviders,
          },
          tts: {
            provider: ttsValues.provider,
            providers: ttsValues.providers,
            properties: ttsValues.properties,
            required: ttsValues.required,
            args: ttsValues.args,
          },
        },
        library: library.map((p) => ({ id: p.id, name: p.name, baseUrl: p.baseUrl, modelCount: p.models.length })),
        imageGen: {
          ok: imageGen.ok,
          ...(imageGen.ok ? {} : { error: imageGen.error }),
          libId: imageLib?.id ?? '',
          model: imageModel,
          modelOptions: [...new Set([imageModel, ...imageOptions].filter(Boolean))],
        },
        vision: {
          ok: vision.ok,
          ...(vision.ok ? {} : { error: vision.error }),
          libId: visionLib?.id ?? '',
          model: visionModel,
          modelOptions: [...new Set([visionModel, ...visionOptions].filter(Boolean))],
        },
      };
    };

    scope.effect(
      () =>
        scope.webServer.register({
          kind: 'exact',
          path: '/plugins/dsh-hermes-feishu/media-models',
          handler: async (req, res) => {
            const send = (status, payload) => {
              res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
              res.end(JSON.stringify(payload));
            };
            if (req.method !== 'GET') {
              send(405, { error: 'method not allowed' });
              return;
            }
            try {
              const url = new URL(req.url ?? '/', 'http://127.0.0.1');
              const target = url.searchParams.get('target');
              const libId = url.searchParams.get('provider') ?? '';
              const libEntry = (await readLibrary()).find((p) => p.id === libId);
              if (!libEntry) {
                send(200, { options: [] });
                return;
              }
              send(200, { options: await optionsOf(libEntry) });
            } catch (error) {
              send(500, { error: error.message });
            }
          },
        }),
      'dsh-hermes-feishu: media models route',
    );



    // 联网搜索 provider 选择（web 命名空间的 searchProvider/fetchProvider 是 volatile，可写）
    scope.effect(
      () =>
        scope.webServer.register({
          kind: 'exact',
          path: '/plugins/dsh-hermes-feishu/web-config',
          handler: async (req, res) => {
            const send = (status, payload) => {
              res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
              res.end(JSON.stringify(payload));
            };
            if (req.method !== 'POST') {
              send(405, { error: 'method not allowed' });
              return;
            }
            try {
              const chunks = [];
              for await (const chunk of req) chunks.push(chunk);
              const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
              const patch = {};
              if (typeof body.searchProvider === 'string' && body.searchProvider) patch.searchProvider = body.searchProvider;
              if (typeof body.fetchProvider === 'string' && body.fetchProvider) patch.fetchProvider = body.fetchProvider;
              if (Object.keys(patch).length === 0) throw new Error('没有要保存的字段');
              await scope.settings.update('web', patch);
              pluginLog(`[web-config] 已更新 ${JSON.stringify(patch)}`);
              send(200, { ok: true });
            } catch (error) {
              send(500, { error: error.message });
            }
          },
        }),
      'dsh-hermes-feishu: web config route',
    );


    scope.effect(
      () =>
        scope.webServer.register({
          kind: 'exact',
          path: '/plugins/dsh-hermes-feishu/media-config',
          handler: async (req, res) => {
            const send = (status, payload) => {
              res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
              res.end(JSON.stringify(payload));
            };
            try {
              if (req.method === 'GET') {
                send(200, await snapshot());
                return;
              }
              if (req.method !== 'POST') {
                send(405, { error: 'method not allowed' });
                return;
              }
              const chunks = [];
              for await (const chunk of req) chunks.push(chunk);
              const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
              const libEntry = (await readLibrary()).find((p) => p.id === body.libId);
              if (body.target === 'imageGen') await writeImageGen({ libEntry, model: body.model });
              else if (body.target === 'vision') await writeModlens({ libEntry, model: body.model });
              else throw new Error('target 必须是 imageGen 或 vision');
              send(200, { ok: true, ...(await snapshot()) });
            } catch (error) {
              send(500, { error: error.message });
            }
          },
        }),
      'dsh-hermes-feishu: media config route',
    );
  });

  // 模型目录路由：设置页要「从模型库选」，前端不能直接访问 ctx.llm，
  // 所以由 host 半把可用 provider/model 列表通过 /plugins 暴露给它。
  ctx.inject(['webServer', 'llm'], (scope) => {
    scope.effect(
      () =>
        scope.webServer.register({
          kind: 'exact',
          path: '/plugins/dsh-hermes-feishu/models',
          handler: async (req, res) => {
            if (req.method !== 'GET') {
              res.writeHead(405, { 'content-type': 'application/json' });
              res.end('{"error":"method not allowed"}');
              return;
            }
            const providers = [];
            // 模型库里的 displayName 更友好，优先用（读不到就退回 provider 自己的名字）
            const displayNames = {};
            try {
              const settings = ctx.get('settings');
              const desc = (settings?.describe?.() ?? []).find((d) => d.ns === 'llm-pi-ai');
              for (const [id, cfg] of Object.entries(desc?.value?.providers ?? {})) {
                if (typeof cfg?.displayName === 'string' && cfg.displayName) displayNames[id] = cfg.displayName;
              }
            } catch {
              /* 读不到就用默认名 */
            }
            try {
              for (const info of scope.llm.listProviders() ?? []) {
                let models = [];
                try {
                  models = (await scope.llm.listModels(info.id)) ?? [];
                } catch {
                  /* 单个 provider 拉不到就跳过 */
                }
                // 没有模型的 provider 就是没配置过的，不往设置页里放
                if (models.length === 0) continue;
                const displayName = displayNames[info.id] ?? info.name ?? info.id;
                // modlens 为视觉识别自动派生出来的镜像 provider，不该出现在主模型下拉里
                if (/modlens/i.test(displayName)) continue;
                providers.push({
                  provider: info.id,
                  name: displayName,
                  models: models.map((m) => ({
                    id: m.id,
                    name: m.name ?? m.id,
                    ...(Array.isArray(m.inputModalities) ? { modalities: m.inputModalities } : {}),
                  })),
                });
              }
            } catch (error) {
              res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ error: error.message }));
              return;
            }
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            });
            res.end(JSON.stringify({ providers }));
          },
        }),
      'dsh-hermes-feishu: model catalog route',
    );
  });

  // 前端设置卡片的加载自检：dsh 靠 clientModules 扫描 dsh.client 声明。
  ctx.effect(() => {
    const timer = setTimeout(() => {
      try {
        const cm = ctx.get('clientModules');
        if (!cm) {
          pluginLog('[client-page] clientModules 服务不可用');
          return;
        }
        const graph = typeof cm.graph === 'function' ? cm.graph() : null;
        const ids = (graph?.entries ?? []).map((e) => e.id);
        pluginLog(`[client-page] boot 图 ${ids.length} 条 | 含本包: ${ids.includes('dsh-hermes-feishu')}`);
        pluginLog(`[client-page] clientPath = ${cm.clientPath?.('dsh-hermes-feishu') ?? '(无)'}`);

      } catch (error) {
        pluginLog(`[client-page] 探测失败 ${error.message}`);
      }
    }, 9000);
    return () => clearTimeout(timer);
  });

  // 备用模型链：主模型请求失败时按 fallbackModels 顺序切，切完仍失败才报错。
  ctx.effect(() => {
    const chain = buildModelChain(rawConfig);
    if (chain.length <= 1) {
      pluginLog('[fallback] 未配置备用模型，故障转移关闭');
      return;
    }
    const fallback = installModelFallback(ctx, {
      // 传 rawConfig：buildModelChain 每次自己解包，配置改了立刻生效
      getChain: () => buildModelChain(rawConfig),
      log: (msg) => pluginLog(msg),
    });
    pluginLog(`[fallback] 已启用 ${chain.map((c) => c.provider + '/' + c.model).join(' -> ')}`);
    return () => fallback.dispose();
  });

  const botName =
    config.botName || process.env.FEISHU_PLUGIN_BOT_NAME || process.env.DSH_FEISHU_BOT_NAME || 'AI 助手';
  // 卡片 footer 里的模型/供应商：Config schema 里没有 modelTag/providerTag，
  // 读配置只会拿到 undefined。真正的来源是运行期设置，没有就不显示 footer。
  const cardOptions = { botName, model: '', provider: '' };

  // ── 1. 主发送工具：自动判定 text / interactive ──────────────────────────
  ctx.effect(() =>
    ctx.tools.register({
      name: 'feishu_send_message',
      description:
        '给飞书发一条消息。自动判定用纯文本还是交互卡片：含 Markdown 标题/列表/代码/表格时发卡片，命令行输出、纯 ASCII 短句、emoji 开头的短消息发纯文本。Markdown 表格会渲染成飞书原生表格组件。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '消息内容，可含 Markdown（表格、代码块、标题均支持）' },
          receiveId: { type: 'string', description: '接收方：群 chat_id（oc_ 开头）或用户 open_id（ou_ 开头）。留空则用默认会话' },
          receiveIdType: {
            type: 'string',
            description: '接收方 ID 类型：chat_id / open_id / user_id / union_id / email，默认 chat_id',
          },
          forceCard: { type: 'boolean', description: '强制发交互卡片（默认按内容自动判定）' },
          title: { type: 'string', description: '卡片标题，默认用机器人名' },
        },
        required: ['text'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            messageId: { type: 'string' },
            msgType: { type: 'string' },
            reason: { type: 'string' },
            chatId: { type: 'string' },
          },
          required: ['messageId', 'msgType'],
        },
        render: (_args, value) =>
          textResult(`已发送（${value.msgType}，${value.reason}）message_id=${value.messageId}`),
      },
      async execute(args) {
        const text = requireString(args?.text, 'text');
        const c = makeContext(config, args);
        if (!c.receiveId) throw new Error('没有默认会话：请在参数里给 receiveId，或在插件配置里设 defaultChatId');
        const result = await sendAuto(c, text, {
          ...cardOptions,
          botName: args?.title || botName,
          preferCard: Boolean(args?.forceCard),
        });
        return {
          messageId: result.messageId ?? '',
          msgType: result.msgType,
          reason: result.reason,
          chatId: result.chatId ?? '',
        };
      },
    }),
  );

  // ── 2. 强制卡片（含表格渲染） ────────────────────────────────────────────
  ctx.effect(() =>
    ctx.tools.register({
      name: 'feishu_send_card',
      description:
        '把 Markdown 强制渲染成飞书交互卡片发送。表格会转成飞书原生 table 组件（不是纯文本），多级标题会降级为粗体。适合发报告、对比表、结构化结果。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Markdown 内容' },
          title: { type: 'string', description: '卡片标题' },
          template: { type: 'string', description: '卡片主题色：blue/green/red/orange/purple/grey，默认 blue' },
          receiveId: { type: 'string', description: '接收方 ID' },
          receiveIdType: { type: 'string', description: 'ID 类型，默认 chat_id' },
        },
        required: ['text'],
      },
      output: {
        schema: {
          type: 'object',
          properties: { messageId: { type: 'string' }, chatId: { type: 'string' } },
          required: ['messageId'],
        },
        render: (_args, value) => textResult(`卡片已发送，message_id=${value.messageId}`),
      },
      async execute(args) {
        const text = requireString(args?.text, 'text');
        const c = makeContext(config, args);
        if (!c.receiveId) throw new Error('没有默认会话：请给 receiveId');
        const card = buildInteractiveCard(text, {
          ...cardOptions,
          botName: args?.title || botName,
        });
        if (args?.template) card.header.template = String(args.template);
        const data = await c.client.sendMessage({
          receiveId: c.receiveId,
          receiveIdType: c.receiveIdType,
          msgType: 'interactive',
          content: JSON.stringify(card),
        });
        return { messageId: data.message_id ?? '', chatId: data.chat_id ?? '' };
      },
    }),
  );

  // ── 3. 发文件（自动路由：opus->语音、mp4->视频、pdf/doc->文件） ──────────
  ctx.effect(() =>
    ctx.tools.register({
      name: 'feishu_send_file',
      description:
        '上传并发送本地文件到飞书。按扩展名自动路由：.ogg/.opus 走语音消息（带时长），.mp4 走视频，.pdf/.docx/.xlsx/.pptx 走对应文件类型，其余（含 .mov/.avi/.m4v，飞书只认 mp4 容器）走普通文件。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '本地文件绝对路径' },
          caption: { type: 'string', description: '随文件一起发的文字说明（可选）' },
          receiveId: { type: 'string', description: '接收方 ID' },
          receiveIdType: { type: 'string', description: 'ID 类型，默认 chat_id' },
        },
        required: ['path'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            messageId: { type: 'string' },
            messageType: { type: 'string' },
            bytes: { type: 'number' },
            fileName: { type: 'string' },
          },
          required: ['messageId', 'messageType'],
        },
        render: (_args, value) =>
          textResult(`已发送文件 ${value.fileName}（${value.messageType}，${value.bytes} 字节）`),
      },
      async execute(args) {
        const path = requireString(args?.path, 'path');
        const c = makeContext(config, args);
        if (!c.receiveId) throw new Error('没有默认会话：请给 receiveId');

        const file = await readLocalFile(path);
        const routing = resolveOutboundFileRouting(file.fileName);
        const durationMs = routing.fileType === 'opus' ? getAudioDurationMs(file.buffer) : 0;
        const fileKey = await c.client.uploadFile({
          buffer: file.buffer,
          fileName: file.fileName,
          fileType: routing.fileType,
          durationMs,
        });

        const content = JSON.stringify({ file_key: fileKey });
        const data = await c.client.sendMessage({
          receiveId: c.receiveId,
          receiveIdType: c.receiveIdType,
          msgType: routing.messageType,
          content,
        });

        // 有说明文字时补发一条
        if (args?.caption && String(args.caption).trim()) {
          await sendAuto(c, String(args.caption), cardOptions);
        }

        return {
          messageId: data.message_id ?? '',
          messageType: routing.messageType,
          bytes: file.size,
          fileName: file.fileName,
        };
      },
    }),
  );

  // ── 4. 发图片 ────────────────────────────────────────────────────────────
  ctx.effect(() =>
    ctx.tools.register({
      name: 'feishu_send_image',
      description: '上传并发送本地图片到飞书（png/jpg/jpeg/gif/webp/bmp）。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '本地图片绝对路径' },
          caption: { type: 'string', description: '图片说明（可选）' },
          receiveId: { type: 'string', description: '接收方 ID' },
          receiveIdType: { type: 'string', description: 'ID 类型，默认 chat_id' },
        },
        required: ['path'],
      },
      output: {
        schema: {
          type: 'object',
          properties: { messageId: { type: 'string' }, imageKey: { type: 'string' }, bytes: { type: 'number' } },
          required: ['messageId', 'imageKey'],
        },
        render: (_args, value) => textResult(`图片已发送（${value.bytes} 字节）message_id=${value.messageId}`),
      },
      async execute(args) {
        const path = requireString(args?.path, 'path');
        const c = makeContext(config, args);
        if (!c.receiveId) throw new Error('没有默认会话：请给 receiveId');

        const file = await readLocalFile(path);
        const ext = extname(path).toLowerCase();
        if (IMAGE_MIME[ext] === undefined) {
          throw new Error(`不支持的图片格式：${ext}（支持 ${Object.keys(IMAGE_MIME).join(', ')}）`);
        }
        const imageKey = await c.client.uploadImage({ buffer: file.buffer, fileName: file.fileName });
        const data = await c.client.sendMessage({
          receiveId: c.receiveId,
          receiveIdType: c.receiveIdType,
          msgType: 'image',
          content: JSON.stringify({ image_key: imageKey }),
        });
        if (args?.caption && String(args.caption).trim()) {
          await sendAuto(c, String(args.caption), cardOptions);
        }
        return { messageId: data.message_id ?? '', imageKey, bytes: file.size };
      },
    }),
  );

  // ── 5. 回复某条消息 ──────────────────────────────────────────────────────
  ctx.effect(() =>
    ctx.tools.register({
      name: 'feishu_reply',
      description: '回复飞书里的某条消息（挂在该消息下面，自动定位会话）。',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: 'string', description: '要回复的消息 ID（om_ 开头）' },
          text: { type: 'string', description: '回复内容，可含 Markdown' },
          forceCard: { type: 'boolean', description: '强制发卡片' },
          replyInThread: { type: 'boolean', description: '是否回复到话题里' },
        },
        required: ['messageId', 'text'],
      },
      output: {
        schema: {
          type: 'object',
          properties: { messageId: { type: 'string' }, msgType: { type: 'string' } },
          required: ['messageId'],
        },
        render: (_args, value) => textResult(`已回复（${value.msgType}）message_id=${value.messageId}`),
      },
      async execute(args) {
        const messageId = requireString(args?.messageId, 'messageId');
        const text = requireString(args?.text, 'text');
        const c = makeContext(config, args);
        const routed = buildOutboundPayload(text, { ...cardOptions, preferCard: Boolean(args?.forceCard) });
        const data = await c.client.replyMessage({
          messageId,
          msgType: routed.msgType,
          content: routed.content,
          replyInThread: Boolean(args?.replyInThread),
        });
        return { messageId: data.message_id ?? '', msgType: routed.msgType };
      },
    }),
  );

  // ── 6. 编辑已发消息 ──────────────────────────────────────────────────────
  ctx.effect(() =>
    ctx.tools.register({
      name: 'feishu_edit_message',
      description: '更新（编辑）已发送的飞书消息。卡片和文本消息都支持，可用于更新进度。',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: 'string', description: '要编辑的消息 ID' },
          text: { type: 'string', description: '新的内容，可含 Markdown' },
          forceCard: { type: 'boolean', description: '强制卡片' },
        },
        required: ['messageId', 'text'],
      },
      output: {
        schema: {
          type: 'object',
          properties: { messageId: { type: 'string' }, msgType: { type: 'string' } },
          required: ['messageId'],
        },
        render: (_args, value) => textResult(`已更新消息（${value.msgType}）${value.messageId}`),
      },
      async execute(args) {
        const messageId = requireString(args?.messageId, 'messageId');
        const text = requireString(args?.text, 'text');
        const c = makeContext(config, args);
        const routed = buildOutboundPayload(text, { ...cardOptions, preferCard: Boolean(args?.forceCard) });
        await c.client.updateMessage({ messageId, msgType: routed.msgType, content: routed.content });
        return { messageId, msgType: routed.msgType };
      },
    }),
  );

  // ── 7. 撤回消息 ──────────────────────────────────────────────────────────
  ctx.effect(() =>
    ctx.tools.register({
      name: 'feishu_delete_message',
      description: '撤回（删除）一条飞书消息。',
      parameters: {
        type: 'object',
        properties: { messageId: { type: 'string', description: '消息 ID' } },
        required: ['messageId'],
      },
      output: {
        schema: {
          type: 'object',
          properties: { messageId: { type: 'string' }, deleted: { type: 'boolean' } },
          required: ['messageId', 'deleted'],
        },
        render: (_args, value) => textResult(`已撤回 ${value.messageId}`),
      },
      async execute(args) {
        const messageId = requireString(args?.messageId, 'messageId');
        const c = makeContext(config, args);
        await c.client.deleteMessage({ messageId });
        return { messageId, deleted: true };
      },
    }),
  );

  // ── 8. 下载消息里的资源 ──────────────────────────────────────────────────
  ctx.effect(() =>
    ctx.tools.register({
      name: 'feishu_download',
      description: '下载飞书消息里的图片或文件到本地（入站附件解析用）。',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: 'string', description: '消息 ID（om_ 开头）' },
          fileKey: { type: 'string', description: '资源的 file_key / image_key' },
          type: { type: 'string', description: 'image 或 file，默认 file' },
          outputDir: { type: 'string', description: '保存目录，默认 <dsh home>/feishu-downloads' },
        },
        required: ['messageId', 'fileKey'],
      },
      output: {
        schema: {
          type: 'object',
          properties: { path: { type: 'string' }, bytes: { type: 'number' } },
          required: ['path', 'bytes'],
        },
        render: (_args, value) => textResult(`已下载：${value.path}（${value.bytes} 字节）`),
      },
      async execute(args) {
        const messageId = requireString(args?.messageId, 'messageId');
        const fileKey = requireString(args?.fileKey, 'fileKey');
        const c = makeContext(config, args);
        const { buffer, contentType } = await c.client.downloadResource({
          messageId,
          fileKey,
          type: args?.type === 'image' ? 'image' : 'file',
        });
        const dir = args?.outputDir || join(dshHome(), 'feishu-downloads');
        await mkdir(dir, { recursive: true });
        // 尽量保留扩展名：content-type 反推 + 退化到 .bin
        const extFromType = Object.entries(IMAGE_MIME).find(([, mime]) => contentType.startsWith(mime))?.[0];
        const ext = extFromType ?? (contentType.includes('pdf') ? '.pdf' : '.bin');
        const target = join(dir, `${fileKey.slice(0, 16)}-${randomUUID().slice(0, 8)}${ext}`);
        await writeFile(target, buffer);
        return { path: target, bytes: buffer.byteLength };
      },
    }),
  );

  // ── 9. 机器人身份 ────────────────────────────────────────────────────────
  ctx.effect(() =>
    ctx.tools.register({
      name: 'feishu_bot_info',
      description: '查询当前飞书机器人自己的身份（名称、open_id）。排查「消息里 @ 的是不是自己」时用。',
      parameters: { type: 'object', properties: {} },
      output: {
        schema: {
          type: 'object',
          properties: { name: { type: 'string' }, openId: { type: 'string' } },
          required: ['name', 'openId'],
        },
        render: (_args, value) => textResult(`机器人：${value.name}（open_id=${value.openId}）`),
      },
      async execute(args) {
        const c = makeContext(config, args);
        const info = await c.client.getBotInfo();
        return { name: info.bot_name ?? info.app_name ?? info.bot?.app_name ?? '', openId: info.open_id ?? '' };
      },
    }),
  );

  // ── 10. 只渲染不发（调试卡片/表格结构） ──────────────────────────────────
  ctx.effect(() =>
    ctx.tools.register({
      name: 'feishu_render_preview',
      description:
        '把 Markdown 渲染成飞书卡片 JSON 返回，不发送。用来验证表格是否正确转成原生 table 组件、标题是否降级为粗体。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Markdown 内容' },
          title: { type: 'string', description: '卡片标题' },
          plain: { type: 'boolean', description: '只看纯文本降级结果，返回纯文本而不是卡片 JSON' },
        },
        required: ['text'],
      },
      output: {
        schema: {
          type: 'object',
          properties: { rendered: { type: 'string' } },
          required: ['rendered'],
        },
        render: (_args, value) => textResult(value.rendered),
      },
      async execute(args) {
        const text = requireString(args?.text, 'text');
        if (args?.plain) return { rendered: stripMarkdownToPlainText(text) };
        const card = buildInteractiveCard(text, { ...cardOptions, botName: args?.title || botName });
        return { rendered: JSON.stringify(card, null, 2) };
      },
    }),
  );

  // ── 11. 归一化一条入站消息（给外部调用/调试用） ──────────────────────────
  ctx.effect(() =>
    ctx.tools.register({
      name: 'feishu_parse_message',
      description:
        '把飞书原始消息（message_type + content）归一化成可读文本和媒体引用列表。解析 post 富文本、卡片、合并转发、群名片、图片、文件等。',
      parameters: {
        type: 'object',
        properties: {
          messageType: { type: 'string', description: 'text / post / image / file / audio / media / merge_forward / share_chat / interactive' },
          content: { type: 'string', description: '飞书消息的 content 字段（JSON 字符串）' },
          mentions: { type: 'string', description: 'mentions 字段的 JSON 字符串（可选）' },
        },
        required: ['messageType', 'content'],
      },
      output: {
        schema: {
          type: 'object',
          properties: { json: { type: 'string' } },
          required: ['json'],
        },
        render: (_args, value) => textResult(value.json),
      },
      async execute(args) {
        const messageType = requireString(args?.messageType, 'messageType');
        const content = requireString(args?.content, 'content');
        let mentions = [];
        if (args?.mentions) {
          try {
            mentions = JSON.parse(args.mentions);
          } catch {
            mentions = [];
          }
        }
        const parsed = normalizeFeishuMessage({ messageType, rawContent: content, mentions });
        return { json: JSON.stringify(parsed, null, 2) };
      },
    }),
  );

  // ── 12. 入站长连接（可选，默认关闭）────────────────────────────────────
  // 同一飞书应用同时只允许一条长连接：启用前必须停掉 dsh-lark-bot 桥，
  // 否则两边抢连接、消息会漏。
  if (config.inbound === true || process.env.FEISHU_PLUGIN_INBOUND === '1') {
    ctx.effect(() => {
      let handle;
      let closed = false;
      // 同时写一份到文件：dsh 的日志不会落到 dsh-web.log，排障时看不到插件内部发生了什么。
      const logFile = join(dshHome(), 'feishu-plugin.log');
      const log = (msg) => {
        ctx.logger?.info?.(`[dsh-hermes-feishu] ${msg}`);
        try {
          const line = `[${new Date().toISOString()}] ${msg}\n`;
          appendFileSync(logFile, line, 'utf8');
        } catch {
          /* 日志写不进去不影响主流程 */
        }
      };

      (async () => {
        try {
          const client = clientFromEnv(process.env, {
            appId: config.appId || undefined,
            appSecret: config.appSecret || undefined,
            domain: config.domain || undefined,
            baseUrl: config.baseUrl || undefined,
          });
          const agentProfile = config.inboundProfile || process.env.FEISHU_PLUGIN_AGENT_PROFILE || 'headless';

          // 进程内 agent：能拿到 dsh 原生的 agent.steer()，
          // 也就是「任务执行中插一句话进去」。
          // 默认开启；设 FEISHU_PLUGIN_AGENT_MODE=headless 可回退到子进程模式。
          const agentMode = config.agentMode || process.env.FEISHU_PLUGIN_AGENT_MODE || 'inprocess';
          let runner = null;
          if (agentMode === 'inprocess') {
            try {
              runner = createInProcessRunner({
                ctx,
                log,
                cwd: process.env.FEISHU_PLUGIN_WORKSPACE || join(dshHome(), 'workspace'),
                // 传函数：每次建/恢复会话时现读，设置页改完主模型即刻生效
                agentOptions: () => ({
                  provider: config.agentProvider || process.env.FEISHU_PLUGIN_AGENT_PROVIDER || 'tokenbridge',
                  model: config.agentModel || process.env.FEISHU_PLUGIN_AGENT_MODEL || 'deepseek-flash',
                }),
              });
              log(`agent 模式：inprocess（支持执行中插入）`);


            } catch (error) {
              log(`inprocess 初始化失败，回退 headless：${error.message}`);
              runner = null;
            }
          } else {
            log(`agent 模式：headless（子进程，不支持执行中插入）`);
          }

          // 审批应答者：dsh 问「这个操作要不要放行」时，发飞书卡片等你点。
          // 没有它的话 dsh 会 fail-closed 成「问都不问直接拒绝」，
          // 表现为任务莫名失败。
          const approval = createFeishuApproval({
            client,
            log,
            resolveChat: (agentId) => {
              const found = runner ? runner.chatOfAgent(agentId) : undefined;
              if (found) return found;
              // ⚠️ 只有「拿不到 agent id」时才回落到默认 chat。
              // 拿到的是不属于飞书会话的 id（例如 dsh Web UI 里的会话）时，
              // 再兜到默认 chat 就会把别的通道的审批/提问抢到飞书来弹卡片。
              if (agentId) return undefined;
              return config.defaultChatId || process.env.FEISHU_PLUGIN_CHAT_ID || undefined;
            },
          });
          approval.install(ctx);

          // 用户提问应答者：dsh 的 ask_user_question 工具会挂起等回答，
          // 没有应答者时整轮会卡死（后面插的消息也只能排队）。
          const questions = createFeishuQuestions({
            client,
            log,
            resolveChat: (agentId) => {
              const found = runner ? runner.chatOfAgent(agentId) : undefined;
              if (found) return found;
              // ⚠️ 只有「拿不到 agent id」时才回落到默认 chat。
              // 拿到的是不属于飞书会话的 id（例如 dsh Web UI 里的会话）时，
              // 再兜到默认 chat 就会把别的通道的审批/提问抢到飞书来弹卡片。
              if (agentId) return undefined;
              return config.defaultChatId || process.env.FEISHU_PLUGIN_CHAT_ID || undefined;
            },
          });
          questions.install(ctx);
          log(`审批兜底 chat=${config.defaultChatId || process.env.FEISHU_PLUGIN_CHAT_ID || '(无)'}`);

          const onMessage = createMessageHandler({
            client,
            profile: agentProfile,
            botName,
            log,
            runner,
            // 进度气泡的行为全部来自插件配置（Web 设置页可改）
            // 传函数：每条消息现读，设置页保存后即刻生效（不用重启）
            getRuntime: () => ({
              progressOptions: {
                thinkingEnabled: config.thinkingEnabled === true,
                filterUserEcho: config.thinkingFilterUserEcho !== false,
                previewChars: Number(config.toolPreviewChars) || 60,
              },
              sttProvider: config.sttProvider || 'baidu',
              sttLanguage: config.sttLanguage || 'auto',
              // 发送方准入：设置页优先，环境变量兜底。
              // 环境变量给「不想开 Web 设置页」的部署留一条路；
              // 两者都没配时走 schema 默认值 allowlist + 空白名单 = 全部拒绝。
              dmPolicy:
                config.dmPolicy || process.env.FEISHU_PLUGIN_DM_POLICY || 'allowlist',
              groupPolicy:
                config.groupPolicy || process.env.FEISHU_PLUGIN_GROUP_POLICY || 'allowlist',
              allowFrom:
                config.allowFrom || process.env.FEISHU_PLUGIN_ALLOW_FROM || '',
            }),
            transcribe,
            // 提问卡片在等回答时，用户发来的文字直接当答案，不要 steer 进 agent
            // （agent 正卡在 ask_user_question 里，step 边界永远不到）
            onQuestionText: (chatId, text) => questions.handleFreeText(chatId, text),
          });

          handle = startInbound({
            appId: config.appId || process.env.FEISHU_PLUGIN_APP_ID,
            appSecret: config.appSecret || process.env.FEISHU_PLUGIN_APP_SECRET,
            domain: config.domain || process.env.FEISHU_PLUGIN_DOMAIN || 'feishu',
            onMessage,
            // 卡片按钮点击：审批卡的「允许 / 拒绝」在这里被消费，
            // 不是审批卡就返回 false 让它照常走别的处理。
            onCardAction: (event) => {
              // 返回飞书认的卡片回调响应体；卡片本身已经用 updateMessage 改成结论态了。
              const approved = approval.handleCardAction(event);
              if (approved === 'expired') {
                // 这张审批卡早就超时/作废了，别再报"已处理"误导用户。
                return { toast: { type: 'warning', content: '该审批已失效' } };
              }
              if (approved) {
                return { toast: { type: 'success', content: '已处理' } };
              }
              const answered = questions.handleCardAction(event);
              if (answered === 'expired') {
                return { toast: { type: 'warning', content: '该提问已失效' } };
              }
              if (answered) {
                return { toast: { type: 'success', content: '已提交回答' } };
              }
              return undefined;
            },
            onReady: () => log(`入站长连接已建立（agent profile: ${agentProfile}）`),
            onError: (error) => log(`入站错误：${error.message}`),
          });
        } catch (error) {
          log(`入站启动失败：${error.message}`);
        }
      })();

      return () => {
        if (closed) return;
        closed = true;
        handle?.close?.();
        log('入站长连接已关闭');
      };
    });
  }

  // ── 12. 发语音：文字 -> 已注册的 TTS 工具 -> Ogg/Opus -> 语音气泡 ───────
  ctx.effect(() =>
    ctx.tools.register({
      name: 'feishu_send_voice',
      description:
        '把文字合成为语音并发送成飞书语音气泡。合成走当前已安装的 TTS 插件工具（在设置页选），'
        + '拿到音频后转成 48kHz Ogg/Opus 再发送。参数按所选 TTS 工具自己的声明传。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要朗读的文字（上限 2000 字）' },
          args: {
            type: 'object',
            description: '透传给 TTS 工具的额外参数（如音色、语速）。不传则用设置页里配置的默认值',
          },
          receiveId: { type: 'string', description: '接收方 ID' },
          receiveIdType: { type: 'string', description: 'ID 类型，默认 chat_id' },
        },
        required: ['text'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            messageId: { type: 'string' },
            durationMs: { type: 'number' },
            bytes: { type: 'number' },
          },
          required: ['messageId'],
        },
        render: (_args, value) =>
          textResult(`语音已发送（${(value.durationMs / 1000).toFixed(1)} 秒，${value.bytes} 字节）`),
      },
      async execute(args) {
        const text = requireString(args?.text, 'text');
        const c = makeContext(config, args);
        if (!c.receiveId) throw new Error('没有默认会话：请给 receiveId');

        // 找到要用的 TTS 工具：设置页选的优先，否则取第一个已注册的 *tts* 工具。
        const tools = ctx.get('tools');
        const schemas = typeof tools?.schemas === 'function' ? tools.schemas() ?? [] : [];
        const candidates = schemas.filter((s) => typeof s?.name === 'string' && /(^|_)tts($|_)/i.test(s.name));
        const toolName = candidates.some((s) => s.name === config.ttsTool) ? config.ttsTool : candidates[0]?.name;
        if (!toolName) {
          throw new Error('没有可用的语音合成工具：请先安装一个 TTS 插件（如 dsh-baidu-tts）');
        }

        // 参数 = 设置页存的那份 + 本次调用显式传入的，后者覆盖前者。
        let savedArgs = {};
        try {
          const parsed = JSON.parse(config.ttsArgs || '{}');
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) savedArgs = parsed;
        } catch {
          /* 配置里坏 JSON 就当没配 */
        }
        const callArgs = { text, ...savedArgs, ...(args?.args && typeof args.args === 'object' ? args.args : {}) };

        const tool = typeof tools?.get === 'function' ? tools.get(toolName) : undefined;
        if (!tool || typeof tool.execute !== 'function') {
          throw new Error(`找不到语音合成工具 ${toolName}`);
        }
        const result = await tool.execute(callArgs, { signal: undefined });

        // TTS 工具普遍返回生成好的音频文件路径；读出字节再转码。
        const audioPath = typeof result?.path === 'string' ? result.path : '';
        if (!audioPath) {
          throw new Error(`${toolName} 没有返回音频文件路径（拿到的是 ${JSON.stringify(result).slice(0, 120)}）`);
        }
        const mp3 = await readFile(audioPath);
        const ext = extname(audioPath).toLowerCase() || '.mp3';
        // 飞书语音气泡只认 48kHz Ogg/Opus，TTS 工具给的多半是 mp3，必须先转码。
        // （这里以前漏了这一步，直接拿没定义的 ogg 去发，一调用就 ReferenceError）
        const ogg = await toOpusVoice(mp3, ext);
        const durationMs = await durationMsOf(ogg, '.ogg');
        const data = await c.client.sendAudio({
          receiveId: c.receiveId,
          receiveIdType: c.receiveIdType,
          buffer: ogg,
          durationMs,
          fileName: 'voice.ogg',
        });
        return {
          messageId: data.message_id ?? '',
          durationMs,
          bytes: ogg.byteLength,
        };
      },
    }),
  );

  // ── 13. 语音转文字 ────────────────────────────────────────────────
  ctx.effect(() =>
    ctx.tools.register({
      name: 'feishu_transcribe',
      description:
        '把本地音频文件转成文字（百度短语音识别，需 60 秒以内）。内部先用 ffmpeg 转成 16kHz 单声道 WAV 再识别。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '本地音频文件绝对路径（ogg/mp3/wav/m4a 等）' },
          language: { type: 'string', description: 'auto | zh | en | yue，默认 auto' },
        },
        required: ['path'],
      },
      output: {
        schema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
        render: (_args, value) => textResult(value.text || '(未识别出文字)'),
      },
      async execute(args) {
        if (!sttConfigured()) {
          throw new Error('语音识别未配置：需要 BAIDU_VOICE_API_KEY / BAIDU_VOICE_SECRET_KEY');
        }
        const path = requireString(args?.path, 'path');
        const buffer = await readFile(path);
        const ext = extname(path) || '.opus';
        const text = await transcribeAudio(buffer, ext, { language: args?.language });
        return { text };
      },
    }),
  );

  ctx.effect(() => {
    ctx.logger?.info?.('dsh-hermes-feishu: 13 个飞书工具已注册（渲染 + 收发 + 媒体）');
  });
}

export { name, inject, Config };
export { FeishuClient } from './feishu.js';
export {
  buildInteractiveCard,
  buildInteractivePayload,
  buildMarkdownPostPayload,
  buildOutboundPayload,
  stripMarkdownToPlainText,
} from './render.js';
export { normalizeFeishuMessage } from './inbound.js';