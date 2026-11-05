// 卡片回调准入漏洞的专项回归测试。
//
// 修复前的真实漏洞：
//   群里任何人点审批卡的「允许」，就能放行一次 shell / 文件写操作 ——
//   card.action.trigger 回调完全绕过了消息侧的准入。
//
// 覆盖三层：
//   1. acl.js 判定函数（纯逻辑）
//   2. approval.handleCardAction 的门 1（白名单）与门 2（发起人绑定）
//   3. questions.handleCardAction 同样两道门
//
// 运行：node test/acl.mjs

import assert from 'node:assert/strict';
import { actorOfCardEvent, actorOfMessageSender, checkActor } from '../lib/acl.js';
import { createFeishuApproval } from '../lib/approval.js';
import { createFeishuQuestions } from '../lib/questions.js';

const OWNER = 'ou_owner_aaaaaaaaaaaaaaaaaaaa';
const STRANGER = 'ou_stranger_bbbbbbbbbbbbbbbb';

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

// ── 1. acl.js ─────────────────────────────────────────────
console.log('=== 1. acl 判定 ===');

ok('从卡片事件取到 operator 身份（蛇形，EventDispatcher 路径）', () => {
  const actor = actorOfCardEvent({
    operator: { open_id: OWNER, user_id: 'uid1', union_id: 'union1' },
    action: { value: { approval_id: 'x' } },
    context: { open_chat_id: 'oc_1', open_message_id: 'om_1' },
  });
  assert.equal(actor.openId, OWNER);
  assert.equal(actor.userId, 'uid1');
  assert.equal(actor.chatId, 'oc_1');
});

ok('从卡片事件取到 operator 身份（驼峰，LarkChannel 路径）', () => {
  const actor = actorOfCardEvent({
    operator: { openId: OWNER, userId: 'uid1' },
    action: { value: { approval_id: 'x' } },
    chatId: 'oc_2',
    messageId: 'om_2',
  });
  assert.equal(actor.openId, OWNER, '驼峰必须也能认，否则升级 SDK 后审批全点不动');
  assert.equal(actor.userId, 'uid1');
  assert.equal(actor.chatId, 'oc_2');
});

ok('两种形态都取不到时为空（走无身份拒绝）', () => {
  const actor = actorOfCardEvent({ operator: {} });
  assert.equal(actor.openId, '');
});

ok('operator 缺失时回退到 user 字段', () => {
  const actor = actorOfCardEvent({ user: { open_id: OWNER } });
  assert.equal(actor.openId, OWNER);
});

ok('从消息 sender 取身份', () => {
  const actor = actorOfMessageSender({ sender_id: { open_id: OWNER, user_id: 'u' } });
  assert.equal(actor.openId, OWNER);
});

ok('白名单内放行', () => {
  const v = checkActor({ openId: OWNER }, { dmPolicy: 'allowlist', groupPolicy: 'allowlist', allowFrom: OWNER });
  assert.equal(v.ok, true);
  assert.equal(v.reason, 'allowlisted');
});

ok('白名单外拒绝（这就是漏洞利用路径）', () => {
  const v = checkActor({ openId: STRANGER }, { dmPolicy: 'allowlist', groupPolicy: 'allowlist', allowFrom: OWNER });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'not-allowlisted');
});

ok('空白名单谁都拒（不能用 falsy 判断）', () => {
  const v = checkActor({ openId: OWNER }, { dmPolicy: 'allowlist', groupPolicy: 'allowlist', allowFrom: '' });
  assert.equal(v.ok, false);
});

ok('allowFrom=* 放行所有人', () => {
  const v = checkActor({ openId: STRANGER }, { dmPolicy: 'allowlist', groupPolicy: 'allowlist', allowFrom: '*' });
  assert.equal(v.ok, true);
});

ok('两侧策略都 open 才整体放行', () => {
  const v = checkActor({ openId: STRANGER }, { dmPolicy: 'open', groupPolicy: 'open', allowFrom: '' });
  assert.equal(v.ok, true);
});

ok('单侧 allowlist 就按 allowlist 判（严的一侧为准）', () => {
  const v = checkActor({ openId: STRANGER }, { dmPolicy: 'open', groupPolicy: 'allowlist', allowFrom: '' });
  assert.equal(v.ok, false);
});

ok('policy=disabled 一律拒', () => {
  const v = checkActor({ openId: OWNER }, { dmPolicy: 'disabled', groupPolicy: 'open', allowFrom: '*' });
  assert.equal(v.ok, false);
});

