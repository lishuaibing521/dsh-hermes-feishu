// dsh-hermes-feishu — 百度语音能力（识别 + 合成）。
//
// 原本这两件事由两个独立插件（dsh-baidu-stt / dsh-baidu-tts）提供：
//   - STT 注册到 dsh 的 speechToText 服务，凭据读环境变量
//   - TTS 注册成 baidu_tts 工具，凭据也读环境变量
//
// 现在合并进本插件，好处是**密钥直接在插件设置页填**，不用去改 .env；
// 而且少装两个 bundle，少一份 peer 依赖风险。
//
// 两者共用同一份 access_token 缓存（百度同一组 key 换出来的 token 是一样的），
// 缓存文件沿用原来的路径，老用户升级后不需要重新取 token。
//
// 只依赖 node: 内置，不 import @deepseek-ai/*。

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TOKEN_ENDPOINT = 'https://aip.baidubce.com/oauth/2.0/token';
const STT_ENDPOINT = 'https://vop.baidu.com/server_api';
const TTS_ENDPOINT = 'https://tsn.baidu.com/text2audio';

const TOKEN_FALLBACK_TTL_MS = 29 * 86400 * 1000;
/** 百度侧的「token 过期」错误码，命中就强制刷新重试一次。 */
const TOKEN_EXPIRED_ERR_NO = 3302;

const DEV_PID = { auto: 1537, zh: 1537, en: 1737, yue: 1637 };

/** 百度语音合成的发音人。 */
export const TTS_VOICES = {
  '0': '度小美（女声）',
  '1': '度小宇（男声）',
  '3': '度逍遥（男声）',
  '4': '度丫丫（童声）',
  '5003': '度逍遥（情感男声）',
};
export const DEFAULT_TTS_VOICE = '0';
export const MAX_TTS_TEXT_LENGTH = 2000;

/**
 * 凭据来源。
 *
 * 插件启动时注入一个「现读配置」的闭包 —— 设置页改完立刻生效，不用重启。
 * 没注入时退回环境变量，兼容老部署。
 */
let credentialSource = null;

/**
 * 注入凭据来源。
 *
 * @param {() => {apiKey?: string, secretKey?: string}|undefined} source
 */
export function setCredentialSource(source) {
  credentialSource = typeof source === 'function' ? source : null;
}

/** 环境变量兜底：老部署把密钥放在 .env 里，升级后不该突然不能用了。 */
function envCredentials() {
  const apiKey = process.env.BAIDU_VOICE_API_KEY;
  const secretKey = process.env.BAIDU_VOICE_SECRET_KEY;
  if (typeof apiKey === 'string' && apiKey && typeof secretKey === 'string' && secretKey) {
    return { apiKey, secretKey };
  }
  return undefined;
}

/**
 * 取当前生效的凭据。
 * @returns {{apiKey: string, secretKey: string}|undefined}
 */
export function currentCredentials() {
  try {
    const fromConfig = credentialSource?.();
    if (
      typeof fromConfig?.apiKey === 'string' &&
      fromConfig.apiKey &&
      typeof fromConfig?.secretKey === 'string' &&
      fromConfig.secretKey
    ) {
      return { apiKey: fromConfig.apiKey, secretKey: fromConfig.secretKey };
    }
  } catch {
    /* 配置读取异常时继续走环境变量 */
  }
  return envCredentials();
}

/** 凭据是否齐备（决定要不要走语音链路、以及设置页的提示）。 */
export function baiduConfigured() {
  return currentCredentials() !== undefined;
}

function dshHome() {
  const home = process.env.DSH_HOME;
  return typeof home === 'string' && home.length > 0 ? home : join(homedir(), '.dsh');
}

/**
 * 按凭据指纹区分的 token 缓存文件。
 *
 * 百度换出来的 access_token 是绑定到具体应用（API Key）的。缓存只按固定路径存，
 * 换一组密钥后仍会读到旧 token —— 轻则一直 401 直到过期（最长 29 天），
 * 重则拿旧应用的 token 去调新应用。所以文件名带上 apiKey 的哈希。
 *
 * 不存 apiKey 原文，只存 sha256 前 16 位。
 */
function tokenFileFor(credentials) {
  const fingerprint = createHash('sha256')
    .update(String(credentials?.apiKey ?? ''))
    .digest('hex')
    .slice(0, 16);
  return join(dshHome(), 'cache', `baidu-speech-token-${fingerprint}.json`);
}

/**
 * 给 fetch 兜一个超时。
 *
 * 百度侧偶尔不响应（不是报错，是干脆不回包），没有中止信号时 await 会一直挂着，
 * 整条语音链路就永久卡住 —— 用户只看到「发了语音没反应」。
 */
export function withTimeout(ms, external) {
  const own = AbortSignal.timeout(ms);
  if (!external) return own;
  try {
    return AbortSignal.any([external, own]);
  } catch {
    return own;
  }
}

async function readCachedToken(credentials) {
  try {
    const parsed = JSON.parse(await readFile(tokenFileFor(credentials), 'utf8'));
    if (typeof parsed?.token !== 'string' || typeof parsed?.at !== 'number') return undefined;
    if (Date.now() - parsed.at >= TOKEN_FALLBACK_TTL_MS) return undefined;
    return parsed.token;
  } catch {
    return undefined;
  }
}

