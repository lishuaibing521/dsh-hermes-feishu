// dsh-hermes-feishu — 语音识别（百度短语音识别）。
//
// 实现已经挪进 baidu.js（和 TTS 共用 token 与凭据），这里只保留
// 「插件侧怎么用」的那层：音频格式转换 + 调用入口。
//
// 凭据优先级：插件设置页 > 环境变量（老部署兼容）。具体见 baidu.js。
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

import { toSttWav } from './transcode.js';
import { baiduConfigured, currentCredentials, recognizeWav } from './baidu.js';

/**
 * 语音二进制 -> 文字。凭据缺失时抛错，由调用方决定怎么降级。
 *
 * @param {Buffer} buffer
 * @param {string} [extension] 源音频扩展名（.opus / .mp3 / .wav ...）
 * @param {{language?: string, signal?: AbortSignal}} [options]
 */
export async function transcribeAudio(buffer, extension = '.opus', options = {}) {
  const credentials = currentCredentials();
  if (!credentials) {
    throw new Error(
      '百度语音凭据缺失：请在「插件配置 → 语音」里填 API Key 与 Secret Key'
        + '（也可以沿用环境变量 BAIDU_VOICE_API_KEY / BAIDU_VOICE_SECRET_KEY）',
    );
  }
  const ext = extension && extension.startsWith('.') ? extension : `.${extension || 'opus'}`;
  const wav = await toSttWav(buffer, ext);
  return recognizeWav(wav, options.language ?? 'auto', credentials, options.signal);
}

/** 语音文件路径 -> 文字。 */
export async function transcribeAudioFile(path, options = {}) {
  const buffer = await readFile(path);
  const ext = extname(path) || '.opus';
  return transcribeAudio(buffer, ext, options);
}

/** 由 index.js 注入：按当前 sttBackend 判断识别能力是否可用。 */
let availabilityProbe = null;

/** 凭据是否齐备（决定要不要走语音链路、以及给用户什么提示）。 */
export function sttConfigured() {
  if (availabilityProbe) {
    try {
      return availabilityProbe();
    } catch {
      /* 探针异常时退回只看百度 */
    }
  }
  return baiduConfigured();
}

/**
 * 自定义「识别能力是否可用」的判定。
 *
 * ⚠️ 不能只看百度密钥：后端选 `dsh 服务` 时根本不需要百度密钥，
 * 只看百度会把这种情况误判成「未配置」，语音消息被直接跳过。
 * 所以由 index.js 在启动时注入一个按当前 sttBackend 判断的探针。
 *
 * @param {() => boolean} probe
 */
export function setSttAvailability(probe) {
  availabilityProbe = typeof probe === 'function' ? probe : null;
}