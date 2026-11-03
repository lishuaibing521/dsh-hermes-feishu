// dsh-hermes-feishu — 语音识别（百度短语音识别）。
//
// 移植自 dsh-lark-bot 的 src/media/stt.ts。为什么要自己调百度：
// dsh 的 `speechToText` 是运行期进程里的服务（由 dsh-baidu-stt 提供），
// 插件进程注入不到它，所以这里直连百度 API，复用同一份 token 缓存文件。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { toSttWav } from './transcode.js';

const STT_ENDPOINT = 'https://vop.baidu.com/server_api';
const TOKEN_ENDPOINT = 'https://aip.baidubce.com/oauth/2.0/token';
const DEV_PID = { auto: 1537, zh: 1537, en: 1737, yue: 1637 };
const TOKEN_FALLBACK_TTL_MS = 29 * 86400 * 1000;
const TOKEN_EXPIRED_ERR_NO = 3302;

function dshHome() {
  const home = process.env.DSH_HOME;
  return typeof home === 'string' && home.length > 0 ? home : join(homedir(), '.dsh');
}

function tokenFile() {
  return join(dshHome(), 'cache', 'baidu-speech-token.json');
}

async function readCachedToken() {
  try {
    const parsed = JSON.parse(await readFile(tokenFile(), 'utf8'));
    if (typeof parsed?.token !== 'string' || typeof parsed?.at !== 'number') return undefined;
    if (Date.now() - parsed.at >= TOKEN_FALLBACK_TTL_MS) return undefined;
    return parsed.token;
  } catch {
    return undefined;
  }
}

async function storeToken(token, expiresIn) {
  const ttl =
    typeof expiresIn === 'number' && expiresIn > 0
      ? Math.min(expiresIn * 1000, TOKEN_FALLBACK_TTL_MS)
      : TOKEN_FALLBACK_TTL_MS;
  try {
    await mkdir(join(dshHome(), 'cache'), { recursive: true });
    await writeFile(tokenFile(), JSON.stringify({ token, at: Date.now(), ttl }), 'utf8');
  } catch {
    // 缓存写失败只多换一次 token，不影响识别
  }
  return token;
}

async function requestToken(apiKey, secretKey, signal) {
  const url =
    `${TOKEN_ENDPOINT}?grant_type=client_credentials` +
    `&client_id=${encodeURIComponent(apiKey)}&client_secret=${encodeURIComponent(secretKey)}`;
  const response = await fetch(url, { method: 'POST', ...(signal ? { signal } : {}) });
  const payload = await response.json().catch(() => undefined);
  if (typeof payload?.access_token !== 'string') {
    const detail = payload?.error_description ?? payload?.error;
    throw new Error(`百度语音 access_token 获取失败${detail === undefined ? '' : `：${String(detail)}`}`);
  }
  return storeToken(payload.access_token, payload.expires_in);
}

async function accessToken(apiKey, secretKey, signal, force) {
  if (!force) {
    const cached = await readCachedToken();
    if (cached !== undefined) return cached;
  }
  return requestToken(apiKey, secretKey, signal);
}

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
    ...(signal ? { signal } : {}),
  });
  return response.json().catch(() => undefined);
}

async function recognize(wav, language, apiKey, secretKey, signal) {
  let payload = await recognizeOnce(wav, language, await accessToken(apiKey, secretKey, signal, false), signal);
  if (payload?.err_no === TOKEN_EXPIRED_ERR_NO) {
    payload = await recognizeOnce(wav, language, await accessToken(apiKey, secretKey, signal, true), signal);
  }
  if (payload === undefined) throw new Error('百度语音识别返回了非 JSON 响应');
  if (payload.err_no !== 0) {
    throw new Error(`百度语音识别失败（err_no=${String(payload.err_no)}）：${payload.err_msg ?? '未知错误'}`);
  }
  return Array.isArray(payload.result) ? payload.result.join('') : '';
}

/** 语音二进制 -> 文字。凭据缺失时抛错，由调用方决定怎么降级。 */
export async function transcribeAudio(buffer, extension = '.opus', options = {}) {
  const apiKey = process.env.BAIDU_VOICE_API_KEY;
  const secretKey = process.env.BAIDU_VOICE_SECRET_KEY;
  if (typeof apiKey !== 'string' || !apiKey || typeof secretKey !== 'string' || !secretKey) {
    throw new Error('百度语音凭据缺失：需要 BAIDU_VOICE_API_KEY 与 BAIDU_VOICE_SECRET_KEY');
  }
  const ext = extension && extension.startsWith('.') ? extension : `.${extension || 'opus'}`;
  const wav = await toSttWav(buffer, ext);
  return recognize(wav, options.language ?? 'auto', apiKey, secretKey, options.signal);
}

/** 语音文件路径 -> 文字。 */
export async function transcribeAudioFile(path, options = {}) {
  const buffer = await readFile(path);
  const ext = extname(path) || '.opus';
  return transcribeAudio(buffer, ext, options);
}

export function sttConfigured() {
  return Boolean(process.env.BAIDU_VOICE_API_KEY && process.env.BAIDU_VOICE_SECRET_KEY);
}