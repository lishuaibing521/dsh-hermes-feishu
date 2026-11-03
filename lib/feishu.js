// dsh-hermes-feishu — 飞书 Open API 客户端。
//
// 对应 Hermes 飞书适配器里 lark_oapi SDK 承担的那一层，但这里直接用
// fetch 调 REST，零第三方依赖（dsh 插件导入外部包容易被 cordis 跳过）。
//
// 覆盖的能力：
//   - tenant_access_token 获取 + 到期前自动刷新
//   - 发送 / 回复 / 更新 / 删除消息（text、interactive、post、image、file、audio、media）
//   - 上传图片、上传文件（含 opus 语音时长）
//   - 下载消息资源（图片 / 文件）
//   - 获取群信息
//
// 域名：feishu = open.feishu.cn；lark = open.larksuite.com。

const DOMAIN_BASE = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
};

/** 上传类型路由表（照抄 adapter.py 的常量）。 */
export const OPUS_UPLOAD_EXTENSIONS = new Set(['.ogg', '.opus']);
export const MEDIA_UPLOAD_EXTENSIONS = new Set(['.mp4', '.mov', '.avi', '.m4v']);
export const DOC_UPLOAD_TYPES = {
  '.pdf': 'pdf',
  '.doc': 'doc',
  '.docx': 'doc',
  '.xls': 'xls',
  '.xlsx': 'xls',
  '.ppt': 'ppt',
  '.pptx': 'ppt',
};
export const FILE_UPLOAD_TYPE = 'stream';

/** 扩展名 -> (file_type, message_type) */
export function resolveOutboundFileRouting(filePath) {
  const lower = String(filePath ?? '').toLowerCase();
  const dot = lower.lastIndexOf('.');
  const ext = dot >= 0 ? lower.slice(dot) : '';
  if (OPUS_UPLOAD_EXTENSIONS.has(ext)) return { fileType: 'opus', messageType: 'audio' };
  if (MEDIA_UPLOAD_EXTENSIONS.has(ext)) return { fileType: 'mp4', messageType: 'media' };
  if (DOC_UPLOAD_TYPES[ext]) return { fileType: DOC_UPLOAD_TYPES[ext], messageType: 'file' };
  return { fileType: FILE_UPLOAD_TYPE, messageType: 'file' };
}

/**
 * 解析 OGG/Opus 音频时长（毫秒）。
 * 末尾 granule position / 48000 Hz。非 OGG 或解析失败返回 0。
 * 对应 adapter.py 的 _get_audio_duration_ms。
 */
export function getAudioDurationMs(buffer) {
  try {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    let pos = 0;
    let lastGranule = 0;
    while (pos < buf.length - 27) {
      pos = buf.indexOf('OggS', pos);
      if (pos === -1 || pos + 27 > buf.length) break;
      const granule = buf.readBigInt64LE(pos + 6);
      const numSegments = buf[pos + 26];
      if (granule > 0n) lastGranule = Number(granule);
      if (pos + 27 + numSegments > buf.length) break;
      let sum = 0;
      for (let k = 0; k < numSegments; k += 1) sum += buf[pos + 27 + k];
      const advance = numSegments + sum;
      // 畸形页（0 段且 0 字节）会让 pos 原地踏步，必须主动前进，否则死循环
      if (advance <= 0) break;
      pos += advance;
    }
    return lastGranule > 0 ? Math.floor((lastGranule / 48000) * 1000) : 0;
  } catch {
    return 0;
  }
}

/** Open API 返回体校验：code !== 0 视为失败。 */
const MIME_BY_TYPE = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
  stream: 'application/octet-stream',
};

function unwrap(json, action) {
  if (!json || typeof json !== 'object') throw new Error(`${action}：飞书返回了空响应`);
  const code = json.code ?? json.StatusCode ?? 0;
  if (code !== 0) {
    const msg = json.msg ?? json.StatusMessage ?? '未知错误';
    throw new Error(`${action}失败（code=${code}）：${msg}`);
  }
  return json.data ?? json;
}

