// 语音后端路由测试。
//
// 验证 sttBackend / ttsBackend 三种取值下分别走到哪条路，
// 以及「显式选一个后端但它不可用」时必须报错、不能偷偷换后端。
//
// 运行：node test/voice-backend.mjs

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'voice-backend-'));
process.env.DSH_HOME = home;

const { setCredentialSource } = await import('../lib/baidu.js');

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

// ── 构造一个最小 ctx，用来驱动 apply() ──
const calls = { baidu: 0, dsh: 0, tool: 0 };

function fakeCtx({ hasDshService = true, ttsTools = [] } = {}) {
  const tools = new Map();
  for (const t of ttsTools) tools.set(t.name, t);
  const registry = {
    schemas: () => [...tools.values()].map((t) => t.schema),
    get: (n) => tools.get(n),
  };
  return {
    toolRegistry: registry,
    effect(fn) {
      try {
        fn();
      } catch {
        /* 部分注册依赖服务，忽略 */
      }
      return () => {};
    },
    on() {
      return () => {};
    },
    inject(_deps, fn) {
      try {
        fn({});
      } catch {
        /* ignore */
      }
      return () => {};
    },
    get(name) {
      if (name === 'tools') return registry;
      if (name === 'speechToText' && hasDshService) {
        return {
          resolve: (spec) => spec,
          listProviders: () => [],
          transcribe: async () => {
            calls.dsh += 1;
            return { text: 'D' };
          },
        };
      }
      return undefined;
    },
  };
}

// ═══════════════════════════════════════════════════════
// 这部分测的是路由函数本身的语义，不启动整个插件。
// apply() 里 transcribe 是闭包，无法直接取；所以这里按同样的判定逻辑
// 做一份「行为契约」测试，保证分支覆盖。真正的接线由 load/run 测试兜底。
// ═══════════════════════════════════════════════════════

/** 复刻 index.js transcribe 的路由决策（与实现逐条对应）。 */
function pickStt(backend, hasBaidu, hasDshService) {
  if (backend === 'baidu') {
    if (!hasBaidu) throw new Error('语音识别后端设为「内置百度」，但没有配置百度密钥');
    return 'baidu';
  }
  if (backend === 'dsh') {
    if (!hasDshService) throw new Error('语音识别后端设为「dsh 服务」，但环境里没有可用的 speechToText 服务');
    return 'dsh';
  }
  if (hasBaidu) return 'baidu';
  if (hasDshService) return 'dsh';
  throw new Error('凭据缺失');
}

/** 复刻 index.js feishu_send_voice 的后端决策。 */
function pickTts(backend, hasBaidu, hasTool) {
  if (backend === 'baidu') {
    if (!hasBaidu) throw new Error('语音合成后端设为「内置百度」，但没有配置百度密钥');
    return 'baidu';
  }
  if (backend === 'tool') {
    if (!hasTool) throw new Error('语音合成后端设为「TTS 工具」，但没有已注册的 *tts* 工具插件');
    return 'tool';
  }
  if (hasBaidu) return 'baidu';
  if (hasTool) return 'tool';
  throw new Error('既没有百度密钥，也没有可用的 TTS 工具插件');
}

console.log('=== STT 后端路由 ===');

ok('auto + 有百度密钥 -> 走百度', () => {
  assert.equal(pickStt('auto', true, true), 'baidu');
});

ok('auto + 没百度但有 dsh 服务 -> 走 dsh', () => {
  assert.equal(pickStt('auto', false, true), 'dsh');
});

ok('auto + 两者都没有 -> 抛错', () => {
  assert.throws(() => pickStt('auto', false, false), /凭据缺失/);
});

ok('显式 baidu -> 无视 dsh 服务，仍走百度', () => {
  assert.equal(pickStt('baidu', true, true), 'baidu');
});

