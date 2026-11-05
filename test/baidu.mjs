// 百度语音模块（内置 STT/TTS）的回归测试。
//
// 覆盖：
//   1. 凭据优先级：设置页配置 > 环境变量；两边都空 = 未配置
//   2. token 缓存复用 + 过期强制刷新（err_no 3302）
//   3. 语音合成的请求体（aue=3 / 发音人 / 参数夹取）与错误处理
//   4. 语音识别的错误处理
//
// 全部用假的 fetch，不发真实网络请求。
//
// 运行：node test/baidu.mjs

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 必须在 import baidu.js 之前把 DSH_HOME 指到临时目录，
// 否则会读写真实的 token 缓存。
const home = await mkdtemp(join(tmpdir(), 'baidu-test-'));
process.env.DSH_HOME = home;

const {
  setCredentialSource,
  currentCredentials,
  baiduConfigured,
  synthesizeMp3,
  recognizeWav,
  TTS_VOICES,
} = await import('../lib/baidu.js');

let passed = 0;
let failed = 0;

function ok(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${label}`);
    console.log(`       ${error.message}`);
  }
}

async function okAsync(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${label}`);
    console.log(`       ${error.message}`);
  }
}

const realFetch = globalThis.fetch;
/** 安装一个假的 fetch，记录调用；用完必须 restoreFetch()。 */
function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return calls;
}
function restoreFetch() {
  globalThis.fetch = realFetch;
}

/** 清掉 token 缓存：不然后面的用例会命中前一个用例留下的缓存，断言数量对不上。 */
async function clearTokenCache() {
  await rm(join(home, 'cache', 'baidu-speech-token.json'), { force: true });
}

const jsonResponse = (payload, headers = {}) =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });

// ── 1. 凭据优先级 ────────────────────────────────────────
console.log('=== 1. 凭据优先级 ===');

ok('未注入、环境变量为空 -> 未配置', () => {
  delete process.env.BAIDU_VOICE_API_KEY;
  delete process.env.BAIDU_VOICE_SECRET_KEY;
  setCredentialSource(null);
  assert.equal(currentCredentials(), undefined);
  assert.equal(baiduConfigured(), false);
});

ok('只有环境变量 -> 用环境变量', () => {
  setCredentialSource(null);
  process.env.BAIDU_VOICE_API_KEY = 'env-key';
  process.env.BAIDU_VOICE_SECRET_KEY = 'env-secret';
  assert.deepEqual(currentCredentials(), { apiKey: 'env-key', secretKey: 'env-secret' });
  assert.equal(baiduConfigured(), true);
});

ok('设置页配置优先于环境变量', () => {
  setCredentialSource(() => ({ apiKey: 'cfg-key', secretKey: 'cfg-secret' }));
  assert.deepEqual(currentCredentials(), { apiKey: 'cfg-key', secretKey: 'cfg-secret' });
});

ok('设置页只填了一半 -> 回落到环境变量', () => {
  setCredentialSource(() => ({ apiKey: 'cfg-key', secretKey: '' }));
  assert.deepEqual(currentCredentials(), { apiKey: 'env-key', secretKey: 'env-secret' });
});

ok('设置页读取抛异常 -> 安全回落到环境变量', () => {
  setCredentialSource(() => {
    throw new Error('boom');
  });
  assert.deepEqual(currentCredentials(), { apiKey: 'env-key', secretKey: 'env-secret' });
});

// ── 2. 合成 ─────────────────────────────────────────────
console.log('\n=== 2. 语音合成 ===');

const creds = { apiKey: 'k', secretKey: 's' };

await okAsync('合成成功：Token 换一次 + 音频一次', async () => {
  setCredentialSource(() => creds);
  const calls = mockFetch((url) => {
    if (url.includes('/oauth/2.0/token')) {
      return jsonResponse({ access_token: 'TOKEN-1', expires_in: 2592000 });
    }
    return new Response(Buffer.from('ID3fake-mp3'), {
      status: 200,
      headers: { 'content-type': 'audio/mp3' },
    });
  });
  try {
    const { audio, voice } = await synthesizeMp3({ text: '你好', voice: '1' }, creds);
    restoreFetch();
    assert.equal(voice, '1');
    assert.equal(audio.toString(), 'ID3fake-mp3');
    assert.equal(calls.length, 2, '一次换 token + 一次合成');
    const body = calls[1].init.body;
    assert.ok(body.includes('aue=3'), 'aue=3 才是 mp3');
    assert.ok(body.includes('per=1'), '发音人透传');
    assert.ok(body.includes('tok=TOKEN-1'), '带上换到的 token');
  } finally {
    restoreFetch();
  }
});

await okAsync('token 有缓存时不再换 token', async () => {
  const calls = mockFetch((url) => {
    if (url.includes('/oauth/2.0/token')) throw new Error('不该再换 token');
    return new Response(Buffer.from('mp3'), {
      status: 200,
      headers: { 'content-type': 'audio/mp3' },
    });
  });
  try {
    await synthesizeMp3({ text: '缓存复用' }, creds);
    restoreFetch();
    assert.equal(calls.length, 1, '只应该发合成请求');
  } finally {
    restoreFetch();
  }
});

