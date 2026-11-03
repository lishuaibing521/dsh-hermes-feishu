// dsh-hermes-feishu — 入站长连接。
//
// 用飞书官方 SDK 的 WSClient + EventDispatcher 订阅 im.message.receive_v1，
// 收到消息后交给回调处理。这一层只负责「拿到事件」，不碰 agent。
//
// ⚠️ 同一个飞书应用同时只允许一条长连接。启用本模块前必须先停掉
// dsh-lark-bot 桥，否则两边会抢连接（表现为其中一边收不到消息）。
import * as lark from '@larksuiteoapi/node-sdk';

const EventType = 'im.message.receive_v1';
const CardActionType = 'card.action.trigger';

/**
 * 创建并启动长连接。
 *
 * @param {object} options
 * @param {string} options.appId
 * @param {string} options.appSecret
 * @param {'feishu'|'lark'} [options.domain]
 * @param {(event: object) => void|Promise<void>} options.onMessage 收到消息时的回调
 * @param {(event: object) => object|void} [options.onCardAction] 卡片按钮点击；返回飞书卡片回调响应对象（如 { toast }），返回空表示不额外回应
 * @param {(err: Error) => void} [options.onError]
 * @param {(info: object) => void} [options.onReady]
 * @returns {{ close: () => void, wsClient: object }}
 */
export function startInbound({
  appId,
  appSecret,
  domain = 'feishu',
  onMessage,
  onCardAction,
  onError,
  onReady,
}) {
  if (!appId || !appSecret) {
    throw new Error('入站长连接缺少凭据：需要 appId / appSecret');
  }

  const baseConfig =
    domain === 'lark' ? { domain: lark.Domain.Lark } : { domain: lark.Domain.Feishu };

  const wsClient = new lark.WSClient({
    appId,
    appSecret,
    ...baseConfig,
    loggerLevel: lark.LoggerLevel.warn,
    autoReconnect: true,
  });

  const dispatcher = new lark.EventDispatcher({}).register({
    [EventType]: async (data) => {
      try {
        await onMessage?.(data);
      } catch (error) {
        onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    },
    // 卡片按钮点击（审批卡 / 提问卡走这里）。
    //
    // ⚠️ 返回值会被 SDK 原样序列化 + base64 回传给飞书，作为卡片回调的响应体。
    // 所以这里必须返回飞书认的响应对象（例如 { toast: {...} }）。
    // 以前返回布尔 true，飞书收到 "true" 这种非法响应体，就会在客户端弹错误提示
    // —— 明明处理成功了，用户却看到报错。
    // 返回 undefined 表示「已消费但不额外回应」，SDK 会回一个干净的空响应。
    [CardActionType]: (data) => {
      try {
        const result = onCardAction?.(data);
        return result && typeof result === 'object' ? result : undefined;
      } catch (error) {
        onError?.(error instanceof Error ? error : new Error(String(error)));
        // 出错也别回非法响应体，否则用户看到一个说不清的错误提示
        return { toast: { type: 'error', content: '处理失败，请查看日志' } };
      }
    },
  });

  wsClient.start({ eventDispatcher: dispatcher }).then(
    () => onReady?.({ ok: true }),
    (error) => onError?.(error instanceof Error ? error : new Error(String(error))),
  );

  return {
    wsClient,
    close: () => {
      try {
        wsClient.close?.();
      } catch {
        // 关闭失败不影响退出
      }
    },
  };
}

/**
 * 从 im.message.receive_v1 事件里抽出我们关心的字段。
 * 结构见飞书文档「接收消息」事件。
 */
export function extractMessage(event) {
  const msg = event?.message ?? {};
  const sender = event?.sender ?? {};
  return {
    messageId: msg.message_id ?? '',
    chatId: msg.chat_id ?? '',
    chatType: msg.chat_type ?? '',        // p2p / group
    messageType: msg.message_type ?? '',  // text / post / image / ...
    content: msg.content ?? '',           // JSON 字符串
    mentions: msg.mentions ?? [],
    createTime: msg.create_time ?? '',
    rootId: msg.root_id ?? '',
    parentId: msg.parent_id ?? '',
    threadId: msg.thread_id ?? '',
    senderOpenId: sender.sender_id?.open_id ?? '',
    senderUserId: sender.sender_id?.user_id ?? '',
    senderUnionId: sender.sender_id?.union_id ?? '',
    senderType: sender.sender_type ?? '', // user / app
    tenantKey: event?.tenant_key ?? '',
    eventId: event?.event_id ?? '',
  };
}