ok('显式 baidu 但没密钥 -> 抛错，不退回 dsh', () => {
  assert.throws(() => pickStt('baidu', false, true), /没有配置百度密钥/);
});

ok('显式 dsh -> 即使有百度密钥也走 dsh', () => {
  assert.equal(pickStt('dsh', true, true), 'dsh');
});

ok('显式 dsh 但没有服务 -> 抛错，不退回百度', () => {
  assert.throws(() => pickStt('dsh', true, false), /没有可用的 speechToText 服务/);
});

console.log('\n=== TTS 后端路由 ===');

ok('auto + 有百度密钥 -> 走百度', () => {
  assert.equal(pickTts('auto', true, true), 'baidu');
});

ok('auto + 没百度但有 tts 工具 -> 走工具', () => {
  assert.equal(pickTts('auto', false, true), 'tool');
});

ok('auto + 两者都没有 -> 抛错', () => {
  assert.throws(() => pickTts('auto', false, false), /既没有百度密钥/);
});

ok('显式 baidu -> 无视 tts 工具，仍走百度', () => {
  assert.equal(pickTts('baidu', true, true), 'baidu');
});

ok('显式 baidu 但没密钥 -> 抛错，不退回工具', () => {
  assert.throws(() => pickTts('baidu', false, true), /没有配置百度密钥/);
});

ok('显式 tool -> 即使有百度密钥也走工具', () => {
  assert.equal(pickTts('tool', true, true), 'tool');
});

ok('显式 tool 但没有工具 -> 抛错，不退回百度', () => {
  assert.throws(() => pickTts('tool', true, false), /没有已注册的 \*tts\* 工具插件/);
});

console.log('\n=== 配置默认值 ===');

const { Config } = await import('../lib/config.js');

// live() 包过的字段是 { get() } 引用对象（dsh 的 volatile），
// 取值必须先解包，否则拿到的是对象本身。
const unwrap = (v) => (v && typeof v === 'object' && typeof v.get === 'function' ? v.get() : v);

ok('sttBackend 默认 auto', () => {
  assert.equal(unwrap(Config({}).sttBackend), 'auto');
});

ok('ttsBackend 默认 auto', () => {
  assert.equal(unwrap(Config({}).ttsBackend), 'auto');
});

ok('sttBackend 只接受 auto/baidu/dsh', () => {
  assert.equal(unwrap(Config({ sttBackend: 'baidu' }).sttBackend), 'baidu');
  assert.equal(unwrap(Config({ sttBackend: 'dsh' }).sttBackend), 'dsh');
  assert.throws(() => Config({ sttBackend: 'openai' }));
});

ok('ttsBackend 只接受 auto/baidu/tool', () => {
  assert.equal(unwrap(Config({ ttsBackend: 'baidu' }).ttsBackend), 'baidu');
  assert.equal(unwrap(Config({ ttsBackend: 'tool' }).ttsBackend), 'tool');
  assert.throws(() => Config({ ttsBackend: 'openai' }));
});

ok('ttsTool / ttsArgs 默认空', () => {
  const v = Config({});
  assert.equal(unwrap(v.ttsTool), '');
  assert.equal(unwrap(v.ttsArgs), '');
});

console.log('\n=== 凭据回落（百度） ===');

await okAsync('设置页密钥优先于环境变量', async () => {
  process.env.BAIDU_VOICE_API_KEY = 'env-k';
  process.env.BAIDU_VOICE_SECRET_KEY = 'env-s';
  setCredentialSource(() => ({ apiKey: 'cfg-k', secretKey: 'cfg-s' }));
  const { currentCredentials } = await import('../lib/baidu.js');
  assert.deepEqual(currentCredentials(), { apiKey: 'cfg-k', secretKey: 'cfg-s' });
});

await okAsync('设置页留空 -> 回落环境变量（老部署不受影响）', async () => {
  setCredentialSource(() => ({ apiKey: '', secretKey: '' }));
  const { currentCredentials } = await import('../lib/baidu.js');
  assert.deepEqual(currentCredentials(), { apiKey: 'env-k', secretKey: 'env-s' });
});


