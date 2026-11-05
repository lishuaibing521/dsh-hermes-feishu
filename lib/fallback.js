// dsh-hermes-feishu — 模型故障转移（同时适配 dsh 0.2.1 与 0.2.2+）。
//
// ## 为什么不能再无脑在 agent/request 里换模型
//
// dsh 0.2.2 起，`agent/request` 被降级为「只读观察 + 可调控制项」，
// 官方注释（runtime-types.d.ts）原文：
//
//   a replacement may adjust controls but **must keep the provider, model,
//   and reasoning effort selection** ... @deprecated Retained for existing
//   listeners; do not add new listeners.
//   Use agent.model.select() before step preparation for model choices.
//
// agent-loop 里是硬拦截：
//
//   if (proposedConfig.provider !== selection.provider || proposedConfig.model !== selection.model)
//     throw new Error(`... use agent.model.select() before step preparation`)
//
// 这个 throw 是 step 内部抛的，**不经过 agent/request-error**，
// 所以老代码在 0.2.2 上不但切不了模型，还会把整轮直接打死。
//
// ## 两代不同的实现路径
//
// 0.2.1（没有 agent.model）：
//   路由没被冻结 → `agent/request` 里直接改 provider/model，
//   `agent/request-error` 返回 { kind: 'retry' } 让 dsh 原地重发。这是老行为，照旧。
//
// 0.2.2（有 agent.model.select，官方通道）：
//   路由在 preStep 就定死（`const selection = this.model.current()`），
//   而重试循环是 `while (true) { prepareRequest(…, decision.selection, …) }` ——
//   同一个 step 内重发不会重新读 selection，所以「step 内换模型」彻底没了。
//   官方 select() 写的是**下一个 step** 的选择。
//
//   因此改到「轮」这一层：这一轮失败了，就用链上的下一个模型**重开一轮**。
//   - `agent/request-error`：判断值不值得切，值得就把游标 +1，然后交回 next()
//     （绝不返回 retry —— 原地重发只会用冻结的路由再失败一次）
//   - 驱动层（agent-session.js）在拿到失败结果后调 `shouldRetry(agent)`，
//     据此 `agent.model.select(next)` + 重新 followup 同一条消息
//
//   代价：会话里会多一条同样的用户消息；收益：上下文全保留，工具调用不重放。
//
// 只依赖 node: 内置，不 import @deepseek-ai/*。

/** 一次失败后最多往下切多少个模型（防止无限重试）。 */
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
  const fatal = ['CONTEXT_L', 'CONTENT_FILTER', 'INVALID_REQUEST', 'BAD_REQUEST', 'VALIDATION'];
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

/** 这个 agent 所在的 dsh 是否提供官方选模型通道（0.2.2+）。 */
function supportsModelSelect(agent) {
  return typeof agent?.model?.select === 'function';
}

/**
 * 判断一个错误是不是「路由被冻结」那个内部 throw。
 * 真撞上说明我们对 dsh 的假设又变了，重试没有意义。
 */
export function isRouteFrozenError(error) {
  const text = String(error?.message ?? error ?? '');
  return /agent\/request proposed|use agent\.model\.select\(\) before step preparation/i.test(text);
}

/**
 * 安装故障转移。
 *
 * @param {object} ctx 插件上下文（要有 on）
 * @param {object} options
 * @param {() => Array<{provider:string, model:string}>} options.getChain
 *        返回当前模型链（第一个是主模型）。每次调用都重新读，改配置立即生效。
 * @param {(msg:string, err?:any) => void} [options.log]
 */