await okAsync('合成参数越界会被夹到 0-15', async () => {
  const calls = mockFetch((url) => {
    if (url.includes('/oauth/2.0/token')) {
      return jsonResponse({ access_token: 'T', expires_in: 100 });
    }
    return new Response(Buffer.from('mp3'), {
      status: 200,
      headers: { 'content-type': 'audio/mp3' },
    });
  });
  try {
    await synthesizeMp3({ text: 'x', speed: 99, pitch: -5, volume: 3.7 }, creds);
    restoreFetch();
    const body = calls[calls.length - 1].init.body;
    assert.ok(body.includes('spd=15'), `speed 应夹到 15，实际 ${body}`);
    assert.ok(body.includes('pit=0'), 'pitch 应夹到 0');
    assert.ok(body.includes('vol=4'), 'volume 应四舍五入到 4');
  } finally {
    restoreFetch();
  }
});

await okAsync('合成返回 JSON 错误 -> 抛中文错误', async () => {
  await clearTokenCache();
  const calls = mockFetch((url) => {
    if (url.includes('/oauth/2.0/token')) {
      return jsonResponse({ access_token: 'T', expires_in: 100 });
    }
    return new Response(JSON.stringify({ err_no: 500, err_msg: '服务内部错误' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  try {
    await assert.rejects(
      () => synthesizeMp3({ text: 'x' }, creds),
      /百度语音合成失败（err_no=500）/,
    );
    restoreFetch();
    assert.ok(calls.length >= 2);
  } finally {
    restoreFetch();
  }
});

await okAsync('文本为空 / 超长 -> 本地直接拒绝（不发请求）', async () => {
  const calls = mockFetch(() => {
    throw new Error('不该发请求');
  });
  try {
    await assert.rejects(() => synthesizeMp3({ text: '   ' }, creds), /text 不能为空/);
    await assert.rejects(
      () => synthesizeMp3({ text: 'a'.repeat(2001) }, creds),
      /文本过长/,
    );
    restoreFetch();
    assert.equal(calls.length, 0);
  } finally {
    restoreFetch();
  }
});

ok('发音人表覆盖 5 个', () => {
  assert.deepEqual(Object.keys(TTS_VOICES).sort(), ['0', '1', '3', '4', '5003']);
});

// ── 3. 识别 ─────────────────────────────────────────────
console.log('\n=== 3. 语音识别 ===');

await okAsync('识别成功返回文本', async () => {
  const calls = mockFetch((url) => {
    if (url.includes('/oauth/2.0/token')) {
      return jsonResponse({ access_token: 'T', expires_in: 100 });
    }
    return jsonResponse({ err_no: 0, result: ['你好', '世界'] });
  });
  try {
    const text = await recognizeWav(Buffer.from([1, 2, 3]), 'zh', creds);
    restoreFetch();
    assert.equal(text, '你好世界');
    const body = JSON.parse(calls[calls.length - 1].init.body);
    assert.equal(body.dev_pid, 1537, 'zh -> 1537');
    assert.equal(body.rate, 16000);
    assert.equal(body.channel, 1);
  } finally {
    restoreFetch();
  }
});

await okAsync('识别错误码 -> 抛中文错误', async () => {
  const calls = mockFetch((url) => {
    if (url.includes('/oauth/2.0/token')) {
      return jsonResponse({ access_token: 'T', expires_in: 100 });
    }
    return jsonResponse({ err_no: 3301, err_msg: '音频质量差' });
  });
  try {
    await assert.rejects(
      () => recognizeWav(Buffer.from([1]), 'auto', creds),
      /百度语音识别失败（err_no=3301）/,
    );
    restoreFetch();
  } finally {
    restoreFetch();
  }
});

await okAsync('token 过期（3302）会强制刷新后重试一次', async () => {
  await clearTokenCache();
  let tokenCalls = 0;
  let speechCalls = 0;
  const calls = mockFetch((url) => {
    if (url.includes('/oauth/2.0/token')) {
      tokenCalls += 1;
      return jsonResponse({ access_token: `T${tokenCalls}`, expires_in: 100 });
    }
    speechCalls += 1;
    if (speechCalls === 1) return jsonResponse({ err_no: 3302, err_msg: 'token expired' });
    return jsonResponse({ err_no: 0, result: ['重试成功'] });
  });
  try {
    const text = await recognizeWav(Buffer.from([1]), 'auto', creds);
    restoreFetch();
    assert.equal(text, '重试成功');
    assert.equal(tokenCalls, 2, '应该重新换一次 token');
    assert.equal(speechCalls, 2, '识别请求发了两次');
    assert.ok(calls.length >= 3);
  } finally {
    restoreFetch();
  }
});

// ── 收尾 ─────────────────────────────────────────────────
setCredentialSource(null);
delete process.env.BAIDU_VOICE_API_KEY;
delete process.env.BAIDU_VOICE_SECRET_KEY;
await rm(home, { recursive: true, force: true });

console.log(`\n通过 ${passed} / ${passed + failed}`);
if (failed > 0) {
  console.log(`失败 ${failed} 项 ❌`);
  process.exit(1);
}
console.log('全部通过 ✅');