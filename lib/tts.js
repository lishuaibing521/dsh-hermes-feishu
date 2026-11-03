// dsh-hermes-feishu — 语音合成（百度 TTS）。
//
// 和 stt.js 配套：给「发语音气泡」用。百度返回 mp3（aue=3），
// 再经 transcode.js 转成飞书要的 48kHz Ogg/Opus。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TTS_ENDPOINT = 'https://tsn.baidu.com/text2audio';
const TOKEN_ENDPOINT = 'https://aip.baidubce.com/oauth/2.0/token';
const TOKEN_FALLBACK_TTL_MS = 29 * 86400 * 1000;
const MAX_TEXT_LENGTH = 2000;

const VOICES = {
  0: '度小美（女声）',
  1: '度小宇（男声）',
  3: '度逍遥（男声）',
  4: '度丫丫（童声）',
  5003: '度逍遥（情感男声）',
};
const DEFAULT_VOICE = '0';

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
    /* 缓存可有可无 */
  }
  return token;
}

async function accessToken(apiKey, secretKey, signal, force) {
  if (!force) {
    const cached = await readCachedToken();
    if (cached !== undefined) return cached;
  }
  const url =
    `${TOKEN_ENDPOINT}?grant_type=client_credentials` +
    `&client_id=${encodeURIComponent(apiKey)}&client_secret=${encodeURIComponent(secretKey)}`;
  const response = await fetch(url, { method: 'POST', ...(signal ? { signal } : {}) });
  const payload = await response.json().catch(() => undefined);
  if (typeof payload?.access_token !== 'string') {
    const detail = payload?.error_description ?? payload?.error;
    throw new Error(`百度语音 access_token 获取失败${detail ? `：${detail}` : ''}`);
  }
  return storeToken(payload.access_token, payload.expires_in);
}

function clampLevel(value, fallback) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(15, Math.max(0, Math.round(number)));
}

/**
 * 文字 -> mp3 Buffer。
 * @param {string} text
 * @param {object} [options] voice / speed / pitch / volume
 */
export async function synthesize(text, options = {}) {
  const apiKey = process.env.BAIDU_VOICE_API_KEY;
  const secretKey = process.env.BAIDU_VOICE_SECRET_KEY;
  if (!apiKey || !secretKey) {
    throw new Error('百度语音凭据缺失：需要 BAIDU_VOICE_API_KEY 与 BAIDU_VOICE_SECRET_KEY');
  }
  const clean = String(text ?? '').trim();
  if (!clean) throw new Error('要合成的文本为空');
  if (clean.length > MAX_TEXT_LENGTH) {
    throw new Error(`文本太长（${clean.length} 字），百度接口上限 ${MAX_TEXT_LENGTH} 字`);
  }

  const voiceKey = String(options.voice ?? DEFAULT_VOICE);
  const voice = VOICES[voiceKey] !== undefined ? voiceKey : DEFAULT_VOICE;

  const form = new URLSearchParams({
    // 百度要求正文 URL 编码两次
    tex: encodeURIComponent(clean),
    tok: await accessToken(apiKey, secretKey, undefined, false),
    cuid: 'dsh-hermes-feishu',
    ctp: '1',
    lan: 'zh',
    spd: String(clampLevel(options.speed, 5)),
    pit: String(clampLevel(options.pitch, 5)),
    vol: String(clampLevel(options.volume, 5)),
    per: voice,
    aue: '3', // 3 = mp3
  });

  const post = async (token) => {
    form.set('tok', token);
    const response = await fetch(TTS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const mediaType = response.headers.get('content-type') ?? '';
    if (mediaType.includes('json')) {
      return { error: await response.json().catch(() => undefined) };
    }
    return { audio: Buffer.from(await response.arrayBuffer()) };
  };

  let result = await post(form.get('tok'));
  if (result.error?.err_no === 3302) {
    result = await post(await accessToken(apiKey, secretKey, undefined, true));
  }
  if (result.error !== undefined) {
    const code = result.error?.err_no ?? 'unknown';
    throw new Error(`百度语音合成失败（err_no=${code}）：${result.error?.err_msg ?? '未知错误'}`);
  }
  if (!result.audio || result.audio.byteLength === 0) throw new Error('百度语音合成返回了空音频');
  return result.audio;
}

export function ttsConfigured() {
  return Boolean(process.env.BAIDU_VOICE_API_KEY && process.env.BAIDU_VOICE_SECRET_KEY);
}