export function installModelFallback(ctx, { getChain, log = () => {} }) {
  /** agentId -> 当前处在链上第几环（0 = 主模型） */
  const cursor = new Map();
  /** agentId -> { failure, retryable }。留给驱动层判断值不值得重试。 */
  const lastFailure = new Map();

  const chainOf = () => {
    const chain = getChain();
    return Array.isArray(chain) ? chain : [];
  };

  // ── 0.2.1 专用：在请求层直接改写路由 ──────────────────────
  // 0.2.2+ 这里必须原样返回，否则会触发 step 内部的 throw。
  const offRequest = ctx.on('agent/request', async function (payload, next) {
    // 先让后面的监听器跑完，拿到它认为该用的配置
    const inherited = await next();

    const agent = payload?.agent;
    if (supportsModelSelect(agent)) {
      // 新版：路由由 model.select() 决定，这里一个字都不能改
      return inherited;
    }

    const chain = chainOf();
    if (chain.length <= 1) return inherited;

    const id = agent?.id ?? '';
    const idx = Math.min(cursor.get(id) ?? 0, chain.length - 1);
    if (idx === 0) return inherited;              // 主模型：不干预
    const want = chain[idx];
    if (!want) return inherited;

    if (inherited.provider !== want.provider || inherited.model !== want.model) {
      log(`[fallback] 请求改用备用模型 ${want.provider}/${want.model}（第 ${idx + 1}/${chain.length} 环）`);
    }
    // 保留其它控制项（reasoningEffort / maxTokens 等），只换路由
    return { ...inherited, provider: want.provider, model: want.model };
  });

  // ── 失败处理：两代共用「推进游标」，返回动作不同 ──────────
  const offError = ctx.on('agent/request-error', async function (payload, next) {
    const chain = chainOf();
    if (chain.length <= 1) return next();

    const agent = payload?.agent;
    const id = agent?.id ?? '';
    if (!id) return next();

    const usedProvider = payload?.provider ?? '';
    const idx = Math.min(cursor.get(id) ?? 0, chain.length - 1);

    const giveUp = (why) => {
      log(`[fallback] ${why}`);
      lastFailure.set(id, { failure: payload?.failure, retryable: false });
      return next();
    };

    if (!shouldFallback(payload?.failure)) {
      return giveUp(`失败不可恢复（${payload?.failure?.code ?? 'unknown'}），不切备用`);
    }
    if (idx >= chain.length - 1) {
      return giveUp(`已到链尾 ${usedProvider}/${chain[idx]?.model}，没有更多备用`);
    }
    if (idx >= MAX_SHIFTS) {
      return giveUp('已达最大切换次数');
    }

    const nextRoute = chain[idx + 1];
    cursor.set(id, idx + 1);
    lastFailure.set(id, { failure: payload?.failure, retryable: true });

    if (supportsModelSelect(agent)) {
      log(
        `[fallback] ${usedProvider} 请求失败（${payload?.failure?.code ?? payload?.failure?.message ?? 'error'}）`
          + ` → 下一轮改用 ${nextRoute.provider}/${nextRoute.model}（第 ${idx + 2}/${chain.length} 环）`,
      );
      // 交回 next()：让这一轮正常收尾，由驱动层用新模型重开一轮。
      // 返回 retry 只会用冻结的路由再失败一次。
      return next();
    }

    // 0.2.1：原地重发，agent/request 会把路由换成链上游标指向的那个
    log(
      `[fallback] ${usedProvider} 请求失败（${payload?.failure?.code ?? payload?.failure?.message ?? 'error'}）`
        + ` → 切到 ${nextRoute.provider}/${nextRoute.model}（原地重试）`,
    );
    return { kind: 'retry' };
  });

  // dsh 抛错时会发 agent/error，把原因捞出来（request-error 有时拿不到 failure 细节）
  const offAgentError = ctx.on('agent/error', ({ agent, error }) => {
    const id = agent?.id;
    if (!id) return;

    if (isRouteFrozenError(error)) {
      // 不该出现。出现了说明 dsh 行为又变了，重试也没用，标记成不可重试。
      log(`[fallback] 检测到路由冻结错误，放弃重试：${String(error?.message ?? error).slice(0, 160)}`);
      lastFailure.set(id, {
        failure: { message: String(error?.message ?? error) },
        retryable: false,
      });
      return;
    }

    if (!lastFailure.has(id)) {
      lastFailure.set(id, {
        failure: { message: String(error?.message ?? error) },
        retryable: true,
      });
    }
  });

  /**
   * 本轮失败后问一句：要不要用下一个模型重开一轮？
   *
   * 只有 0.2.2+ 才走这条路（0.2.1 已经在 request-error 里原地重试过了）。
   *
   * @param {object} agent dsh 的 agent 实例
   * @returns {{retry: boolean, route?: {provider:string, model:string}, failure?: object}}
   */
  function shouldRetry(agent) {
    const id = agent?.id;
    if (!id) return { retry: false };
    if (!supportsModelSelect(agent)) return { retry: false };

    const chain = chainOf();
    if (chain.length <= 1) return { retry: false };

    const meta = lastFailure.get(id);
    if (!meta || !meta.retryable) return { retry: false, failure: meta?.failure };

    const idx = Math.min(cursor.get(id) ?? 0, chain.length - 1);
    // 游标还在 0 = 这次失败没有推进任何游标（不可切 / 已到链尾），别重试
    if (idx === 0) return { retry: false, failure: meta.failure };

    const route = chain[idx];
    if (!route) return { retry: false, failure: meta.failure };
    return { retry: true, route, failure: meta.failure };
  }

  /** 一轮真正结束（重试完 / 不再重试）后清状态，下轮从主模型开始。 */
  function reset(agentId) {
    if (agentId) {
      cursor.delete(agentId);
      lastFailure.delete(agentId);
    } else {
      cursor.clear();
      lastFailure.clear();
    }
  }

  /** 某 agent 当前处在链上第几环（0 = 主模型）。 */
  function currentIndex(agentId) {
    return cursor.get(agentId) ?? 0;
  }

  return {
    dispose() {
      for (const off of [offRequest, offError, offAgentError]) {
        try {
          off?.();
        } catch {
          /* ignore */
        }
      }
      cursor.clear();
      lastFailure.clear();
    },
    shouldRetry,
    reset,
    currentIndex,
    supportsModelSelect,
  };
}

export default installModelFallback;