ok('取不到身份一律拒', () => {
  const v = checkActor({}, { dmPolicy: 'allowlist', groupPolicy: 'allowlist', allowFrom: '*' });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'no-identity');
});

// ── 造一个假的 cordis ctx：让 install() 挂上应答者 ────────
// 只需要 effect(注册函数) + on(事件, 处理函数)。
function fakeCtx() {
  const handlers = {};
  return {
    handlers,
    effect(fn) {
      fn();
      return () => {};
    },
    on(event, handler) {
      handlers[event] = handler;
      return () => {};
    },
  };
}

// 让 sendMessage 把卡片里的 id 抠出来，便于构造真实点击事件。
function captureClient() {
  const state = { sent: [], lastApprovalId: null, lastAskId: null };
  const client = {
    async sendMessage(args) {
      state.sent.push(args);
      try {
        const card = JSON.parse(args.content);
        for (const el of card.elements ?? []) {
          for (const action of el.actions ?? []) {
            if (action.value?.approval_id) state.lastApprovalId = action.value.approval_id;
            if (action.value?.ask_id) state.lastAskId = action.value.ask_id;
          }
        }
      } catch {
        /* 解析失败不影响测试 */
      }
      return { message_id: `om_${state.sent.length}` };
    },
    async updateMessage() {},
  };
  return { client, state };
}

// ── 2. approval ──────────────────────────────────────────
console.log('\n=== 2. 审批卡片回调 ===');

{
  const { client, state } = captureClient();
  const approval = createFeishuApproval({
    client,
    log: () => {},
    resolveChat: () => 'oc_chat',
    resolveOwner: () => ({ openId: OWNER }),
    checkActor: (actor) =>
      checkActor(actor, { dmPolicy: 'allowlist', groupPolicy: 'allowlist', allowFrom: OWNER }),
    timeoutMs: 60_000,
  });
  const ctx = fakeCtx();
  approval.install(ctx);

  // 触发一次真实审批请求 -> 发卡 -> pending 里有了真实 id
  const answer = ctx.handlers['approval/request']({ toolName: 'ops_bash' }, async () => 'next');
  await new Promise((r) => setTimeout(r, 30));

  ok('拿到真实 approval_id', () => {
    assert.equal(typeof state.lastApprovalId, 'string');
    assert.ok(state.lastApprovalId.length > 0);
  });

  ok('陌生人点击被门 1 拦下（denied），审批未被放行', () => {
    const r = approval.handleCardAction(
      { action: { value: { approval_id: state.lastApprovalId, decision: 'allow' } } },
      { openId: STRANGER },
    );
    assert.equal(r, 'denied');
    // 关键：pending 里这条还在（没被消费掉）
    assert.equal(approval.pending.has(state.lastApprovalId), true);
  });

  ok('取不到身份 -> denied', () => {
    const r = approval.handleCardAction(
      { action: { value: { approval_id: state.lastApprovalId, decision: 'allow' } } },
      {},
    );
    assert.equal(r, 'denied');
  });

  ok('发起人本人点击正常放行', () => {
    const r = approval.handleCardAction(
      { action: { value: { approval_id: state.lastApprovalId, decision: 'allow' } } },
      { openId: OWNER },
    );
    assert.equal(r, true);
  });

  const outcome = await answer;
  ok('审批结果是 allowed-once', () => {
    assert.equal(outcome, 'allowed-once');
  });

  ok('已结算的卡再点 -> expired', () => {
    const r = approval.handleCardAction(
      { action: { value: { approval_id: state.lastApprovalId, decision: 'allow' } } },
      { openId: OWNER },
    );
    assert.equal(r, 'expired');
  });

  ok('非审批卡点击返回 false（不误吞）', () => {
    const r = approval.handleCardAction({ action: { value: {} } }, { openId: OWNER });
    assert.equal(r, false);
  });
}

// ── 3. 门 2：白名单里有两个人，但只有发起人能点 ─────────
console.log('\n=== 3. 发起人绑定（门 2）===');