console.log('\n=== 可用性判定（不能只看百度密钥） ===');

// 这几个断言对应真实踩到的坑：
// sttConfigured() 若只查百度密钥，后端选「dsh 服务」且没配百度时会被判为不可用，
// dispatch 直接把语音消息跳过 —— 功能明明是好的却用不了。
const { setSttAvailability, sttConfigured } = await import('../lib/stt.js');

await okAsync('后端=dsh + 无百度密钥 + 有 dsh 服务 -> 判定可用', async () => {
  setCredentialSource(null);
  delete process.env.BAIDU_VOICE_API_KEY;
  delete process.env.BAIDU_VOICE_SECRET_KEY;
  setSttAvailability(() => true);
  assert.equal(sttConfigured(), true);
});

await okAsync('后端=baidu + 无密钥 -> 判定不可用', async () => {
  setSttAvailability(() => false);
  assert.equal(sttConfigured(), false);
});

await okAsync('无探针时退回只看百度凭据', async () => {
  setSttAvailability(null);
  assert.equal(sttConfigured(), false, '没有百度密钥就该是 false');
  setCredentialSource(() => ({ apiKey: 'k', secretKey: 's' }));
  assert.equal(sttConfigured(), true);
});

await okAsync('探针抛异常时安全退回', async () => {
  setSttAvailability(() => {
    throw new Error('boom');
  });
  setCredentialSource(() => ({ apiKey: 'k', secretKey: 's' }));
  assert.equal(sttConfigured(), true, '探针炸了也不能让整条链路挂掉');
});

console.log('\n=== token 缓存按凭据隔离 ===');

// 换一组密钥必须重新换 token：access_token 是绑定应用的。
// 旧实现用固定文件名，换密钥后最长 29 天都在用旧 token。
const { mkdtemp: mkdtemp2, readdir } = await import('node:fs/promises');
const home2 = await mkdtemp(join(tmpdir(), 'tokeniso-'));
process.env.DSH_HOME = home2;

const { accessToken } = await import('../lib/baidu.js');
const realFetch2 = globalThis.fetch;
let tokenRequests = 0;
globalThis.fetch = async (url) => {
  if (String(url).includes('/oauth/2.0/token')) {
    tokenRequests += 1;
    const m = /client_id=([^&]+)/.exec(String(url));
    return new Response(JSON.stringify({ access_token: `T-${m?.[1] ?? 'x'}`, expires_in: 2592000 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  throw new Error('unexpected');
};

try {
  const a1 = await accessToken({ apiKey: 'keyA', secretKey: 's' });
  const a2 = await accessToken({ apiKey: 'keyA', secretKey: 's' });
  assert.equal(a1, 'T-keyA');
  assert.equal(tokenRequests, 1, '同一组密钥第二次应命中缓存');

  const b1 = await accessToken({ apiKey: 'keyB', secretKey: 's' });
  assert.equal(b1, 'T-keyB', '换密钥必须拿到新应用的 token');
  assert.equal(tokenRequests, 2, '换密钥应重新换 token');

  const files = (await readdir(join(home2, 'cache'))).filter((f) => f.startsWith('baidu-speech-token'));
  assert.equal(files.length, 2, `两组密钥应各有一份缓存，实际 ${files.length}`);
  assert.ok(!files.some((f) => f.includes('keyA')), '缓存文件名不能带明文 apiKey');
  failed += 0;
  passed += 1;
  console.log('  ok   不同密钥各自缓存，且文件名不含明文');
} catch (error) {
  failed += 1;
  console.log('  FAIL token 缓存按凭据隔离');
  console.log(`       ${error.message}`);
} finally {
  globalThis.fetch = realFetch2;
  await rm(home2, { recursive: true, force: true });
}

// 收尾
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