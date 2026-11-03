// dsh-hermes-feishu — 模型故障转移（照 Hermes 的 fallback_chain 语义）。
//
// 利用 dsh 核心的两个 waterfall 事件：
//   agent/request       → 每次模型请求前决定用哪个 provider/model
//   agent/request-error → 请求失败时接管恢复，返回 { kind: 'retry' } 让它重试
//
// 比 Hermes 的做法更省事：不重建 agent、不重放用户消息，上下文全保留。
//
// waterfall 的 next() 会调用下一个监听器，最终返回最初提出的请求配置。
// 所以监听器不是「直接返回新配置」，而是「先取到下一个监听器的结果，
// 再和它比对，决定要不要换成备用的」。

/** 一次请求失败后，最多往下切多少个模型（防止无限重试）。 */
const MAX_SHIFTS = 8;

/**
 * 从失败信息里判断该不该切备用。
 * 认证失败、参数错误这类换了也没用的，不切。
 */
function shouldFallback(failure) {
  const code = String(failure?.code ?? '').toUpperCase();
  const status = Number(failure?.status ?? failure?.statusCode ?? 0);
  const message = String(failure?.message ?? '');

  // 明确不该切的：上下文超长、内容审核、参数错误
  const fatal = ['CONTEXT_LENGTH', 'CONTENT_FILTER', 'INVALID_REQUEST', 'BAD_REQUEST', 'VALIDATION'];
  if (fatal.some((f) => code.includes(f))) return false;

  // HTTP 状态：4xx 里只切 401/403/429，其余 4xx 是请求本身有问题
  if (status >= 400 && status < 500 && ![401, 403, 429].includes(status)) return false;

  // 剩下的（超时、连接失败、5xx、限流、额度耗尽）都值得切
  if (status >= 500) return true;
  if ([401, 403, 429].includes(status)) return true;
  if (/timeout|econnreset|enotfound|eai_again|fetch failed|socket hang up|rate.?limit|quota|exhausted|overloaded/i.test(message)) {
    return true;
  }
  // 没拿到明确信号时也切一次 —— 主模型已经失败了，换个模型试比直接报错强
  return true;
}

/**
 * 安装故障转移钩子。
 *
 * @param {object} ctx      插件上下文（要有 on）
 * @param {object} options
 * @param {() => Array<{provider:string, model:string}>} options.getChain
 *        返回当前模型链（第一个是主模型）。每次请求都重新读，所以改配置立即生效。
 * @param {(msg:string, err?:any) => void} [options.log]
 * @returns {() => void} 卸载函数
 */
export function installModelFallback(ctx, { getChain, log = () => {} }) {
  // 每个 agent 当前处在链上的第几环。key = agent.id
  // 请求成功一次就清掉，让它回到主模型。
  const cursor = new Map();
  // 最近一次「我们改成了哪个配置」，供 agent/request 复用。
  const pinned = new Map();

  const offRequest = ctx.on('agent/request', async function (payload, next) {
    const chain = getChain();
    if (chain.length <= 1) return next();

    const id = payload?.agent?.id ?? '';
    const idx = Math.min(cursor.get(id) ?? 0, chain.length - 1);
    const want = chain[idx];

    // 先让后面的监听器跑完，拿到它认为该用的配置，再决定覆盖与否。
    const inherited = await next();
    if (idx === 0) {
      // 主模型：不干预，除非别的监听器强行改了
      pinned.set(id, inherited);
      return inherited;
    }
    if (!want) return inherited;

    if (inherited.provider !== want.provider || inherited.model !== want.model) {
      log(`[fallback] agent=${id} 请求改用备用模型 ${want.provider}/${want.model}（第 ${idx + 1}/${chain.length} 环）`);
    }
    // 保留其它控制项（reasoningEffort / maxTokens 等），只换路由
    const merged = { ...inherited, provider: want.provider, model: want.model };
    pinned.set(id, merged);
    return merged;
  });

  const offError = ctx.on('agent/request-error', async function (payload, next) {
    const chain = getChain();
    if (chain.length <= 1) return next();

    const id = payload?.agent?.id ?? '';
    const usedProvider = payload?.provider ?? '';
    const idx = Math.min(cursor.get(id) ?? 0, chain.length - 1);

    if (!shouldFallback(payload?.failure)) {
      log(`[fallback] 失败不可恢复（${payload?.failure?.code ?? 'unknown'}），不切备用`);
      return next();
    }
    if (idx >= chain.length - 1) {
      log(`[fallback] 已到链尾 ${usedProvider}/${chain[idx]?.model}，没有更多备用`);
      return next();
    }
    if (idx >= MAX_SHIFTS) return next();

    const nextRoute = chain[idx + 1];
    cursor.set(id, idx + 1);
    log(
      `[fallback] ${usedProvider} 请求失败（${payload?.failure?.code ?? payload?.failure?.message ?? 'error'}）`
        + ` → 切到 ${nextRoute.provider}/${nextRoute.model}`,
    );
    // 不调 next()：我们自己接管恢复。返回 retry 让循环用新配置重发。
    return { kind: 'retry' };
  });

  /** 请求成功后回到主模型（由调用方在 turn 结束时调）。 */
  function reset(agentId) {
    if (agentId) cursor.delete(agentId);
    else cursor.clear();
  }

  /** 某 agent 当前处在链上第几环（0 = 主模型）。 */
  function currentIndex(agentId) {
    return cursor.get(agentId) ?? 0;
  }

  return {
    dispose() {
      try {
        offRequest?.();
      } catch {
        /* ignore */
      }
      try {
        offError?.();
      } catch {
        /* ignore */
      }
      cursor.clear();
      pinned.clear();
    },
    reset,
    currentIndex,
  };
}

export default installModelFallback;