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
 * @param {(event: object) => boolean|void} [options.onCardAction] 卡片按钮点击；返回 true 表示已消费
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
    // 卡片按钮点击（审批卡的「允许 / 拒绝」走这里）。
    // 必须同步返回 true 表示已消费，否则 SDK 会当未处理。
    [CardActionType]: (data) => {
      try {
        return onCardAction?.(data) === true;
      } catch (error) {
        onError?.(error instanceof Error ? error : new Error(String(error)));
        return false;
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
