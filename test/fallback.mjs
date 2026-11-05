// 模型故障转移的两代适配回归测试。
//
// 要证明的核心事实：
//   0.2.1（agent 没有 model.select）：agent/request 里照旧改路由，
//      request-error 返回 { kind: 'retry' } 原地重发。
//   0.2.2+（agent.model.select 存在）：agent/request 里**一个字都不能改**，
//      request-error 不能返回 retry（否则用冻结路由再失败一次），
//      而是推进游标，让驱动层用 shouldRetry() 换模型重开一轮。
//
// 运行：node test/fallback.mjs

import assert from 'node:assert/strict';
import { installModelFallback, isRouteFrozenError } from '../lib/fallback.js';

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

const CHAIN = [
  { provider: 'p1', model: 'm-main' },
  { provider: 'p2', model: 'm-backup1' },
  { provider: 'p3', model: 'm-backup2' },
];

function fakeCtx() {
  const handlers = {};
  return {
    handlers,
    on(event, handler) {
      handlers[event] = handler;
      return () => {
        delete handlers[event];
      };
    },
  };
}

const agent0201 = { id: 'a1' };                       // 老版：没有 model
const agent0202 = { id: 'a1', model: { select() {} } }; // 新版：有 model.select

const success = { provider: 'p1', model: 'm-main', reasoningEffort: 'medium' };
const timeoutFailure = { code: 'ETIMEDOUT', message: 'request timed out', status: 0 };
const badRequest = { code: 'INVALID_REQUEST', message: 'bad params', status: 400 };

// ── 1. 0.2.1：照旧在请求层改路由 ─────────────────────────
console.log('=== 1. dsh 0.2.1 路径 ===');

{
  const ctx = fakeCtx();
  const fb = installModelFallback(ctx, { getChain: () => CHAIN, log: () => {} });

  await okAsync('0.2.1 主模型失败 -> request-error 返回 retry', async () => {
    const action = await ctx.handlers['agent/request-error'](
      { agent: agent0201, provider: 'p1', failure: timeoutFailure },
      async () => undefined,
    );
    assert.deepEqual(action, { kind: 'retry' });
  });

  await okAsync('0.2.1 第二轮 agent/request 把路由换成备用模型', async () => {
    const out = await ctx.handlers['agent/request'](
      { agent: agent0201 },
      async () => ({ ...success }),
    );
    assert.equal(out.provider, 'p2');
    assert.equal(out.model, 'm-backup1');
    // 其它控制项必须保留
    assert.equal(out.reasoningEffort, 'medium');
  });

  await okAsync('0.2.1 shouldRetry 恒为 false（已在原地重试过）', async () => {
    const v = fb.shouldRetry(agent0201);
    assert.equal(v.retry, false);
  });

  await okAsync('0.2.1 不可恢复的失败不返回 retry', async () => {
    fb.reset('a1');
    const action = await ctx.handlers['agent/request-error'](
      { agent: agent0201, provider: 'p1', failure: badRequest },
      async () => 'next-called',
    );
    assert.equal(action, 'next-called');
  });
}

// ── 2. 0.2.2：请求层绝不改路由 ───────────────────────────
console.log('\n=== 2. dsh 0.2.2+ 路径 ===');