export class FeishuClient {
  /**
   * @param {object} options
   * @param {string} options.appId
   * @param {string} options.appSecret
   * @param {'feishu'|'lark'} [options.domain]
   * @param {string} [options.baseUrl] 自定义 Open API 根地址（代理场景）
   * @param {number} [options.timeoutMs]
   */
  constructor(options = {}) {
    this.appId = options.appId;
    this.appSecret = options.appSecret;
    const domain = options.domain === 'lark' ? 'lark' : 'feishu';
    this.baseUrl = (options.baseUrl || DOMAIN_BASE[domain]).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 30000;
    this._token = undefined;
    this._tokenExpiresAt = 0;
    this._tokenPromise = undefined;
  }

  /** 获取 tenant_access_token（带缓存 + 并发合并）。 */
  async tenantToken(force = false) {
    const now = Date.now();
    if (!force && this._token && now < this._tokenExpiresAt) return this._token;
    if (!force && this._tokenPromise) return this._tokenPromise;

    const run = async () => {
      const res = await this._request(
        '/open-apis/auth/v3/tenant_access_token/internal',
        { method: 'POST', body: { app_id: this.appId, app_secret: this.appSecret }, noAuth: true },
      );
      const json = await res.json().catch(() => null);
      const data = unwrap(json, '获取 tenant_access_token');
      const token = data.tenant_access_token;
      const expire = Number(data.expire ?? 7200);
      if (typeof token !== 'string' || token.length === 0) {
        throw new Error('获取 tenant_access_token 失败：响应里没有 token');
      }
      this._token = token;
      // 提前 5 分钟过期，避免边界情况
      this._tokenExpiresAt = Date.now() + Math.max(60, expire - 300) * 1000;
      return token;
    };

    this._tokenPromise = run().finally(() => {
      this._tokenPromise = undefined;
    });
    return this._tokenPromise;
  }

  /** 底层请求：自动带 Authorization，自动序列化 JSON body。 */
  async _request(path, { method = 'GET', body, headers = {}, noAuth = false, raw = false } = {}) {
    const url = `${this.baseUrl}${path}`;
    const init = {
      method,
      headers: { ...headers },
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (!noAuth) {
      const token = await this.tenantToken();
      init.headers.Authorization = `Bearer ${token}`;
    }
    if (body !== undefined && !raw) {
      init.headers['Content-Type'] = 'application/json; charset=utf-8';
      init.body = JSON.stringify(body);
    } else if (raw) {
      init.body = body;
    }
    const res = await fetch(url, init);
    return res;
  }

  /** 带自动重试的 JSON 调用（token 失效时刷新一次）。 */
  async _json(path, options = {}) {
    let res = await this._request(path, options);
    let json = await res.json().catch(() => null);

    // 99991663 / 99991661 = token 无效或过期，强制刷新重试一次
    if (json && [99991663, 99991661, 99991668].includes(json.code) && !options.noAuth && !options._retried) {
      await this.tenantToken(true);
      res = await this._request(path, { ...options, _retried: true });
      json = await res.json().catch(() => null);
    }
    return json;
  }

  /**
   * 发送消息。
   * @param {object} params
   * @param {string} params.receiveId 群 chat_id / 用户 open_id 等
   * @param {'chat_id'|'open_id'|'user_id'|'union_id'|'email'} [params.receiveIdType]
   * @param {string} params.msgType text | interactive | post | image | file | audio | media
   * @param {string} params.content 已序列化的 JSON 字符串
   * @param {string} [params.uuid] 幂等去重键
   */
  async sendMessage({ receiveId, receiveIdType = 'chat_id', msgType, content, uuid }) {
    const qs = new URLSearchParams({ receive_id_type: receiveIdType });
    const body = {
      receive_id: receiveId,
      msg_type: msgType,
      content,
    };
    if (uuid) body.uuid = uuid;
    const json = await this._json(`/open-apis/im/v1/messages?${qs}`, { method: 'POST', body });
    return unwrap(json, '发送消息');
  }

  /**
   * 回复某条消息（自动挂到该消息所在会话）。
   * @param {object} params
   * @param {string} params.messageId
   * @param {string} params.msgType
   * @param {string} params.content
   * @param {boolean} [params.replyInThread]
   */
  async replyMessage({ messageId, msgType, content, replyInThread = false }) {
    const body = { content, msg_type: msgType };
    if (replyInThread) body.reply_in_thread = true;
    const json = await this._json(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      method: 'POST',
      body,
    });
    return unwrap(json, '回复消息');
  }

