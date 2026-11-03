// 语音链路验证：TTS 合成 -> 转 Ogg/Opus -> 发语音气泡 -> 下载回来 -> STT 识别。
// 跑法：node test/voice-live.mjs
import { readFile } from 'node:fs/promises';
import { FeishuClient } from '../lib/feishu.js';
import { synthesize } from '../lib/tts.js';
import { toOpusVoice, durationMsOf } from '../lib/transcode.js';
import { transcribeAudio } from '../lib/stt.js';

const t = await readFile('C:/Users/lishuaibing/.dsh/.env', 'utf8');
const pick = (k) => {
  const m = new RegExp(`^${k}\\s*=\\s*(.+)$`, 'm').exec(t);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : undefined;
};
// 百度凭据来自 .env，注入进程环境
process.env.BAIDU_VOICE_API_KEY = pick('BAIDU_VOICE_API_KEY');
process.env.BAIDU_VOICE_SECRET_KEY = pick('BAIDU_VOICE_SECRET_KEY');

const client = new FeishuClient({
  appId: pick('FEISHU_PLUGIN_APP_ID'),
  appSecret: pick('FEISHU_PLUGIN_APP_SECRET'),
  domain: pick('FEISHU_PLUGIN_DOMAIN') ?? 'feishu',
});
const chatId = 'oc_b037d4652e1b16a59fe04d9a9cf929a8';

const SENTENCE = '这是语音链路测试，如果你能听到这句话，说明发送语音正常。';

console.log('1) TTS 合成…');
const mp3 = await synthesize(SENTENCE, { voice: '0' });
console.log(`   mp3 ${mp3.byteLength} 字节`);

console.log('2) 转 Ogg/Opus…');
const ogg = await toOpusVoice(mp3, '.mp3');
const dur = await durationMsOf(ogg, '.ogg');
console.log(`   ogg ${ogg.byteLength} 字节，时长 ${(dur / 1000).toFixed(1)} 秒`);

console.log('3) 发语音气泡…');
const sent = await client.sendAudio({
  receiveId: chatId,
  receiveIdType: 'chat_id',
  buffer: ogg,
  durationMs: dur,
  fileName: 'voice.ogg',
});
console.log('   message_id =', sent.message_id);

console.log('4) 把刚发的语音下载回来，再识别一遍（验证 STT）…');
const back = await client.downloadResource({
  messageId: sent.message_id,
  fileKey: sent.fileKey,
  type: 'file',
});
console.log(`   下载 ${back.buffer.byteLength} 字节`);
const text = await transcribeAudio(back.buffer, '.ogg');
console.log('   识别结果:', text || '(空)');
console.log('\n原文:', SENTENCE);