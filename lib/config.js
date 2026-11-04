// dsh-hermes-feishu — 配置 schema（schemastery）。
//
// 用 @deepseek-ai/schemastery 定义 Config，由 dsh 的 settings 服务
// 在 Web 设置页自动生成表单（ctx.settings.configure({ auto: true })）。
//
// 🔴 关键：每个要出现在设置页的字段都必须标 volatile。
// dsh-settings 的 describe() 会先跑 volatileForm(schema)，它只保留
// 「自己或祖先带 meta.volatile」的字段；一个都没有就返回 undefined，
// 整个条目从设置页里消失（不报错，纯静默）。
// xdpool 的 asVolatile() 就是干这个的，这里照抄。
import z from '@deepseek-ai/schemastery';

/**
 * 标记字段为 live —— 不标就不出现在设置页。
 *
 * ⚠️ 标了 volatile 的字段，cordis 校验后交给我们的是**引用对象**
 * `{ get(): T, [write](v) }`（cosmokit 的 createVolatile），不是裸值。
 * 直接 `config.agentModel` 拿到的是 `{}`，所以读配置一律走 unwrapDeep()。
 */
function live(schema) {
  return typeof schema.volatile === 'function' ? schema.volatile() : schema;
}

/** 剥一层 volatile 引用。 */
function unwrap(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function' && !Array.isArray(value)) {
    try {
      return value.get();
    } catch {
      return value;
    }
  }
  return value;
}

/** 递归解包整份配置。 */
export function unwrapDeep(value) {
  const peeled = unwrap(value);
  if (Array.isArray(peeled)) return peeled.map((entry) => unwrapDeep(entry));
  if (peeled !== null && typeof peeled === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(peeled)) out[key] = unwrapDeep(entry);
    return out;
  }
  return peeled;
}

/**
 * ⚠️ 备用模型链**故意用字符串**而不是 z.array()。
 *
 * 踩过的两个坑（都会让插件整个加载失败 / 字段消失）：
 *  1. 数组元素标 volatile → cordis 报「volatile fields require a fixed object
 *     path without an enclosing volatile field」，插件不激活；
 *  2. 数组本身标 volatile → `~standard`.validate() 直接返回空对象 `{}`，
 *     数组结构被 volatile 包装破坏，配置读出来是空的。
 *
 * 所以用 CSV 字符串：`providerA/modelA, providerB/modelB`。
 */

/** 解析备用模型链字符串。同时兼容 cordis.patch.yml 里写成数组的老格式。 */
export function parseFallbackSpec(spec) {
  if (Array.isArray(spec)) {
    return spec
      .filter((x) => x && typeof x === 'object' && x.provider && x.model)
      .map((x) => ({ provider: String(x.provider), model: String(x.model) }));
  }
  if (typeof spec !== 'string') return [];
  return spec
    .split(',')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const idx = chunk.indexOf('/');
      if (idx <= 0) return null;
      const provider = chunk.slice(0, idx).trim();
      const model = chunk.slice(idx + 1).trim();
      return provider && model ? { provider, model } : null;
    })
    .filter(Boolean);
}

/**
 * 解析准入白名单（CSV，逗号分隔，全角逗号也认）。
 *
 * 返回 null 表示「放行所有人」（*），空 Set 表示「一个人都不放行」——
 * 两者语义完全不同，别用 falsy 判断混起来。
 */