{
  const ctx = fakeCtx();
  const fb = installModelFallback(ctx, { getChain: () => CHAIN, log: () => {} });

  await okAsync('0.2.2 agent/request 原样返回（不碰 provider/model）', async () => {
    const input = { provider: 'p1', model: 'm-main', reasoningEffort: 'medium', maxTokens: 4096 };
    const out = await ctx.handlers['agent/request']({ agent: agent0202 }, async () => input);
    assert.equal(out.provider, 'p1');
    assert.equal(out.model, 'm-main');
    assert.equal(out.reasoningEffort, 'medium');
    assert.equal(out.maxTokens, 4096);
  });

  await okAsync('0.2.2 推进游标后 agent/request 依然不改路由', async () => {
    await ctx.handlers['agent/request-error'](
      { agent: agent0202, provider: 'p1', failure: timeoutFailure },
      async () => undefined,
    );
    const out = await ctx.handlers['agent/request']({ agent: agent0202 }, async () => ({ ...success }));
    assert.equal(out.provider, 'p1', '新版必须保持路由不变，否则 dsh 会 throw');
    assert.equal(out.model, 'm-main');
  });

  await okAsync('0.2.2 request-error 不返回 retry（返回 next 的结果）', async () => {
    fb.reset('a1');
    const action = await ctx.handlers['agent/request-error'](
      { agent: agent0202, provider: 'p1', failure: timeoutFailure },
      async () => 'continued',
    );
    assert.equal(action, 'continued', '返回 retry 会用冻结路由再失败一次');
  });

  await okAsync('0.2.2 shouldRetry 给出下一个模型', async () => {
    const v = fb.shouldRetry(agent0202);
    assert.equal(v.retry, true);
    assert.equal(v.route.provider, 'p2');
    assert.equal(v.route.model, 'm-backup1');
  });

  await okAsync('0.2.2 连续失败逐个推进到链尾', async () => {
    fb.reset('a1');
    await ctx.handlers['agent/request-error'](
      { agent: agent0202, provider: 'p1', failure: timeoutFailure },
      async () => undefined,
    );
    let v = fb.shouldRetry(agent0202);
    assert.equal(v.route.model, 'm-backup1');
    assert.equal(fb.currentIndex('a1'), 1);

    await ctx.handlers['agent/request-error'](
      { agent: agent0202, provider: 'p2', failure: timeoutFailure },
      async () => undefined,
    );
    v = fb.shouldRetry(agent0202);
    assert.equal(v.route.model, 'm-backup2');
    assert.equal(fb.currentIndex('a1'), 2);

    // 到链尾后再失败 -> 不再重试
    await ctx.handlers['agent/request-error'](
      { agent: agent0202, provider: 'p3', failure: timeoutFailure },
      async () => undefined,
    );
    v = fb.shouldRetry(agent0202);
    assert.equal(v.retry, false);
  });

  await okAsync('不可恢复的失败不推进游标', async () => {
    fb.reset('a1');
    await ctx.handlers['agent/request-error'](
      { agent: agent0202, provider: 'p1', failure: badRequest },
      async () => undefined,
    );
    assert.equal(fb.currentIndex('a1'), 0);
    assert.equal(fb.shouldRetry(agent0202).retry, false);
  });

  await okAsync('reset 后回到主模型', async () => {
    fb.reset('a1');
    assert.equal(fb.currentIndex('a1'), 0);
    assert.equal(fb.shouldRetry(agent0202).retry, false);
  });
}

// ── 3. 路由冻结错误识别 ──────────────────────────────────
console.log('\n=== 3. 路由冻结错误识别 ===');

ok('识别 dsh 的 throw 文案', () => {
  assert.equal(
    isRouteFrozenError(
      new Error(
        'agent "x": agent/request proposed "p2/m" after step preparation fixed "p1/m"; '
          + 'use agent.model.select() before step preparation',
      ),
    ),
    true,
  );
});

ok('普通错误不误判', () => {
  assert.equal(isRouteFrozenError(new Error('request timed out')), false);
  assert.equal(isRouteFrozenError(undefined), false);
});

ok('冻结错误会被标成不可重试', () => {
  const ctx = fakeCtx();
  const fb = installModelFallback(ctx, { getChain: () => CHAIN, log: () => {} });
  ctx.handlers['agent/error']({
    agent: agent0202,
    error: new Error('agent/request proposed "x/y" ... use agent.model.select() before step preparation'),
  });
  // 先制造一次可切换的失败
  ctx.handlers['agent/request-error'](
    { agent: agent0202, provider: 'p1', failure: timeoutFailure },
    async () => undefined,
  );
  // 冻结错误把状态覆盖成 retryable=false
  ctx.handlers['agent/error']({
    agent: agent0202,
    error: new Error('agent "a1": agent/request proposed "p2/m" after step preparation'),
  });
  assert.equal(fb.shouldRetry(agent0202).retry, false);
});

// ── 4. 单模型链不启用 ────────────────────────────────────
console.log('\n=== 4. 边界 ===');

{
  const ctx = fakeCtx();
  installModelFallback(ctx, { getChain: () => [{ provider: 'p', model: 'm' }], log: () => {} });
  await okAsync('链长 <= 1 时不推进游标', async () => {
    const out = await ctx.handlers['agent/request-error'](
      { agent: agent0202, provider: 'p', failure: timeoutFailure },
      async () => 'next-called',
    );
    assert.equal(out, 'next-called');
  });
}

console.log(`\n通过 ${passed} / ${passed + failed}`);
if (failed > 0) {
  console.log(`失败 ${failed} 项 ❌`);
  process.exit(1);
}
console.log('全部通过 ✅');