{
  const { client, state } = captureClient();
  const both = `${OWNER},${STRANGER}`;
  const approval = createFeishuApproval({
    client,
    log: () => {},
    resolveChat: () => 'oc_chat',
    resolveOwner: () => ({ openId: OWNER }),
    checkActor: (actor) =>
      checkActor(actor, { dmPolicy: 'allowlist', groupPolicy: 'allowlist', allowFrom: both }),
    timeoutMs: 60_000,
  });
  const ctx = fakeCtx();
  approval.install(ctx);
  const answer = ctx.handlers['approval/request']({ toolName: 'ops_bash' }, async () => 'next');
  await new Promise((r) => setTimeout(r, 30));

  ok('白名单内的非发起人点击被门 2 拦下', () => {
    const r = approval.handleCardAction(
      { action: { value: { approval_id: state.lastApprovalId, decision: 'allow' } } },
      { openId: STRANGER },
    );
    assert.equal(r, 'denied');
    assert.equal(approval.pending.has(state.lastApprovalId), true);
  });

  ok('发起人本人仍然可以点', () => {
    const r = approval.handleCardAction(
      { action: { value: { approval_id: state.lastApprovalId, decision: 'deny' } } },
      { openId: OWNER },
    );
    assert.equal(r, true);
  });

  const outcome = await answer;
  ok('结果是 rejected（按发起人的选择）', () => {
    assert.equal(outcome, 'rejected');
  });
}

// ── 4. questions ─────────────────────────────────────────
console.log('\n=== 4. 提问卡片回调 ===');

{
  const { client, state } = captureClient();
  const questions = createFeishuQuestions({
    client,
    log: () => {},
    resolveChat: () => 'oc_chat',
    resolveOwner: () => ({ openId: OWNER }),
    checkActor: (actor) =>
      checkActor(actor, { dmPolicy: 'allowlist', groupPolicy: 'allowlist', allowFrom: OWNER }),
    timeoutMs: 60_000,
  });
  const ctx = fakeCtx();
  questions.install(ctx);

  const req = {
    questions: [
      {
        id: 'q1',
        question: '选一个',
        options: [{ label: 'A' }, { label: 'B' }],
      },
    ],
  };
  const answer = ctx.handlers['user-questions/request'](req, async () => null);
  await new Promise((r) => setTimeout(r, 30));

  ok('拿到真实 ask_id', () => {
    assert.equal(typeof state.lastAskId, 'string');
    assert.ok(state.lastAskId.length > 0);
  });

  ok('陌生人作答被拦下', () => {
    const r = questions.handleCardAction(
      { action: { value: { ask_id: state.lastAskId, question_id: 'q1', option_index: 1 } } },
      { openId: STRANGER },
    );
    assert.equal(r, 'denied');
    assert.equal(questions.pending.has(state.lastAskId), true);
  });

  ok('取不到身份 -> denied', () => {
    const r = questions.handleCardAction(
      { action: { value: { ask_id: state.lastAskId, question_id: 'q1', option_index: 1 } } },
      {},
    );
    assert.equal(r, 'denied');
  });

  ok('发起人本人作答正常', () => {
    const r = questions.handleCardAction(
      { action: { value: { ask_id: state.lastAskId, question_id: 'q1', option_index: 1 } } },
      { openId: OWNER },
    );
    assert.equal(r, true);
  });

  const result = await answer;
  ok('答案是 B（发起人选的那个）', () => {
    assert.equal(result?.answers?.[0]?.selected?.[0], 'B');
  });

  ok('非提问卡点击返回 false', () => {
    const r = questions.handleCardAction({ action: { value: {} } }, { openId: OWNER });
    assert.equal(r, false);
  });
}

// 文字补答也是同一个口径：卡片只给发起人点，打字也不能例外。
// 必须用全新的实例 —— 上一个实例的问题已经被卡片答完并结算了。
{
  const { client } = captureClient();
  const questions = createFeishuQuestions({
    client,
    log: () => {},
    resolveChat: () => 'oc_chat',
    resolveOwner: () => ({ openId: OWNER }),
    checkActor: (actor) =>
      checkActor(actor, { dmPolicy: 'allowlist', groupPolicy: 'allowlist', allowFrom: `${OWNER},${STRANGER}` }),
    timeoutMs: 60_000,
  });
  const ctx = fakeCtx();
  questions.install(ctx);

  const req = {
    questions: [{ id: 'q1', question: '选一个', options: [{ label: 'A' }, { label: 'B' }] }],
  };
  void ctx.handlers['user-questions/request'](req, async () => null);
  await new Promise((r) => setTimeout(r, 30));

  ok('白名单内的非发起人用文字补答被拒', () => {
    const answered = questions.handleFreeText('oc_chat', '我替他回答', { openId: STRANGER });
    assert.equal(answered, false, '非发起人文字作答必须被拒绝');
  });

  ok('发起人本人用文字补答可以作答', () => {
    const answered = questions.handleFreeText('oc_chat', '我自己写的答案', { openId: OWNER });
    assert.equal(answered, true);
  });
}

console.log(`\n通过 ${passed} / ${passed + failed}`);
if (failed > 0) {
  console.log(`失败 ${failed} 项 ❌`);
  process.exit(1);
}
console.log('全部通过 ✅');
