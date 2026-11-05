// dsh-hermes-feishu — 发送方准入判定（消息侧与卡片回调侧共用一份口径）。
//
// 为什么单独抽出来：
//   消息侧（dispatch.js）早就按 dmPolicy / groupPolicy + allowFrom 做了准入，
//   但卡片回调那条路完全没校验 —— 群里任何成员点一下审批卡的「允许」，
//   就能放行一次 shell / 文件写操作，等于绕过整条准入链。
//   两处必须用同一套判断，否则改了一处另一处照旧漏。
//
// 只依赖 node: 内置与同目录的 config.js，不 import @deepseek-ai/*。

import { parseAllowFrom } from './config.js';

const POLICY_OPEN = 'open';
const POLICY_ALLOWLIST = 'allowlist';
const POLICY_DISABLED = 'disabled';

/**
 * 从卡片回调事件里取操作者身份。
 *
 * ⚠️ 两种字段形态都要认，这不是保守，是实测：
 *   - 走 `EventDispatcher.register()`（本插件用的就是这条）：SDK 的
 *     RequestHandle.parse() 把 v2 事件的 event 内容**平铺到顶层**，
 *     字段保持原始蛇形 —— `operator.open_id` / `context.open_chat_id`。
 *   - 走 SDK 另一条 LarkChannel 路径：会被 normalizeCardAction() 归一化成
 *     驼峰 —— `operator.openId` / 顶层 `chatId`。
 *
 * 只认一种的后果很严重：认错时身份为空 → 命中「无身份一律拒」→
 * 所有审批卡/提问卡都点不动，功能直接死掉。所以两种都收。
 *
 * @param {object} event 卡片回调事件
 * @returns {{openId: string, userId: string, unionId: string, chatId: string, messageId: string}}
 */
export function actorOfCardEvent(event) {
  const op = event?.operator ?? event?.user ?? {};
  const ctx = event?.context ?? {};

  const pick = (...values) => {
    for (const v of values) {
      if (typeof v === 'string' && v) return v;
    }
    return '';
  };

  return {
    openId: pick(op.open_id, op.openId),
    userId: pick(op.user_id, op.userId),
    unionId: pick(op.union_id, op.unionId),
    chatId: pick(ctx.open_chat_id, event?.open_chat_id, event?.chatId),
    messageId: pick(ctx.open_message_id, event?.open_message_id, event?.messageId),
  };
}

/**
 * 从发送方（im.message.receive_v1 的 sender）取身份，字段布局与卡片回调不同。
 *
 * @param {object} sender 事件的 sender 对象
 * @returns {{openId: string, userId: string, unionId: string}}
 */
export function actorOfMessageSender(sender) {
  const sid = sender?.sender_id ?? {};
  return {
    openId: sid.open_id ?? '',
    userId: sid.user_id ?? '',
    unionId: sid.union_id ?? '',
  };
}

/**
 * 归一化准入策略。
 *
 * 卡片的 allowlist 取两套策略的「较严」那一个：
 *   回调事件里没有 chat_type，分不出群聊还是单聊。宁可多拦一次（用户看得见提示、
 *   把 open_id 填进白名单就好），也不能因为分不清就整体放行。
 *   只要有一侧是 allowlist，就按 allowlist 判；两侧都是 open 才整体放行。
 *
 * @param {{dmPolicy?: string, groupPolicy?: string}} runtime
 * @returns {{policy: string, allowFrom: string}}
 */
export function resolveCardPolicy(runtime = {}) {
  const dm = String(runtime.dmPolicy ?? POLICY_ALLOWLIST).toLowerCase();
  const group = String(runtime.groupPolicy ?? POLICY_ALLOWLIST).toLowerCase();

  if (dm === POLICY_DISABLED || group === POLICY_DISABLED) {
    return { policy: POLICY_DISABLED, allowFrom: String(runtime.allowFrom ?? '') };
  }
  if (dm === POLICY_ALLOWLIST || group === POLICY_ALLOWLIST) {
    return { policy: POLICY_ALLOWLIST, allowFrom: String(runtime.allowFrom ?? '') };
  }
  return { policy: POLICY_OPEN, allowFrom: String(runtime.allowFrom ?? '') };
}

/**
 * 判断一个操作者身份是否被准入策略放行。
 *
 * @param {{openId?: string, userId?: string, unionId?: string}} actor
 * @param {{dmPolicy?: string, groupPolicy?: string, allowFrom?: string}} runtime
 * @returns {{ok: boolean, reason: string, actor: object}}
 */
export function checkActor(actor, runtime = {}) {
  const { policy, allowFrom } = resolveCardPolicy(runtime);
  const ids = [actor?.openId, actor?.userId, actor?.unionId].filter(Boolean);

  if (policy === POLICY_DISABLED) {
    return { ok: false, reason: 'policy-disabled', actor };
  }

  // 拿不到身份就不能放行：无身份的点击无法归属，等同于陌生人。
  if (ids.length === 0) {
    return { ok: false, reason: 'no-identity', actor };
  }

  if (policy === POLICY_OPEN) {
    return { ok: true, reason: 'policy-open', actor };
  }

  const allowSet = parseAllowFrom(allowFrom);
  // parseAllowFrom 返回 null 表示填了 *，放行所有人。
  if (allowSet === null) {
    return { ok: true, reason: 'allow-all', actor };
  }
  // 空 Set = 一个人都不放行（空白名单），不能用 falsy 判断混过去。
  const ok = ids.some((id) => allowSet.has(id));
  return { ok, reason: ok ? 'allowlisted' : 'not-allowlisted', actor };
}

/** 把拒绝原因翻成给用户看的一句话（含 open_id，方便自举白名单）。 */
export function denyHint(result) {
  const id = result?.actor?.openId || result?.actor?.userId || '(取不到 open_id)';
  if (result?.reason === 'policy-disabled') return '该会话已禁用操作';
  if (result?.reason === 'no-identity') return '取不到你的飞书身份，无法校验权限';
  return `你不在白名单内（open_id=${id}）`;
}

export { POLICY_OPEN, POLICY_ALLOWLIST, POLICY_DISABLED };