  /** 更新（编辑）已发送的消息。只有卡片/文本支持。 */
  /**
   * 更新已发送的消息。
   * 飞书对两种消息用不同动词：卡片(interactive) 用 PATCH，文本用 PUT。
   */
  async updateMessage({ messageId, msgType, content }) {
    const method = msgType === 'interactive' ? 'PATCH' : 'PUT';
    const body = { msg_type: msgType, content };
    const json = await this._json(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
      method,
      body,
    });
    return unwrap(json, '更新消息');
  }

  /** 撤回消息。 */
  async deleteMessage({ messageId }) {
    const json = await this._json(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
      method: 'DELETE',
    });
    return unwrap(json, '撤回消息');
  }

  /** 读取单条消息内容。 */
  async getMessage({ messageId }) {
    const json = await this._json(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`);
    return unwrap(json, '读取消息');
  }

  /**
   * 上传图片，返回 image_key。
   * @param {object} params
   * @param {Buffer} params.buffer
   * @param {string} [params.fileName]
   * @param {'message'|'avatar'} [params.imageType]
   */
  async uploadImage({ buffer, fileName = 'image.png', imageType = 'message' }) {
    const form = new FormData();
    form.append('image_type', imageType);
    form.append('image', new Blob([buffer]), fileName);

    const res = await this._request('/open-apis/im/v1/images', {
      method: 'POST',
      body: form,
      raw: true,
      headers: {},
    });
    // 让 fetch 自己带 multipart boundary
    const json = await res.json().catch(() => null);
    const data = unwrap(json, '上传图片');
    if (!data.image_key) throw new Error('上传图片失败：响应里没有 image_key');
    return data.image_key;
  }

  /**
   * 上传文件，返回 file_key。
   * @param {object} params
   * @param {Buffer} params.buffer
   * @param {string} params.fileName
   * @param {string} params.fileType opus | mp4 | pdf | doc | xls | ppt | stream
   * @param {number} [params.durationMs] 仅 opus 需要
   */
  async uploadFile({ buffer, fileName, fileType, durationMs = 0 }) {
    const form = new FormData();
    form.append('file_type', fileType);
    form.append('file_name', fileName);
    // 飞书对 opus 语音要求 duration 必填；其余类型带上也无害。
    if (durationMs > 0) form.append('duration', String(durationMs));
    // 必须给明确的 Content-Type —— 没有它 Node 会发 application/octet-stream，
    // 飞书直接回 234001 Invalid request param。
    const mime =
      fileType === 'opus'
        ? 'audio/ogg'
        : fileType === 'mp4'
          ? 'video/mp4'
          : MIME_BY_TYPE[fileType] ?? 'application/octet-stream';
    form.append('file', new Blob([buffer], { type: mime }), fileName);

    const res = await this._request('/open-apis/im/v1/files', {
      method: 'POST',
      body: form,
      raw: true,
      headers: {},
    });
    const json = await res.json().catch(() => null);
    const data = unwrap(json, '上传文件');
    if (!data.file_key) throw new Error('上传文件失败：响应里没有 file_key');
    return data.file_key;
  }

  /**
   * 给消息加表情回复。返回 reaction_id（删的时候要用）。
   * 飞书 endpoint: POST /open-apis/im/v1/messages/:message_id/reactions
   */
  async addReaction({ messageId, emojiType }) {
    const json = await this._json(
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
      {
        method: 'POST',
        body: { reaction_type: { emoji_type: emojiType } },
      },
    );
    return unwrap(json, '添加表情回复');
  }

  /**
   * 删除表情回复。
   * DELETE /open-apis/im/v1/messages/:message_id/reactions/:reaction_id
   */
  async removeReaction({ messageId, reactionId }) {
    const json = await this._json(
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(reactionId)}`,
      { method: 'DELETE' },
    );
    return unwrap(json, '删除表情回复');
  }

  /**
   * 发送语音气泡。
   * 飞书要求 audio 消息的 file 是 48kHz 单声道 Ogg/Opus，上传时 file_type=opus
   * 且必须带 duration（毫秒），否则客户端会显示成 0 秒。
   * @param {object} params
   * @param {string} params.receiveId
   * @param {string} [params.receiveIdType]
   * @param {Buffer} params.buffer   Ogg/Opus 音频
   * @param {number} params.durationMs
   * @param {string} [params.fileName]
   */
  async sendAudio({ receiveId, receiveIdType = 'chat_id', buffer, durationMs, fileName = 'voice.opus' }) {
    const fileKey = await this.uploadFile({
      buffer,
      fileName,
      fileType: 'opus',
      durationMs,
    });
    const data = await this.sendMessage({
      receiveId,
      receiveIdType,
      msgType: 'audio',
      content: JSON.stringify({ file_key: fileKey }),
    });
    return { ...data, fileKey };
  }

  /**
   * 发送媒体（视频）。
   * @param {object} params
   * @param {string} params.receiveId
   * @param {Buffer} params.buffer
   * @param {number} params.durationMs
   * @param {string} [params.fileName]
   */
  async sendMedia({ receiveId, receiveIdType = 'chat_id', buffer, durationMs, fileName = 'video.mp4' }) {
    const fileKey = await this.uploadFile({
      buffer,
      fileName,
      fileType: 'mp4',
      durationMs,
    });
    return this.sendMessage({
      receiveId,
      receiveIdType,
      msgType: 'media',
      content: JSON.stringify({ file_key: fileKey }),
    });
  }

  /**
   * 下载消息里的资源（图片 / 文件）。
   * @param {object} params
   * @param {string} params.messageId
   * @param {string} params.fileKey
   * @param {'image'|'file'} [params.type]
   */
  async downloadResource({ messageId, fileKey, type = 'file' }) {
    const qs = new URLSearchParams({ type });
    const res = await this._request(
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?${qs}`,
      { method: 'GET' },
    );
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const json = await res.json().catch(() => null);
      unwrap(json, '下载资源');
      throw new Error('下载资源失败：飞书返回了 JSON 而不是文件');
    }
    return {
      buffer: Buffer.from(await res.arrayBuffer()),
      contentType,
    };
  }

  /** 获取群信息（群名、成员数等）。 */
  async getChatInfo(chatId) {
    const json = await this._json(`/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`);
    return unwrap(json, '获取群信息');
  }

  /** 查询机器人自身信息（open_id、名称）。 */
  async getBotInfo() {
    const json = await this._json('/open-apis/bot/v3/info');
    const data = unwrap(json, '获取机器人信息');
    // bot/v3/info 把结果放在 data.bot 里，其他接口是 data 本身
    return data?.bot ?? data;
  }
}

/** 便捷构造：从环境变量读取凭据。
 *
 * 变量名刻意不用 `DSH_` 前缀：dsh 把 `DSH_*` 一律视为「只能由启动环境设置」的
 * bootstrap 变量，写进 `.dsh/.env` 会让 dsh 直接启动失败。所以这里用
 * `FEISHU_PLUGIN_*` 前缀，`.env` 里可以正常配置。
 */
export function clientFromEnv(env = process.env, overrides = {}) {
  const appId =
    overrides.appId ?? env.FEISHU_PLUGIN_APP_ID ?? env.DSH_FEISHU_APP_ID ?? env.FEISHU_APP_ID;
  const appSecret =
    overrides.appSecret ??
    env.FEISHU_PLUGIN_APP_SECRET ??
    env.DSH_FEISHU_APP_SECRET ??
    env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error(
      '飞书凭据缺失：请在 .dsh/.env 里设置 FEISHU_PLUGIN_APP_ID / FEISHU_PLUGIN_APP_SECRET',
    );
  }
  return new FeishuClient({
    appId,
    appSecret,
    domain:
      overrides.domain ??
      env.FEISHU_PLUGIN_DOMAIN ??
      env.DSH_FEISHU_DOMAIN ??
      env.FEISHU_DOMAIN ??
      'feishu',
    baseUrl: overrides.baseUrl,
  });
}