async function storeToken(credentials, token, expiresIn) {
  const ttl =
    typeof expiresIn === 'number' && expiresIn > 0
      ? Math.min(expiresIn * 1000, TOKEN_FALLBACK_TTL_MS)
      : TOKEN_FALLBACK_TTL_MS;
  try {
    await mkdir(join(dshHome(), 'cache'), { recursive: true });
    await writeFile(tokenFileFor(credentials), JSON.stringify({ token, at: Date.now(), ttl }), 'utf8');
  } catch {
    // 缓存写失败只多换一次 token，不影响功能
  }
  return token;
}

async function requestToken(credentials, signal) {
  const url =
    `${TOKEN_ENDPOINT}?grant_type=client_credentials` +
    `&client_id=${encodeURIComponent(credentials.apiKey)}` +
    `&client_secret=${encodeURIComponent(credentials.secretKey)}`;
  const response = await fetch(url, { method: 'POST', signal: withTimeout(15000, signal) });
  const payload = await response.json().catch(() => undefined);
  if (typeof payload?.access_token !== 'string') {
    const detail = payload?.error_description ?? payload?.error;
    throw new Error(`百度语音 access_token 获取失败${detail === undefined ? '' : `：${String(detail)}`}`);
  }
  return storeToken(credentials, payload.access_token, payload.expires_in);
}

/**
 * 取 access_token（优先用缓存）。
 * @param {{apiKey:string, secretKey:string}} credentials
 * @param {AbortSignal} [signal]
 * @param {boolean} [force] 强制刷新（token 被百度判过期时用）
 */
export async function accessToken(credentials, signal, force) {
  if (!force) {
    const cached = await readCachedToken(credentials);
    if (cached !== undefined) return cached;
  }
  return requestToken(credentials, signal);
}

// ── 语音识别（STT）──────────────────────────────────────────

async function recognizeOnce(wav, language, token, signal) {
  const body = JSON.stringify({
    format: 'wav',
    rate: 16000,
    channel: 1,
    cuid: 'dsh-hermes-feishu',
    dev_pid: DEV_PID[language] ?? DEV_PID.auto,
    token,
    speech: wav.toString('base64'),
    len: wav.byteLength,
  });
  const response = await fetch(STT_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: withTimeout(30000, signal),
  });
  return response.json().catch(() => undefined);
}

/**
 * 识别一段 16kHz 单声道 PCM16 WAV。
 *
 * @param {Buffer} wav
 * @param {string} [language] auto / zh / en / yue
 * @param {{apiKey:string, secretKey:string}} credentials
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}
 */
export async function recognizeWav(wav, language, credentials, signal) {
  let payload = await recognizeOnce(
    wav,
    language,
    await accessToken(credentials, signal, false),
    signal,
  );
  if (payload?.err_no === TOKEN_EXPIRED_ERR_NO) {
    payload = await recognizeOnce(
      wav,
      language,
      await accessToken(credentials, signal, true),
      signal,
    );
  }
  if (payload === undefined) throw new Error('百度语音识别返回了非 JSON 响应');
  if (payload.err_no !== 0) {
    throw new Error(`百度语音识别失败（err_no=${String(payload.err_no)}）：${payload.err_msg ?? '未知错误'}`);
  }
  return Array.isArray(payload.result) ? payload.result.join('') : '';
}

// ── 语音合成（TTS）──────────────────────────────────────────

/** 语速 / 音调 / 音量：百度要求整数 0-15，越界一律夹到区间内。 */
function clampLevel(value, fallback) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(15, Math.max(0, Math.round(number)));
}

/**
 * 把文本合成为 mp3。
 *
 * @param {{text:string, voice?:string, speed?:number, pitch?:number, volume?:number}} input
 * @param {{apiKey:string, secretKey:string}} credentials
 * @param {AbortSignal} [signal]
 * @returns {Promise<{audio: Buffer, voice: string}>}
 */
export async function synthesizeMp3(input, credentials, signal) {
  const text = String(input?.text ?? '').trim();
  if (!text) throw new Error('百度语音合成：text 不能为空');
  if (text.length > MAX_TTS_TEXT_LENGTH) {
    throw new Error(`百度语音合成：文本过长（${text.length} 字，上限 ${MAX_TTS_TEXT_LENGTH} 字）`);
  }

  const voice = TTS_VOICES[input.voice] !== undefined ? input.voice : DEFAULT_TTS_VOICE;
  const form = new URLSearchParams({
    // 百度要求正文 URL 编码两次
    tex: encodeURIComponent(text),
    tok: await accessToken(credentials, signal),
    cuid: 'dsh-hermes-feishu',
    ctp: '1',
    lan: 'zh',
    spd: String(clampLevel(input.speed, 5)),
    pit: String(clampLevel(input.pitch, 5)),
    vol: String(clampLevel(input.volume, 5)),
    per: voice,
    aue: '3', // mp3
  });

  const post = async (token) => {
    form.set('tok', token);
    const response = await fetch(TTS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: withTimeout(30000, signal),
    });
    const mediaType = response.headers.get('content-type') ?? '';
    if (mediaType.includes('json')) {
      return { error: await response.json().catch(() => undefined) };
    }
    return { audio: Buffer.from(await response.arrayBuffer()), mediaType };
  };

  let result = await post(form.get('tok'));
  if (result.error?.err_no === TOKEN_EXPIRED_ERR_NO) {
    result = await post(await accessToken(credentials, signal, true));
  }
  if (result.error !== undefined) {
    const code = result.error?.err_no ?? 'unknown';
    const message = result.error?.err_msg ?? '未知错误';
    throw new Error(`百度语音合成失败（err_no=${String(code)}）：${message}`);
  }
  if (result.audio.byteLength === 0) throw new Error('百度语音合成返回了空音频');
  return { audio: result.audio, voice };
}