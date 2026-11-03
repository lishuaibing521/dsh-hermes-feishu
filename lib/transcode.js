// dsh-hermes-feishu — 音视频转码（ffmpeg）。
//
// 移植自 dsh-lark-bot 的 src/media/transcode.ts。两个用途：
//   - 语音识别：任意容器 -> 16kHz 单声道 PCM16 WAV（百度 STT 要的格式）
//   - 发语音气泡：任意音频 -> 48kHz 单声道 Ogg/Opus（飞书 im 要的格式）
//
// ffmpeg 查找顺序：环境变量 FEISHU_PLUGIN_FFMPEG -> 本机 Hermes 自带 ->
// PATH。插件进程可能不是从交互式 shell 启动的，PATH 未必有，所以本机绝对路径
// 兜底才是生产环境真正生效的那条。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FFMPEG_FALLBACK =
  'C:\\Users\\lishuaibing\\AppData\\Local\\hermes\\tools\\ffmpeg-9.0.1-win32-x64\\bin\\ffmpeg.exe';
const FFPROBE_FALLBACK =
  'C:\\Users\\lishuaibing\\AppData\\Local\\hermes\\tools\\ffmpeg-9.0.1-win32-x64\\bin\\ffprobe.exe';

export function ffmpegBinary() {
  const override = process.env.FEISHU_PLUGIN_FFMPEG;
  if (typeof override === 'string' && override.trim() !== '') return override.trim();
  if (existsSync(FFMPEG_FALLBACK)) return FFMPEG_FALLBACK;
  return 'ffmpeg';
}

export function ffmpegAvailable() {
  const binary = ffmpegBinary();
  return binary === 'ffmpeg' || existsSync(binary);
}

export function runFfmpeg(args, timeoutMs = 120000) {
  const binary = ffmpegBinary();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['-hide_banner', '-loglevel', 'error', ...args], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const stderr = [];
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      reject(new Error(`ffmpeg 超时（${timeoutMs}ms）`));
    }, timeoutMs);

    child.stderr?.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`ffmpeg 启动失败（${binary}）：${error.message}`));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 退出码 ${code}：${Buffer.concat(stderr).toString('utf8').trim().slice(0, 400)}`));
    });
  });
}

/** 任意输入 -> 目标格式。args 是「输出选项」，必须夹在输入和目标文件之间。 */
export async function transcodeFile(input, args, extension) {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-media-'));
  const source = join(dir, `input${extension}`);
  const target = join(dir, `output${extension}`);
  try {
    await writeFile(source, input);
    await runFfmpeg(['-y', '-i', source, ...args, target]);
    return await readFile(target);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 16kHz 单声道 PCM16 WAV —— 云语音识别的标准输入。 */
export function toSttWav(input, extension) {
  return transcodeFile(input, ['-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav'], extension);
}

/** 48kHz 单声道 Ogg/Opus —— 飞书语音气泡要求的格式。 */
export function toOpusVoice(input, extension) {
  return transcodeFile(input, ['-c:a', 'libopus', '-b:a', '32k', '-ar', '48000', '-ac', '1', '-f', 'ogg'], extension);
}

export function ffprobeBinary() {
  const override = process.env.FEISHU_PLUGIN_FFPROBE;
  if (typeof override === 'string' && override.trim() !== '') return override.trim();
  if (existsSync(FFPROBE_FALLBACK)) return FFPROBE_FALLBACK;
  return 'ffprobe';
}

/**
 * 取音频时长（毫秒）。飞书 audio 消息必须带 duration，否则客户端显示 0 秒。
 * 失败返回 0，让调用方决定是否降级。
 */
export async function durationMsOf(buffer, extension) {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-probe-'));
  const source = join(dir, `input${extension}`);
  try {
    await writeFile(source, buffer);
    const binary = ffprobeBinary();
    return await new Promise((resolve) => {
      const child = spawn(
        binary,
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', source],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      let out = '';
      let done = false;
      // ffprobe 碰到畸形文件/被锁住会一直不退出。没有这个定时器的话
      // Promise 永不 settle，await 卡死、临时目录也清理不掉，
      // 连带发语音的工具整个挂住。
      const finish = (ms) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(ms);
      };
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        finish(0);
      }, 10000);
      child.stdout.on('data', (chunk) => {
        out += chunk.toString('utf8');
      });
      child.once('error', () => finish(0));
      child.once('close', () => {
        const seconds = Number.parseFloat(out.trim());
        finish(Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0);
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}