export function parseAllowFrom(spec) {
  const list = String(spec ?? '')
    .split(/[,，\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (list.includes('*')) return null;
  return new Set(list);
}

/** 插件配置。 */
export const Config = z.object({
  // ── 飞书应用 ────────────────────────────────────────────────
  appId: live(z.string().description('飞书应用 App ID')),
  appSecret: live(z.string().role('secret').description('飞书应用 App Secret')),
  domain: live(
    z
      .union(['feishu', 'lark'])
      .default('feishu')
      .description('飞书（feishu）还是国际版 Lark（lark）'),
  ),
  botName: live(z.string().default('AI 助手').description('卡片标题里显示的机器人名')),
  defaultChatId: live(z.string().description('主动发送时的默认会话 chat_id')),
  defaultReceiveIdType: live(
    z
      .union(['chat_id', 'open_id', 'user_id', 'union_id', 'email'])
      .default('chat_id')
      .description('默认收件人 id 类型'),
  ),

  // ── Agent ───────────────────────────────────────────────────
  agentProvider: live(z.string().default('tokenbridge').description('主模型 provider')),
  agentModel: live(z.string().default('deepseek-flash').description('主模型 id')),
  fallbackModels: live(
    z
      .string()
      .default('')
      .description(
        '备用模型链（逗号分隔，格式 provider/model）。主模型请求失败时按顺序切换，切完仍失败才报错。例：tokenbridge/qwen3.8-flash-next, localtoken/glm-5.3-flash。留空 = 不启用。',
      ),
  ),
  agentMode: live(
    z
      .union(['inprocess', 'headless'])
      .default('inprocess')
      .description('inprocess = 进程内常驻 agent（支持执行中插入）；headless = 每次 spawn 子进程'),
  ),

  // ── 进度气泡 ────────────────────────────────────────────────
  thinkingEnabled: live(z.boolean().default(false).description('进度气泡里显示模型的思考过程（💬）')),
  thinkingFilterUserEcho: live(
    z
      .boolean()
      .default(true)
      .description('隐藏「用户说了什么」这类复述性思考（只匹配思考开头）'),
  ),
  toolPreviewChars: live(
    z
      .number()
      .role('slider')
      .min(20)
      .max(200)
      .step(10)
      .default(60)
      .description('工具调用参数的预览长度上限（字符）'),
  ),

  // ── 入站 ────────────────────────────────────────────────────
  sttProvider: live(
    z.string().default('baidu').description('语音识别 provider：从 dsh 的 speechToText 服务动态取，见设置页下拉'),
  ),
  sttLanguage: live(
    z.string().default('auto').description('语音识别语言，可选项由所选 provider 的 languages 决定'),
  ),
  ttsTool: live(
    z.string().default('').description('TTS 工具名：从已注册的 TTS 插件工具动态取，留空自动选第一个'),
  ),
  ttsArgs: live(
    z.string().default('').description('传给 TTS 工具的参数（JSON 对象），按该工具的 inputSchema 填；留空用它的默认值'),
  ),
  inbound: live(
    z.boolean().default(false).description('是否建立飞书长连接收消息（同一应用只能有一条）'),
  ),
  inboundProfile: live(
    z.string().default('headless').description('入站消息用哪个 dsh profile 跑 agent'),
  ),

  // ── 发送方准入（安全）────────────────────────────────────────
  //
  // 🔴 没有这几项时，任何能给机器人发消息的飞书成员都能驱动 agent，
  //    用的是本机的模型额度、文件权限和 shell 执行权限 —— 等于把机器交出去。
  //    默认必须是拒绝（allowlist），不能为了"开箱即用"默认 open。
  dmPolicy: live(
    z
      .union(['open', 'allowlist', 'disabled'])
      .default('allowlist')
      .description(
        '单聊策略：open = 任何人都能私聊驱动 agent（危险）；allowlist = 只放行 allowFrom 里的用户；disabled = 忽略所有单聊',
      ),
  ),
  groupPolicy: live(
    z
      .union(['open', 'allowlist', 'disabled'])
      .default('allowlist')
      .description(
        '群聊策略：open = 群里被 @ 就响应（危险）；allowlist = 只放行 allowFrom 里的用户；disabled = 忽略所有群聊',
      ),
  ),
  allowFrom: live(
    z
      .string()
      .default('')
      .description(
        '允许的发送方 ID（逗号分隔，填 open_id，形如 ou_xxx）。allowlist 策略下留空 = 谁都不放行；填 * 表示放行所有人。查自己的 open_id：给机器人发条消息后看插件日志的 [deny] 行。',
      ),
  ),
});

/** 把配置里的主模型 + 备用链拼成一条完整链（主模型排第一）。 */
export function buildModelChain(rawConfig = {}) {
  const config = unwrapDeep(rawConfig);
  const chain = [];
  const provider = config.agentProvider;
  const model = config.agentModel;
  if (provider && model) chain.push({ provider, model });
  for (const item of parseFallbackSpec(config.fallbackModels)) {
    // 去重：和已有条目相同的跳过
    if (chain.some((c) => c.provider === item.provider && c.model === item.model)) continue;
    chain.push({ provider: item.provider, model: item.model });
  }
  return chain;
}

export default Config;