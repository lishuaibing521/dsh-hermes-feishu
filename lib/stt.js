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

/** 凭据是否齐备（决定要不要走语音链路、以及给用户什么提示）。 */
export function sttConfigured() {
  return baiduConfigured();
}