// dsh-hermes-feishu — Web 设置页卡片（浏览器端插件）。
//
// dsh 官方 README 明确写着：`autoGenerate` 只是给「按 schema 生成页面」的客户端
// 用的标志，**当前没有任何官方客户端实现自动生成**。所以配置页必须自己写前端卡片，
// 跟 dsh-xdpool 一样挂在 `settings.section` 槽位上。
//
// 运行环境：浏览器里的 ModuleLoader。React 由宿主提供（require("react")），
// 不要 import @deepseek-ai/* —— 这里没有任何 Node 依赖。
//
// 交互约定：所有改动只写进**本地草稿**，点「保存」才落到 profile 配置。
// 这样误操作可以「重置」撤销，不会碰一下开关就把线上配置改了。
window.__ModuleLoader__.load({
  id: 'dsh-hermes-feishu',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');
    const jsx = require('react/jsx-runtime');

    const name = 'dsh-hermes-feishu-client';
    const inject = ['slots', 'locale'];
    /** 宿主 cordis.patch.yml 里的 entry id —— configForms 用它寻址。 */
    const ENTRY_ID = 'hermes-feishu';
    const LOCALE_NS = 'settings.hermes.feishu';
    /** host 半暴露的模型目录路由。 */
    const MODELS_URL = '/plugins/dsh-hermes-feishu/models';
    /** host 半暴露的媒体配置路由（image-gen + modlens）。 */
    const MEDIA_URL = '/plugins/dsh-hermes-feishu/media-config';
    const MEDIA_MODELS_URL = '/plugins/dsh-hermes-feishu/media-models';
    /** 联网搜索 provider 选择。 */
    const WEB_URL = '/plugins/dsh-hermes-feishu/web-config';
    const SEP = '/';

    // ── 文案 ────────────────────────────────────────────────────────────
    const zh = {
      navLabel: '飞书插件',
      intro: '飞书通道与 agent 的运行参数。改完点「保存」才生效，保存前可以随时「重置」。',
      secFeishu: '飞书应用',
      dmPolicy: '单聊策略',
      groupPolicy: '群聊策略',
      allowFrom: '允许的用户 ID',
      allowFromHint:
        '逗号分隔的 open_id，形如 ou_xxx。留空 = 谁都不放行（机器人不响应任何消息）；填 * = 放行所有人。'
        + '要看自己的 open_id：随便发条消息，机器人会静默拒绝，插件日志里有一行 [deny] 带着你的 open_id。',
      polOpen: 'open（任何人都能驱动，危险）',
      polAllowlist: 'allowlist（只放行白名单，默认）',
      polDisabled: 'disabled（该类会话一律忽略）',
      secAgent: 'Agent 与模型',
      secProgress: '进度气泡',
      secMedia: '媒体',
      imageGenProvider: '图片生成 Provider',
      imageGenModel: '图片生成模型',
      visionProvider: '识别 Provider',
      visionModel: '识别模型',
      mediaUnavailable: '（未检测到 image-gen / modlens 插件）',
      imageGenHead: '图片生成（dsh-image-gen）',
      secWeb: '联网搜索',
      webSearchProvider: '搜索 Provider',
      webFetchProvider: '抓取 Provider',
      webUnavailable: '（未检测到 web 运行时）',
      sttHead: '语音转文字',
      sttProvider: '识别 Provider',
      ttsProvider: '合成 Provider',
      sttNoProvider: '未注册 dsh 的识别服务（可选）；留空时本插件直接走内置百度识别',
      ttsNoProvider: '没有已注册的语音合成工具，请先装一个 TTS 插件（例如 dsh-baidu-tts）',
      ttsHead: '文字转语音',
      sttBackend: '识别后端',
      ttsBackend: '合成后端',
      backendAuto: '自动（谁可用用谁）',
      backendBaidu: '内置百度',
      backendDsh: 'dsh 服务',
      backendTool: 'TTS 工具插件',
      ttsTool: '合成工具',
      baiduApiKey: '百度 API Key',
      baiduSecretKey: '百度 Secret Key',
      credsHead: '百度语音凭据（识别 / 合成共用）',
      credsPlainText: '密钥明文显示，注意别截图外传',
      baiduKeyHint: '未填则回落到环境变量 BAIDU_VOICE_API_KEY / BAIDU_VOICE_SECRET_KEY',
      baiduObtainHint: '在百度智能云「语音技术 → 应用列表」里创建应用后获取这两个值，每月有免费额度；识别和合成都用它俩，填完保存即刻生效。后端选「dsh 服务」或「TTS 工具插件」时可以不填。',
      ttsVoice: '发音人',
      ttsSpeed: '语速',
      ttsPitch: '音调',
      ttsVolume: '音量',
      ttsLevelHint: '0-15，5 为正常',
      voiceCredsMissing: '还没有配置百度语音密钥，语音识别和合成都会不可用',
      voiceCredsOk: '百度语音凭据已配置',
      depMissing: '未安装',
      depInstalled: '已安装',
      depHowTo: '安装方式',
      depAfterInstall: '装完重启 dsh web 生效',
      sttLanguage: '识别语言',
      langAuto: '自动',
      langZh: '中文',
      langEn: '英文',
      langYue: '粤语',
      voiceHead: '语音设置',
      voiceSettingsHint: '改完点上面的「保存」即刻生效，无需重启。',
      hotApplyHint: '模型、备用链、思考显示、工具预览长度、语音这些保存即刻生效；App ID / App Secret / 域名改了要重启 dsh web。',
      visionHead: '媒体识别（ModLens）',
      noModelOptions: '拉不到模型列表，检查 Base URL 和密钥',
      appId: 'App ID',
      appSecret: 'App Secret',
      domain: '服务区域',
      domainFeishu: '中国版（feishu）',
      domainLark: '国际版（lark）',
      domainShortHint: '国内应用选中国版；飞书与 Lark 账号不互通',
      domainHint:
        '国内注册的飞书应用必须选「中国版」。飞书和 Lark 是两套独立的开放平台，App ID / Secret 不通用，选错会连不上、收不到消息。改动后需要重启 dsh web 才生效。',
      botName: '机器人名称',
      defaultChatId: '默认会话 chat_id',
      agentModel: 'Provider',
      agentModelModel: '主模型',
      fallbackModels: '备用模型链',
      fallbackHint: '主模型请求失败时按顺序往下切，切完仍失败才报错。留空 = 不启用。',
      addFallback: '+ 添加备用模型',
      remove: '删除这条',
      agentMode: 'Agent 模式',
      modeInprocess: 'inprocess（常驻，支持执行中插入）',
      modeHeadless: 'headless（每次起子进程）',
      thinkingEnabled: '显示思考过程',
      thinkingFilterUserEcho: '隐藏「用户说…」复述',
      toolPreviewChars: '工具参数预览长度',
      toolPreviewHint: '显示在进度气泡里的工具参数截断长度（20–200）',
      loading: '加载中…',
      save: '保存',
      reset: '重置',
      saving: '保存中…',
      unsaved: '有未保存的修改',
      saved: '已保存',
      saveFailed: '保存失败',
      catalogFailed: '模型列表加载失败',
      readonly: '当前配置文档只读',
      unavailable: '该配置未暴露给此客户端',
      pickProvider: '选择 Provider',
      pickModel: '选择模型',
    };
    const en = {
      navLabel: 'Feishu Plugin',
      intro: 'Feishu channel and agent runtime settings. Click Save to apply.',
      secFeishu: 'Feishu App',
      dmPolicy: 'Direct message policy',
      groupPolicy: 'Group policy',
      allowFrom: 'Allowed user IDs',
      allowFromHint:
        'Comma-separated open_id values, e.g. ou_xxx. Empty = nobody is allowed (the bot replies to no one); '
        + "'*' = allow everyone. To find your open_id: send any message; the bot silently rejects it and the "
        + 'plugin log prints a [deny] line containing your open_id.',
      polOpen: 'open (anyone can drive it — dangerous)',
      polAllowlist: 'allowlist (only listed users, default)',
      polDisabled: 'disabled (ignore this chat type entirely)',
      secAgent: 'Agent & Models',
      secProgress: 'Progress Bubble',
      secMedia: 'Media',
      imageGenProvider: 'Image provider',
      imageGenModel: 'Image model',
      visionProvider: 'Vision provider',
      visionModel: 'Vision model',
      mediaUnavailable: '(image-gen / modlens not detected)',
      imageGenHead: 'Image generation (dsh-image-gen)',
      secWeb: 'Web search',
      webSearchProvider: 'Search provider',
      webFetchProvider: 'Fetch provider',
      webUnavailable: '(web runtime not detected)',
      sttHead: 'Speech to text',
      sttProvider: 'STT provider',
      ttsProvider: 'Tool',
      sttNoProvider: 'No dsh speech service registered (optional) — the plugin uses built-in Baidu STT',
      ttsNoProvider: 'No TTS tool registered — install a TTS plugin (e.g. dsh-baidu-tts)',
      ttsHead: 'Text to speech',
      sttBackend: 'STT backend',
      ttsBackend: 'TTS backend',
      backendAuto: 'Auto (first available)',
      backendBaidu: 'Built-in Baidu',
      backendDsh: 'dsh service',
      backendTool: 'TTS tool plugin',
      ttsTool: 'TTS tool',
      baiduApiKey: 'Baidu API Key',
      baiduSecretKey: 'Baidu Secret Key',
      credsHead: 'Baidu voice credentials (shared by STT / TTS)',
      credsPlainText: 'Secrets are shown in plain text — avoid screenshots',
      baiduKeyHint: 'Falls back to BAIDU_VOICE_API_KEY / BAIDU_VOICE_SECRET_KEY when empty',
      baiduObtainHint: 'Create an app under Baidu Cloud "Speech → App list" to obtain both values — there is a monthly free quota. Used for both STT and TTS; saving applies immediately. Not required when the backend is set to dsh service or TTS tool plugin.',
      ttsVoice: 'Voice',
      ttsSpeed: 'Speed',
      ttsPitch: 'Pitch',
      ttsVolume: 'Volume',
      ttsLevelHint: '0-15, 5 is normal',
      voiceCredsMissing: 'Baidu voice keys are not configured — STT and TTS are unavailable',
      voiceCredsOk: 'Baidu voice credentials configured',
      depMissing: 'Not installed',
      depInstalled: 'Installed',
      depHowTo: 'How to install',
      depAfterInstall: 'Restart dsh web after installing',
      sttLanguage: 'Language',
      langAuto: 'Auto',
      langZh: 'Chinese',
      langEn: 'English',
      langYue: 'Cantonese',
      voiceSettingsHint: 'Click Save above to apply; no restart needed.',
      voiceHead: 'Voice',
      hotApplyHint: 'Model, fallback chain, thinking, tool preview and voice apply immediately; App ID / Secret / domain need a dsh web restart.',
      visionHead: 'Media recognition (ModLens)',
      noModelOptions: 'Could not load model list — check base URL and key',
      appId: 'App ID',
      appSecret: 'App Secret',
      domain: 'Region',
      domainFeishu: 'China (feishu)',
      domainLark: 'International (lark)',
      domainHint:
        'Apps registered on Feishu must stay on Feishu. Feishu and Lark are separate platforms — credentials are not interchangeable. Takes effect after restarting dsh web.',
      botName: 'Bot name',
      defaultChatId: 'Default chat_id',
      agentModel: 'Provider',
      agentModelModel: 'Primary model',
      fallbackModels: 'Fallback chain',
      fallbackHint: 'Tried in order when the primary request fails. Empty = disabled.',
      addFallback: '+ Add fallback',
      remove: 'Remove this entry',
      agentMode: 'Agent mode',
      modeInprocess: 'inprocess (resident, supports mid-run steer)',
      modeHeadless: 'headless (spawn per message)',
      thinkingEnabled: 'Show reasoning',
      thinkingFilterUserEcho: 'Hide "The user says…" echo',
      toolPreviewChars: 'Tool preview length',
      toolPreviewHint: 'Characters kept for tool arguments in the progress bubble (20–200)',
      loading: 'Loading…',
      save: 'Save',
      reset: 'Reset',
      saving: 'Saving…',
      unsaved: 'Unsaved changes',
      saved: 'Saved',
      saveFailed: 'Save failed',
      catalogFailed: 'Model catalog failed to load',
      readonly: 'Configuration document is read-only',
      unavailable: 'Not exposed to this client',
      pickProvider: 'Pick provider',
      pickModel: 'Pick model',
    };

    // ── 样式 ────────────────────────────────────────────────────────────
    // 全部走 dsh 主题变量，浅色/深色自动跟随；边框用中性灰，不依赖主题的
    // border-l1..l4（那几档 alpha 低到肉眼不可见，见技能文档第 6 节）。
    const BORDER_SOFT = 'var(--dsw-alias-settings-card-stroke, rgba(127,127,127,0.20))';
    const BORDER_CTRL = 'rgba(128,128,128,0.55)';
    const LABEL_W = 148;

    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 12, padding: '2px 0 10px' },
      intro: { fontSize: 12.5, lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary, inherit)' },
      bar: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },

      /* 顶部操作栏 */
      topbar: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'nowrap',
        padding: '9px 12px',
        borderRadius: 14,
        border: '1px solid ' + BORDER_SOFT,
        background: 'var(--dsw-alias-settings-card-fill, rgba(127,127,127,0.05))',
      },
      brand: { display: 'flex', alignItems: 'center', gap: 9, marginRight: 'auto', minWidth: 0, overflow: 'hidden' },
      brandMark: {
        width: 26,
        height: 26,
        borderRadius: 8,
        flex: '0 0 auto',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 12.5,
        fontWeight: 700,
        color: '#fff',
        background: 'linear-gradient(135deg, #5b93ff 0%, #2f6bd8 100%)',
        boxShadow: '0 1px 4px rgba(47,107,216,0.35)',
      },
      brandName: { fontSize: 13.5, fontWeight: 650, letterSpacing: '0.01em' },

      /* 按钮 */
      primary: {
        flex: '0 0 auto',
        background: 'var(--dsw-alias-brand-primary, #3b6ef0)',
        border: '1px solid transparent',
        color: 'var(--dsw-alias-label-primary-inverted, #fff)',
        borderRadius: 9,
        fontSize: 13,
        fontWeight: 600,
        padding: '6px 18px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        transition: 'filter .15s ease',
      },
      primaryIdle: {
        flex: '0 0 auto',
        background: 'transparent',
        border: '1px solid ' + 'rgba(128,128,128,0.30)',
        color: 'var(--dsw-alias-label-tertiary, inherit)',
        borderRadius: 9,
        fontSize: 13,
        fontWeight: 600,
        padding: '6px 18px',
        cursor: 'default',
        whiteSpace: 'nowrap',
      },
      small: {
        flex: '0 0 auto',
        background: 'transparent',
        border: '1px solid ' + BORDER_CTRL,
        color: 'var(--dsw-alias-label-secondary, inherit)',
        borderRadius: 9,
        fontSize: 13,
        padding: '6px 14px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        transition: 'background .15s ease',
      },

      /* 状态文字 */
      status: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, inherit)' },
      statusErr: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary, #e5534b)' },
      statusDirty: { fontSize: 12, color: 'var(--dsw-alias-state-warn-primary, #d29922)' },

      /* 分栏导航 */
      tabs: {
        display: 'flex',
        gap: 3,
        flexWrap: 'wrap',
        padding: 4,
        borderRadius: 12,
        background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.06))',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.14))',
      },
      tab: {
        flex: '0 0 auto',
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, inherit)',
        fontSize: 12.5,
        padding: '6px 13px',
        borderRadius: 9,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        fontFamily: 'inherit',
        transition: 'background .15s ease, color .15s ease',
      },
      tabActive: {
        flex: '0 0 auto',
        border: 'none',
        background: 'var(--dsw-alias-bg-base, #fff)',
        color: 'var(--dsw-alias-label-primary, inherit)',
        fontSize: 12.5,
        fontWeight: 600,
        padding: '6px 13px',
        borderRadius: 9,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        fontFamily: 'inherit',
        boxShadow: '0 1px 3px rgba(0,0,0,0.12)',
      },

      /* 卡片 */
      section: {
        display: 'flex',
        flexDirection: 'column',
        gap: 0,
        border: '1px solid ' + BORDER_SOFT,
        background: 'var(--dsw-alias-settings-card-fill, rgba(127,127,127,0.04))',
        borderRadius: 14,
        padding: '4px 16px 14px',
      },
      secTitle: {
        fontSize: 13,
        fontWeight: 650,
        letterSpacing: '0.01em',
        color: 'var(--dsw-alias-label-primary, inherit)',
        padding: '12px 0 6px',
      },

      /* 字段行 */
      row: { display: 'flex', alignItems: 'center', gap: 10, minHeight: 36, padding: '3px 0' },
      label: {
        width: LABEL_W,
        flexShrink: 0,
        fontSize: 12.5,
        lineHeight: 1.4,
        color: 'var(--dsw-alias-label-secondary, inherit)',
      },
      input: {
        flex: 1,
        minWidth: 0,
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        border: '1px solid ' + BORDER_CTRL,
        borderRadius: 9,
        color: 'inherit',
        fontSize: 13,
        padding: '7px 10px',
        fontFamily: 'inherit',
        outline: 'none',
        transition: 'border-color .15s ease',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      /* 下拉不能带 overflow/ellipsis，否则会把原生箭头裁掉 */
      selectBase: {
        minWidth: 0,
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: BORDER_CTRL,
        outline: 'none',
        borderRadius: 9,
        color: 'inherit',
        fontSize: 13,
        padding: '7px 10px',
        fontFamily: 'inherit',
        cursor: 'pointer',
      },
      hint: {
        fontSize: 11.5,
        lineHeight: 1.65,
        color: 'var(--dsw-alias-label-tertiary, inherit)',
        marginLeft: LABEL_W + 10,
        marginTop: -2,
      },
      chainRow: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
      chainBox: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 },
      delBtn: {
        flex: '0 0 auto',
        width: 30,
        height: 30,
        lineHeight: 1,
        padding: 0,
        fontSize: 15,
        background: 'transparent',
        border: '1px solid ' + BORDER_CTRL,
        color: 'var(--dsw-alias-label-tertiary, inherit)',
        borderRadius: 9,
        cursor: 'pointer',
        transition: 'background .15s ease',
      },
      addBtn: {
        alignSelf: 'flex-start',
        background: 'transparent',
        border: '1px dashed ' + BORDER_CTRL,
        color: 'var(--dsw-alias-label-secondary, inherit)',
        borderRadius: 9,
        fontSize: 12,
        padding: '5px 12px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        fontFamily: 'inherit',
        transition: 'background .15s ease',
      },
      chainHint: {
        fontSize: 11.5,
        lineHeight: 1.6,
        color: 'var(--dsw-alias-label-tertiary, inherit)',
      },

      /* 卡内子标题：上方一条细线，把一张卡切成几个语义块 */
      subhead: {
        fontSize: 12.5,
        fontWeight: 650,
        color: 'var(--dsw-alias-label-primary, inherit)',
        marginTop: 14,
        paddingTop: 12,
        borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.14))',
        marginBottom: 2,
      },

      /* 纵向字段：标签在上、控件在下 */
      fieldLabel: {
        fontSize: 12,
        lineHeight: 1.4,
        color: 'var(--dsw-alias-label-tertiary, inherit)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      },
      fieldHint: {
        fontSize: 11,
        lineHeight: 1.55,
        color: 'var(--dsw-alias-label-tertiary, inherit)',
        opacity: 0.85,
      },
      /* 一行并排的字段容器 */
      inlineRow: {
        display: 'flex',
        gap: 12,
        alignItems: 'flex-start',
        flexWrap: 'wrap',
      },
      /* 开关胶囊：左标签右开关 */
      switchCard: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
        minWidth: 180,
        padding: '8px 12px',
        borderRadius: 10,
        border: '1px solid ' + 'rgba(128,128,128,0.22)',
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
      },
      switchLabel: { fontSize: 12.5, lineHeight: 1.4 },
      checkbox: {
        width: 16,
        height: 16,
        margin: 0,
        flex: '0 0 auto',
        cursor: 'pointer',
        accentColor: 'var(--dsw-alias-brand-primary, #3b6ef0)',
      },

      /* 小徽章 */
      badge: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 11,
        fontWeight: 600,
        padding: '2px 7px',
        borderRadius: 6,
        lineHeight: 1.5,
      },
      badgeOk: {
        color: 'var(--dsw-alias-state-success-primary, #3fb950)',
        background: 'rgba(63,185,80,0.12)',
      },
      badgeWarn: {
        color: 'var(--dsw-alias-state-warn-primary, #d29922)',
        background: 'rgba(210,153,34,0.13)',
      },
    };

    /** 定位到本插件的配置作用域。 */
    function resolveScope(softGet) {
      const forms = softGet('configForms');
      if (forms !== undefined && forms !== null) {
        try {
          const namespaces = forms.describe().getSnapshot().view?.namespaces ?? [];
          const served = namespaces.find((e) => e.ns === ENTRY_ID);
          if (served !== undefined) return forms.get(served.ns);
        } catch {
          /* 描述失败就交给退路 */
        }
        return forms.get(ENTRY_ID);
      }
      const scope = softGet('settingsScope');
      if (scope !== undefined && scope !== null) return scope.bind({ namespace: ENTRY_ID });
      return undefined;
    }

    function useSnapshot(scope) {
      const [snap, setSnap] = react.useState(() => scope?.getSnapshot?.() ?? {});
      react.useEffect(() => {
        if (!scope?.subscribe) return undefined;
        return scope.subscribe(() => setSnap(scope.getSnapshot()));
      }, [scope]);
      return snap;
    }

    /** 拉取模型目录（host 半的路由）。 */
    function useCatalog() {
      const [state, setState] = react.useState({ providers: [], ready: false, error: null });
      react.useEffect(() => {
        let alive = true;
        fetch(MODELS_URL, { headers: { accept: 'application/json' } })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
          .then((d) => {
            if (alive) setState({ providers: d.providers ?? [], ready: true, error: null });
          })
          .catch((e) => {
            if (alive) setState({ providers: [], ready: true, error: e.message });
          });
        return () => {
          alive = false;
        };
      }, []);
      return state;
    }

    /** 拉取 / 提交 image-gen 与 modlens 的配置。 */
    function useMediaConfig() {
      const [state, setState] = react.useState({ ready: false, data: null, error: null });
      const reload = react.useCallback(() => {
        fetch(MEDIA_URL, { headers: { accept: 'application/json' } })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
          .then((d) => setState({ ready: true, data: d, error: null }))
          .catch((e) => setState({ ready: true, data: null, error: e.message }));
      }, []);
      react.useEffect(() => {
        reload();
      }, [reload]);
      return { ...state, reload };
    }


    /** CSV <-> 数组。 */
    function parseChain(spec) {
      if (typeof spec !== 'string' || !spec.trim()) return [];
      return spec
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean)
        .map((c) => {
          const i = c.indexOf(SEP);
          if (i <= 0) return null;
          return { provider: c.slice(0, i).trim(), model: c.slice(i + 1).trim() };
        })
        .filter(Boolean);
    }
    function formatChain(list) {
      return list.map((x) => `${x.provider}${SEP}${x.model}`).join(', ');
    }

    /** 统一的下拉：外观跟默认一致，不做额外强调。 */
    function Select({ style, children, ...rest }) {
      return jsx.jsx('select', { ...rest, style: { ...S.selectBase, ...style }, children });
    }

    function ProviderSelect({ providers, value, onChange, disabled, placeholder, style }) {
      return jsx.jsx(Select, {
        style: style ?? { flex: '1 1 170px', minWidth: 0 },
        value: value ?? '',
        disabled,
        onChange: (e) => onChange(e.target.value),
        children: [
          jsx.jsx('option', { value: '', disabled: true, children: placeholder }, '__ph'),
          ...providers.map((p) =>
            jsx.jsx('option', { value: p.provider, children: p.name ?? p.provider }, p.provider),
          ),
        ],
      });
    }

    function ModelSelect({ providers, provider, value, onChange, disabled, placeholder, style }) {
      const list = providers.find((p) => p.provider === provider)?.models ?? [];
      return jsx.jsx(Select, {
        style: style ?? { flex: '1 1 120px', minWidth: 0 },
        value: value ?? '',
        disabled,
        onChange: (e) => onChange(e.target.value),
        children: [
          jsx.jsx('option', { value: '', disabled: true, children: placeholder }, '__ph'),
          ...list.map((m) => jsx.jsx('option', { value: m.id, children: m.name ?? m.id }, m.id)),
          ...(value && !list.some((m) => m.id === value)
            ? [jsx.jsx('option', { value, children: value + '（当前）' }, '__cur')]
            : []),
        ],
      });
    }

    /** 纵向字段容器：标签在上、控件在下；并排时靠统一行高自然对齐。 */
    function Field({ label, hint, grow, children }) {
      return jsx.jsxs('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, flex: grow ?? 1 },
        children: [
          jsx.jsx('div', { style: S.fieldLabel, children: label }),
          children,
          hint ? jsx.jsx('div', { style: S.fieldHint, children: hint }) : null,
        ],
      });
    }

    /** 一行并排多个字段。 */
    function Row({ children, style }) {
      return jsx.jsx('div', { style: { ...S.inlineRow, ...style }, children });
    }

    function TextField({ label, value, onChange, disabled, placeholder, hint, grow }) {
      return jsx.jsx(Field, {
        label,
        hint,
        grow,
        children: jsx.jsx('input', {
          style: S.input,
          type: 'text',
          value: value ?? '',
          placeholder: placeholder ?? '',
          disabled,
          onChange: (e) => onChange(e.target.value),
        }),
      });
    }

    function SelectField({ label, value, options, onChange, disabled, hint, grow }) {
      const list = options ?? [];
      return jsx.jsx(Field, {
        label,
        hint,
        grow,
        children: jsx.jsx(Select, {
          style: { width: '100%' },
          value: value ?? list[0]?.value ?? '',
          disabled,
          onChange: (e) => onChange(e.target.value),
          children: list.map((o) =>
            jsx.jsx('option', { value: o.value, disabled: o.disabled === true, children: o.label }, String(o.value)),
          ),
        }),
      });
    }

    /** 开关做成胶囊：左标签右开关，两个并排就是一行。 */
    function SwitchField({ label, checked, onChange, disabled, grow }) {
      return jsx.jsx('div', {
        style: { ...S.switchCard, flex: grow ?? 1 },
        children: [
          jsx.jsx('span', { style: S.switchLabel, children: label }),
          jsx.jsx('input', {
            type: 'checkbox',
            checked: checked === true,
            disabled,
            style: { ...S.checkbox, opacity: disabled ? 0.5 : 1, cursor: disabled ? 'default' : 'pointer' },
            onChange: (e) => onChange(e.target.checked),
          }),
        ],
      });
    }

    /**
     * 从一份参数 schema 里解析出下拉选项。
     * 支持三种写法（都在 dsh 的 schema 子集内）：
     *   1) enum + enumNames —— 值走 enum，显示走 enumNames（一一对应，中文标签正门）
     *   2) oneOf: [{ const, title }] —— 值和显示都写在分支里
     *   3) enum 裸值 —— 值即显示
     * 没有可枚举选项就返回 null，调用方据此退化成数字/文本控件。
     */
    function optionsOf(param) {
      if (!param || typeof param !== 'object') return null;
      const names = Array.isArray(param.enumNames) ? param.enumNames : null;
      if (Array.isArray(param.enum)) {
        return param.enum.map((v, idx) => ({
          value: v,
          label: names && typeof names[idx] === 'string' ? names[idx] : String(v),
        }));
      }
      if (Array.isArray(param.oneOf)) {
        const out = [];
        for (const branch of param.oneOf) {
          if (!branch || typeof branch !== 'object' || !Object.hasOwn(branch, 'const')) return null;
          out.push({
            value: branch.const,
            label: typeof branch.title === 'string' && branch.title ? branch.title : String(branch.const),
          });
        }
        return out.length > 0 ? out : null;
      }
      return null;
    }

    /** 纵向整数输入：标签在上，输入框在下，三个并排就是一行。 */
    function IntegerField({ label, value, fallback, onChange, disabled, hint }) {
      const cur = Number.isFinite(Number(value)) ? Math.round(Number(value)) : fallback;
      // 输入过程中的原始字符串单独存一份：直接受控成数字会删不掉（退格清空时
      // onChange 拿到 '' 被忽略、React 又把旧值刷回来）。
      const [buf, setBuf] = react.useState(null);
      const shown = buf ?? String(cur);
      return jsx.jsx(Field, {
        label,
        hint,
        children: jsx.jsx('input', {
          style: { ...S.input, textAlign: 'center' },
          type: 'number',
          step: 1,
          min: 0,
          max: 15,
          value: shown,
          disabled,
          onChange: (e) => {
            const v = e.target.value;
            setBuf(v);
            if (v === '') return;          // 允许暂时为空，别立刻回填
            const n = Number(v);
            if (Number.isFinite(n)) onChange(Math.round(n));
          },
          onBlur: () => {
            if (buf === '' || !Number.isFinite(Number(buf))) onChange(fallback);
            setBuf(null);
          },
        }),
      });
    }


    /** 设置页卡片本体：草稿态 + 显式保存。 */
    function FeishuCard({ t, scope }) {
      const snap = useSnapshot(scope);
      const catalog = useCatalog();
      const media = useMediaConfig();
      /** 本地草稿；null 表示跟已保存的值同步。 */
      const [draft, setDraft] = react.useState(null);
      /** 媒体配置草稿（image-gen / modlens 走独立接口，单独保存）。 */
      const [mediaDraft, setMediaDraft] = react.useState(null);
      /** 切 provider 后按新 provider 重算的候选模型。 */
      const [optOverride, setOptOverride] = react.useState({ imageGen: null, vision: null });
      const statusTimer = react.useRef(null);
      react.useEffect(
        () => () => {
          if (statusTimer.current) window.clearTimeout(statusTimer.current);
        },
        [],
      );
      /** 联网 provider 草稿。 */
      const [webDraft, setWebDraft] = react.useState(null);
      const [busy, setBusy] = react.useState(false);
      const [status, setStatus] = react.useState(null);
      /** 当前选中的分组 tab；null = 用第一个分组。 */
      const [tab, setTab] = react.useState(null);

      const saved = snap?.value ?? {};
      // 保存中一并置为不可编辑：await 期间用户继续输入会写进当前 draft，
      // 而保存成功后无条件 setDraft(null)，这批编辑会被静默丢掉。
      const writable = snap?.writable === true && !busy;
      const value = draft ?? saved;
      const dirty = draft !== null || mediaDraft !== null || webDraft !== null;

      // 每个 target 记一个递增序号：快速连续切 provider 时，
      // 先发的请求可能后回来，不校验就会把上一个 provider 的模型列表
      // 写进当前下拉里（出现不属于当前 provider 的模型）。
      const modelSeq = react.useRef({ imageGen: 0, vision: 0 });
      const refreshModels = (target, provider) => {
        const seq = (modelSeq.current[target] ?? 0) + 1;
        modelSeq.current[target] = seq;
        fetch(`${MEDIA_MODELS_URL}?target=${target}&provider=${encodeURIComponent(provider)}`, {
          headers: { accept: 'application/json' },
        })
          .then((r) => (r.ok ? r.json() : { options: [] }))
          .then((d) => {
            if (modelSeq.current[target] !== seq) return;   // 已被更新的请求取代
            setOptOverride((prev) => ({ ...prev, [target]: d.options ?? [] }));
          })
          .catch(() => {
            if (modelSeq.current[target] !== seq) return;
            setOptOverride((prev) => ({ ...prev, [target]: [] }));
          });
      };

      const webSaved = media.data?.web ?? null;
      const webValue = webDraft ?? webSaved;
      const webDirty = webDraft !== null;

      const mediaSaved = media.data ?? null;
      const mediaValue = mediaDraft ?? mediaSaved;
      const mediaDirty = mediaDraft !== null;

      // 保存成功后（draft 清空）跟随外部值；有未保存改动时不覆盖用户输入。
      if (scope === undefined) return jsx.jsx('div', { style: S.intro, children: t('unavailable') });
      if (snap.status === 'loading') return jsx.jsx('div', { style: S.intro, children: t('loading') });
      if (snap.status === 'unavailable') return jsx.jsx('div', { style: S.intro, children: t('unavailable') });

      // 支持两种用法：set('field', value) 和 set({ a, b })。
      // 后者是必须的 —— 换了 provider 还要顺带改语言时，连调两次 set()
      // 第二次是基于同一份旧 draft 重建对象，会把第一次的改动覆盖掉。
      const set = (field, next) => {
        const patch = typeof field === 'object' && field !== null ? field : { [field]: next };
        setDraft({ ...(draft ?? saved), ...patch });
        setStatus(null);
      };

      const doSave = async () => {
        // ⚠️ 必须回落到已保存值，不能是空对象：
        // 只动「媒体/联网」下拉时 draft 仍是 null，用 {} 会让 changed 把
        // 每一个已保存字段都判成「改过」，接着 scope.set(f, undefined)
        // 把它们逐个删掉 —— 用户只是换了张图，整个插件配置就没了。
        const next = draft ?? saved ?? {};
        const fields = new Set([...Object.keys(saved), ...Object.keys(next)]);
        // 密钥字段已取消 role('secret')，宿主正常回显 —— 按普通字段比对即可。
        // 这样留空就是真的清空，填了就能看到，不用再猜「到底存没存上」。
        const changed = [];
        for (const f of fields) {
          if (JSON.stringify(saved[f] ?? null) !== JSON.stringify(next[f] ?? null)) changed.push(f);
        }
        if (!changed.length && !mediaDirty && !webDirty) {
          setDraft(null);
          setStatus({ ok: true, text: t('saved') });
          return;
        }
        setBusy(true);
        try {
          // scope.set 在宿主拒绝写入时是 resolve(false)，不是抛错。
          // 不看返回值的话，冲突/校验失败也会显示"已保存"，随后还清空 draft，
          // 用户改的东西被静默丢掉。
          const rejected = [];
          for (const f of changed) {
            const ok = await scope.set(f, next[f]);
            if (ok === false) rejected.push(f);
          }
          if (rejected.length) {
            throw new Error(`以下配置被宿主拒绝：${rejected.join(', ')}`);
          }
          if (mediaDirty) {
            for (const target of ['imageGen', 'vision']) {
              const before = mediaSaved?.[target];
              const after = mediaValue?.[target];
              if (!after?.ok) continue;
              if (before?.libId === after.libId && before?.model === after.model) continue;
              const r = await fetch(MEDIA_URL, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ target, libId: after.libId, model: after.model }),
              });
              if (!r.ok) {
                const detail = await r.text().catch(() => '');
                throw new Error(`${target} 保存失败: ${detail.slice(0, 200)}`);
              }
            }
            setMediaDraft(null);
            media.reload();
          }
          if (webDirty) {
            const r = await fetch(WEB_URL, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                searchProvider: webValue?.searchProvider,
                fetchProvider: webValue?.fetchProvider,
              }),
            });
            if (!r.ok) {
              const detail = await r.text().catch(() => '');
              throw new Error(`联网 provider 保存失败: ${detail.slice(0, 200)}`);
            }
            setWebDraft(null);
            media.reload();
          }
          setDraft(null);
          setStatus({ ok: true, text: t('saved') });
        } catch (error) {
          setStatus({ ok: false, text: t('saveFailed') + ': ' + error.message });
        } finally {
          setBusy(false);
          // 保存句柄并在重排前取消：连续保存时，前一次排的 3 秒定时器
          // 会把后一次的「已保存/保存失败」提前清掉；组件卸载后还会 setStatus。
          if (statusTimer.current) window.clearTimeout(statusTimer.current);
          statusTimer.current = window.setTimeout(() => setStatus(null), 3000);
        }
      };

      const providers = catalog.providers;
      const chain = parseChain(value.fallbackModels);

      // 每个分组一个 tab：标题即分组键，children 是字段数组。
      // 以前是全平铺一长条，六个大区块堆下来要滚很久；现在按域切分。
      const groups = [];
      const sec = (title, children) => {
        groups.push({ key: title, title, children });
      };
      // 生效范围说明：避免用户以为所有项都要重启（跨分组，放在 tab 栏下方）
      const hotApplyHint = jsx.jsx('div', {
        key: 'hotApplyHint',
        style: { fontSize: 11.5, lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary, inherit)', padding: '0 2px' },
        children: t('hotApplyHint'),
      });

      // ── 飞书应用 ──
      // 布局：标签在上、控件在下，两个字段并排一行。
      // 原来「标签固定左宽 + 控件右对齐」会让不同标签长度把控件右边缘推得参差不齐；
      // 改成字段自己的列宽后，每列的控件宽度天然一致。
      sec(t('secFeishu'), [
        jsx.jsx(Row, {
          key: 'rowDomainBot',
          children: [
            jsx.jsx(SelectField, {
              label: t('domain'),
              hint: t('domainShortHint'),
              value: value.domain ?? 'feishu',
              options: [
                { value: 'feishu', label: t('domainFeishu') },
                { value: 'lark', label: t('domainLark') },
              ],
              disabled: !writable,
              onChange: (v) => set('domain', v),
            }),
            jsx.jsx(TextField, {
              label: t('botName'),
              value: value.botName,
              disabled: !writable,
              onChange: (v) => set('botName', v),
            }),
          ],
        }),
        jsx.jsx('div', {
          key: 'domainHint',
          style: { fontSize: 11.5, lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary, inherit)', marginTop: -2 },
          children: t('domainHint'),
        }),
        jsx.jsx(Row, {
          key: 'rowCreds',
          children: [
            jsx.jsx(TextField, {
              label: t('appId'),
              value: value.appId,
              disabled: !writable,
              onChange: (v) => set('appId', v),
            }),
            jsx.jsx(TextField, {
              label: t('appSecret'),
              value: value.appSecret,
              disabled: !writable,
              onChange: (v) => set('appSecret', v),
            }),
          ],
        }),
        jsx.jsx(TextField, {
          key: 'defaultChatId',
          label: t('defaultChatId'),
          value: value.defaultChatId,
          disabled: !writable,
          onChange: (v) => set('defaultChatId', v),
        }),
        // ── 发送方准入（安全）──
        // 这个插件的入站消息会驱动一个能读写本机文件、执行 shell 的 agent，
        // 所以「谁能给机器人发消息」=「谁能操作这台机器」。默认必须是拒绝。
        jsx.jsx(Row, {
          key: 'rowPolicies',
          children: [
            jsx.jsx(SelectField, {
              label: t('dmPolicy'),
              value: value.dmPolicy ?? 'allowlist',
              options: [
                { value: 'allowlist', label: t('polAllowlist') },
                { value: 'open', label: t('polOpen') },
                { value: 'disabled', label: t('polDisabled') },
              ],
              disabled: !writable,
              onChange: (v) => set('dmPolicy', v),
            }),
            jsx.jsx(SelectField, {
              label: t('groupPolicy'),
              value: value.groupPolicy ?? 'allowlist',
              options: [
                { value: 'allowlist', label: t('polAllowlist') },
                { value: 'open', label: t('polOpen') },
                { value: 'disabled', label: t('polDisabled') },
              ],
              disabled: !writable,
              onChange: (v) => set('groupPolicy', v),
            }),
          ],
        }),
        jsx.jsx(TextField, {
          key: 'allowFrom',
          label: t('allowFrom'),
          value: value.allowFrom,
          disabled: !writable,
          grow: 2,
          onChange: (v) => set('allowFrom', v),
        }),
        jsx.jsx('div', {
          key: 'allowFromHint',
          style: { fontSize: 11.5, lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary, inherit)' },
          children: t('allowFromHint'),
        }),
      ]);

      // ── Agent 与模型 ──
      sec(t('secAgent'), [
        jsx.jsx(Row, {
          key: 'primary',
          children: [
            jsx.jsx(Field, {
              label: t('agentModel'),
              grow: 1,
              children: jsx.jsx(ProviderSelect, {
                providers,
                value: value.agentProvider,
                disabled: !writable || !catalog.ready,
                placeholder: t('pickProvider'),
                style: { width: '100%' },
                onChange: (p) => {
                  const first = providers.find((x) => x.provider === p)?.models?.[0]?.id;
                  setDraft({ ...(draft ?? saved), agentProvider: p, ...(first ? { agentModel: first } : {}) });
                  setStatus(null);
                },
              }),
            }),
            jsx.jsx(Field, {
              label: t('agentModelModel'),
              grow: 1.4,
              children: jsx.jsx(ModelSelect, {
                providers,
                provider: value.agentProvider,
                value: value.agentModel,
                disabled: !writable || !catalog.ready,
                placeholder: t('pickModel'),
                style: { width: '100%' },
                onChange: (m) => set('agentModel', m),
              }),
            }),
          ],
        }),
        catalog.error
          ? jsx.jsx('div', { key: 'catErr', style: S.hint, children: t('catalogFailed') + ': ' + catalog.error })
          : null,
        jsx.jsxs(
          'div',
          {
            key: 'chain',
            style: { display: 'flex', flexDirection: 'column', gap: 6 },
            children: [
              jsx.jsx('div', { style: S.fieldLabel, children: t('fallbackModels') }),
              jsx.jsxs('div', {
                style: S.chainBox,
                children: [
                  ...chain.map((entry, idx) =>
                    jsx.jsxs(
                      'div',
                      {
                        style: S.chainRow,
                        children: [
                          jsx.jsx(ProviderSelect, {
                            providers,
                            value: entry.provider,
                            disabled: !writable || !catalog.ready,
                            placeholder: t('pickProvider'),
                            onChange: (p) => {
                              const first = providers.find((x) => x.provider === p)?.models?.[0]?.id ?? '';
                              const next = [...chain];
                              next[idx] = { provider: p, model: first };
                              set('fallbackModels', formatChain(next));
                            },
                          }),
                          jsx.jsx(ModelSelect, {
                            providers,
                            provider: entry.provider,
                            value: entry.model,
                            disabled: !writable || !catalog.ready,
                            placeholder: t('pickModel'),
                            onChange: (m) => {
                              const next = [...chain];
                              next[idx] = { ...entry, model: m };
                              set('fallbackModels', formatChain(next));
                            },
                          }),
                          jsx.jsx('button', {
                            style: S.delBtn,
                            type: 'button',
                            title: t('remove'),
                            'aria-label': t('remove'),
                            disabled: !writable,
                            onClick: () => set('fallbackModels', formatChain(chain.filter((_, i) => i !== idx))),
                            children: '\u00d7',
                          }),
                        ],
                      },
                      'chain' + idx,
                    ),
                  ),
                  jsx.jsx('button', {
                    style: S.addBtn,
                    type: 'button',
                    disabled: !writable || !catalog.ready,
                    onClick: () => {
                      const first = providers[0];
                      if (!first) return;
                      const next = [...chain, { provider: first.provider, model: first.models?.[0]?.id ?? '' }];
                      set('fallbackModels', formatChain(next));
                    },
                    children: t('addFallback'),
                  }),
                  jsx.jsx('div', { style: S.chainHint, children: t('fallbackHint') }),
                ],
              }),
            ],
          },
          'chain',
        ),
      ]);

      const langLabel = (code) =>
        ({ auto: t('langAuto'), zh: t('langZh'), en: t('langEn'), yue: t('langYue') })[code] ?? code ?? '';

      /** 依赖体检卡片：没装就明确告诉怎么装。 */
      const depCard = (key) => {
        const dep = mediaValue?.deps?.[key];
        if (!dep) return null;
        const ok = dep.installed === true;
        const credsBad = dep.installed && dep.credentials === false;
        const good = ok && !credsBad;
        const tone = good ? 'var(--dsw-alias-state-success-primary, #3fb950)' : 'var(--dsw-alias-state-warn-primary, #d29922)';
        return jsx.jsxs(
          'div',
          {
            style: {
              marginTop: 8,
              marginBottom: 4,
              padding: '9px 12px',
              borderRadius: 10,
              fontSize: 12,
              lineHeight: 1.7,
              borderLeft: '3px solid ' + tone,
              background: good ? 'rgba(63,185,80,0.07)' : 'rgba(210,153,34,0.09)',
            },
            children: [
              jsx.jsxs('div', {
                style: { display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' },
                children: [
                  jsx.jsx('code', {
                    style: {
                      fontFamily: 'var(--dsh-font-family-code, monospace)',
                      fontSize: 11.5,
                      fontWeight: 600,
                    },
                    children: key,
                  }),
                  jsx.jsx('span', {
                    style: { ...S.badge, ...(good ? S.badgeOk : S.badgeWarn) },
                    children: `${ok ? t('depInstalled') : t('depMissing')}${dep.version ? ' v' + dep.version : ''}`,
                  }),
                ],
              }),
              jsx.jsx('div', {
                style: { color: 'var(--dsw-alias-label-tertiary, inherit)', marginTop: 2 },
                children: dep.purpose,
              }),
              ok
                ? null
                : jsx.jsxs('div', {
                    style: { marginTop: 4 },
                    children: [
                      jsx.jsx('div', { style: { opacity: 0.85, fontWeight: 600 }, children: t('depHowTo') }),
                      jsx.jsx('code', {
                        style: {
                          display: 'block',
                          marginTop: 4,
                          padding: '7px 10px',
                          borderRadius: 8,
                          fontFamily: 'var(--dsh-font-family-code, monospace)',
                          fontSize: 11,
                          lineHeight: 1.6,
                          color: 'var(--dsw-alias-markdown-code-segment-selected, inherit)',
                          background: 'var(--dsw-alias-markdown-code-block, rgba(127,127,127,0.14))',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-all',
                        },
                        children: dep.install,
                      }),
                      jsx.jsx('div', { style: { opacity: 0.6, marginTop: 3 }, children: t('depAfterInstall') }),
                    ],
                  }),
              credsBad
                ? jsx.jsx('div', { style: { marginTop: 4, color: '#d29922' }, children: t('voiceCredsMissing') })
                : null,
            ],
          },
          'dep-' + key,
        );
      };

      /** 依赖提示只在「没装」或「凭据不全」时出现；装好且可用就不打扰。 */
      const depWarn = (key) => {
        const dep = mediaValue?.deps?.[key];
        if (!dep) return null;
        if (dep.installed === true && dep.credentials !== false) return null;
        return depCard(key);
      };

      // ── 媒体 ──
      // Provider / 模型全部来自 dsh 已配置的模型库，前端不写死任何厂商。
      const library = mediaValue?.library ?? [];
      const imageGen = mediaValue?.imageGen;
      const vision = mediaValue?.vision;
      const setMedia = (target, patch) =>
        setMediaDraft({
          ...(mediaDraft ?? mediaSaved ?? {}),
          [target]: { ...((mediaDraft ?? mediaSaved)?.[target] ?? {}), ...patch },
        });

      const libSelect = (target, current, onPick, style) =>
        jsx.jsx(Select, {
          style: style ?? { flex: '1 1 200px', minWidth: 0 },
          value: current ?? '',
          disabled: !writable || !library.length,
          onChange: (e) => onPick(e.target.value),
          children: [
            jsx.jsx('option', { value: '', disabled: true, children: t('pickProvider') }, '__ph'),
            ...library.map((p) =>
              jsx.jsx('option', { value: p.id, children: `${p.name}（${p.modelCount} 个模型）` }, p.id),
            ),
          ],
        });

      const modelSelect = (target, current, options, style) => {
        const opts = options ?? [];
        if (!opts.length) {
          return jsx.jsx('span', { style: { fontSize: 12, opacity: 0.55 }, children: t('noModelOptions') });
        }
        return jsx.jsx(Select, {
          style: style ?? { flex: '1 1 200px', minWidth: 0 },
          value: current ?? '',
          disabled: !writable,
          onChange: (e) => setMedia(target, { model: e.target.value }),
          children: [
            ...opts.map((m) => jsx.jsx('option', { value: m, children: m }, m)),
            ...(current && !opts.includes(current)
              ? [jsx.jsx('option', { value: current, children: current + '（当前）' }, '__cur')]
              : []),
          ],
        });
      };

      if (media.ready && media.error) {
        sec(t('secMedia'), [
          jsx.jsx('div', { style: { fontSize: 12, opacity: 0.6 }, children: t('mediaUnavailable') }),
        ]);
      } else if (media.ready) {
        const mediaRows = [];

        if (!imageGen?.ok) mediaRows.push(depCard('dsh-image-gen'));
        if (!vision?.ok) mediaRows.push(depCard('@liustack/modlens'));
        if (imageGen?.ok) {
          mediaRows.push(
            depCard('dsh-image-gen'),
            jsx.jsx('div', { key: 'imgHead', style: S.subhead, children: t('imageGenHead') }),
            jsx.jsx(Row, {
              key: 'imgRow',
              children: [
                jsx.jsx(Field, {
                  label: t('imageGenProvider'),
                  grow: 1,
                  children: libSelect('imageGen', imageGen.libId, (v) => {
                    setMedia('imageGen', { libId: v, model: '' });
                    refreshModels('imageGen', v);
                  }, { width: '100%' }),
                }),
                jsx.jsx(Field, {
                  label: t('imageGenModel'),
                  grow: 1.4,
                  children: modelSelect('imageGen', imageGen.model, optOverride.imageGen ?? imageGen.modelOptions, { width: '100%' }),
                }),
              ],
            }),
          );
        }

        if (vision?.ok) {
          mediaRows.push(
            depCard('@liustack/modlens'),
            jsx.jsx('div', { key: 'visHead', style: S.subhead, children: t('visionHead') }),
            jsx.jsx(Row, {
              key: 'visRow',
              children: [
                jsx.jsx(Field, {
                  label: t('visionProvider'),
                  grow: 1,
                  children: libSelect('vision', vision.libId, (v) => {
                    setMedia('vision', { libId: v, model: '' });
                    refreshModels('vision', v);
                  }, { width: '100%' }),
                }),
                jsx.jsx(Field, {
                  label: t('visionModel'),
                  grow: 1.4,
                  children: modelSelect('vision', vision.model, optOverride.vision ?? vision.modelOptions, { width: '100%' }),
                }),
              ],
            }),
          );
        }

        if (!mediaRows.length) {
          mediaRows.push(
            jsx.jsx('div', { key: 'none', style: { fontSize: 12, opacity: 0.6 }, children: t('mediaUnavailable') }),
          );
        }
        sec(t('secMedia'), mediaRows);
      }


      // ── 语音 ──
      const voice = mediaValue?.voice;
      if (media.ready && voice) {
        const sttProviders = voice.stt?.providers ?? [];
        const sttSavedCandidate = value.sttProvider;
        const sttCurrent = sttProviders.some((p) => p.id === sttSavedCandidate)
          ? sttSavedCandidate
          : voice.stt?.provider ?? '';
        const activeStt = sttProviders.find((p) => p.id === sttCurrent) ?? sttProviders[0];
        const sttLanguages = activeStt?.languages ?? ['auto'];
        const LANG_LABELS = {
          auto: t('langAuto'),
          zh: t('langZh'),
          en: t('langEn'),
          yue: t('langYue'),
          ja: '日本語',
          ko: '한국어',
        };

        // 内置百度 TTS：只区分「密钥齐不齐」，不再有可选的外部 TTS 插件
        const voiceReady = voice.tts?.ready === true;

        // 密钥已取消 role('secret')，会明文回显，输入框里就是真实保存的值。
        // 这行状态仍然保留：后端 ready 反映的是「实际可用」，比如密钥只填了一半、
        // 或者在别处被清空，光看输入框看不出来。
        const credsMissing = !voiceReady;

        const voiceRows = [
          // ── 百度语音凭据（STT / TTS 共用）──
          // 识别和合成共用同一组 key，所以放语音区最上面，
          // 塞在「文字转语音」里会被误读成合成专用。
          jsx.jsx('div', { key: 'credsHead', style: S.subhead, children: t('credsHead') }),
          jsx.jsx('div', {
            key: 'credsStatus',
            style: {
              marginBottom: 6,
              fontSize: 12,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              flexWrap: 'wrap',
            },
            children: jsx.jsxs('span', {
              style: { ...S.badge, ...(credsMissing ? S.badgeWarn : S.badgeOk) },
              children: [
                jsx.jsx('span', { children: credsMissing ? '●' : '●' }),
                jsx.jsx('span', { children: credsMissing ? t('voiceCredsMissing') : t('voiceCredsOk') }),
              ],
            }),
          }),
          jsx.jsx('div', {
            key: 'credsPlainText',
            style: { fontSize: 11, opacity: 0.55, marginBottom: 4 },
            children: t('credsPlainText'),
          }),
          jsx.jsx(Row, {
            key: 'baiduCreds',
            children: [
              jsx.jsx(TextField, {
                label: t('baiduApiKey'),
                value: value.baiduApiKey ?? '',
                placeholder: t('baiduKeyHint'),
                disabled: !writable,
                onChange: (v) => set('baiduApiKey', v),
              }),
              jsx.jsx(TextField, {
                label: t('baiduSecretKey'),
                value: value.baiduSecretKey ?? '',
                placeholder: t('baiduKeyHint'),
                disabled: !writable,
                onChange: (v) => set('baiduSecretKey', v),
              }),
            ],
          }),
          jsx.jsx('div', {
            key: 'baiduHint',
            style: { fontSize: 12, opacity: 0.65, marginBottom: 4 },
            children: t('baiduObtainHint'),
          }),
          jsx.jsx('div', { key: 'sttHead', style: S.subhead, children: t('sttHead') }),
          jsx.jsx(Row, {
            key: 'sttRow',
            children: [
              jsx.jsx(SelectField, {
                label: t('sttBackend'),
                value: value.sttBackend ?? 'auto',
                options: [
                  { value: 'auto', label: t('backendAuto') },
                  { value: 'baidu', label: t('backendBaidu') },
                  { value: 'dsh', label: t('backendDsh') },
                ],
                disabled: !writable,
                onChange: (v) => set('sttBackend', v),
              }),
              sttProviders.length === 0
                ? jsx.jsx(Field, {
                    label: t('sttProvider'),
                    children: jsx.jsx('div', { style: { ...S.fieldHint, paddingTop: 8 }, children: t('sttNoProvider') }),
                  })
                : jsx.jsx(SelectField, {
                    label: t('sttProvider'),
                    value: activeStt?.id ?? '',
                    options: sttProviders.map((provider) => ({ value: provider.id, label: provider.name })),
                    disabled: !writable,
                    onChange: (v) => {
                      const next = sttProviders.find((p) => p.id === v);
                      const patch = { sttProvider: v };
                      // 换 provider 时把语言拉回它支持的第一个，避免存出不支持的组合。
                      // 必须和 provider 一起提交，分开两次 set 会互相覆盖。
                      if (next && !next.languages.includes(value.sttLanguage ?? 'auto')) {
                        patch.sttLanguage = next.languages[0] ?? 'auto';
                      }
                      set(patch);
                    },
                  }),
              jsx.jsx(SelectField, {
                label: t('sttLanguage'),
                value: value.sttLanguage ?? 'auto',
                options: [
                  // 已保存的语言可能不在当前 provider 的支持列表里
                  //（换过 provider、手工改过配置、provider 升级后缩了能力）。
                  // 不补一个兜底 option 的话，受控组件找不到匹配项会渲染成
                  // 空选择 —— 界面显示和真实保存值对不上。
                  ...(value.sttLanguage && !sttLanguages.includes(value.sttLanguage)
                    ? [{ value: value.sttLanguage, label: `${LANG_LABELS[value.sttLanguage] ?? value.sttLanguage}（当前）` }]
                    : []),
                  ...sttLanguages.map((lang) => ({ value: lang, label: LANG_LABELS[lang] ?? lang })),
                ],
                disabled: !writable || sttProviders.length === 0,
                onChange: (v) => set('sttLanguage', v),
              }),
            ],
          }),
        ];

        // ── 文字转语音 ──
        const ttsToolList = voice.tts?.tools ?? [];
        const ttsToolMode = (value.ttsBackend ?? 'auto') === 'tool';

        voiceRows.push(
          jsx.jsx('div', { key: 'ttsHead', style: S.subhead, children: t('ttsHead') }),
          jsx.jsx(Row, {
            key: 'ttsTop',
            children: [
              jsx.jsx(SelectField, {
                label: t('ttsBackend'),
                value: value.ttsBackend ?? 'auto',
                options: [
                  { value: 'auto', label: t('backendAuto') },
                  { value: 'baidu', label: t('backendBaidu') },
                  { value: 'tool', label: t('backendTool') },
                ],
                disabled: !writable,
                onChange: (v) => set('ttsBackend', v),
              }),
              // ttsBackend=tool 时才出现工具选择；没有已注册工具就给一行提示
              ttsToolMode
                ? (ttsToolList.length === 0
                    ? jsx.jsx(Field, {
                        label: t('ttsTool'),
                        children: jsx.jsx('div', { style: { ...S.fieldHint, paddingTop: 8 }, children: t('ttsNoProvider') }),
                      })
                    : jsx.jsx(SelectField, {
                        label: t('ttsTool'),
                        value: value.ttsTool || ttsToolList[0]?.id || '',
                        options: ttsToolList.map((tool) => ({ value: tool.id, label: tool.name })),
                        disabled: !writable,
                        onChange: (v) => set({ ttsTool: v, ttsArgs: '' }),
                      }))
                : null,
              jsx.jsx(SelectField, {
                label: t('ttsVoice'),
                value: value.ttsVoice ?? '0',
                options: [
                  { value: '0', label: '度小美（女声）' },
                  { value: '1', label: '度小宇（男声）' },
                  { value: '3', label: '度逍遥（男声）' },
                  { value: '4', label: '度丫丫（童声）' },
                  { value: '5003', label: '度逍遥（情感男声）' },
                ],
                disabled: !writable,
                onChange: (v) => set('ttsVoice', v),
              }),
            ].filter(Boolean),
          }),
          jsx.jsx(Row, {
            key: 'ttsLevels',
            children: [
              jsx.jsx(IntegerField, {
                label: t('ttsSpeed'),
                hint: t('ttsLevelHint'),
                value: value.ttsSpeed,
                fallback: 5,
                disabled: !writable,
                onChange: (v) => set('ttsSpeed', v),
              }),
              jsx.jsx(IntegerField, {
                label: t('ttsPitch'),
                hint: t('ttsLevelHint'),
                value: value.ttsPitch,
                fallback: 5,
                disabled: !writable,
                onChange: (v) => set('ttsPitch', v),
              }),
              jsx.jsx(IntegerField, {
                label: t('ttsVolume'),
                hint: t('ttsLevelHint'),
                value: value.ttsVolume,
                fallback: 5,
                disabled: !writable,
                onChange: (v) => set('ttsVolume', v),
              }),
            ],
          }),
        );
        sec(t('voiceHead'), voiceRows);
      }

      // ── 联网 ──
      const webSelect = (label, current, options, field) =>
        jsx.jsx(SelectField, {
          label,
          value: current ?? '',
          options: options.map((p) => ({
            value: p.id,
            label: p.available ? p.id : `${p.id}（不可用）`,
            disabled: p.available !== true,
          })),
          disabled: !writable || !options.length,
          onChange: (v) => setWebDraft({ ...(webDraft ?? webSaved ?? {}), [field]: v }),
        });

      if (media.ready && webValue) {
        sec(t('secWeb'), [
          jsx.jsx(Row, {
            key: 'webRow',
            children: [
              webSelect(t('webSearchProvider'), webValue.searchProvider, webValue.searchProviderOptions ?? [], 'searchProvider'),
              webSelect(t('webFetchProvider'), webValue.fetchProvider, webValue.fetchProviderOptions ?? [], 'fetchProvider'),
            ],
          }),
        ]);
      } else if (media.ready) {
        sec(t('secWeb'), [jsx.jsx('div', { style: { fontSize: 12, opacity: 0.6 }, children: t('webUnavailable') })]);
      }

      // ── 进度气泡 ──
      sec(t('secProgress'), [
        jsx.jsx(Row, {
          key: 'progressSwitches',
          children: [
            jsx.jsx(SwitchField, {
              label: t('thinkingEnabled'),
              checked: value.thinkingEnabled,
              disabled: !writable,
              onChange: (v) => set('thinkingEnabled', v),
            }),
            jsx.jsx(SwitchField, {
              label: t('thinkingFilterUserEcho'),
              checked: value.thinkingFilterUserEcho,
              disabled: !writable,
              onChange: (v) => set('thinkingFilterUserEcho', v),
            }),
          ],
        }),
        jsx.jsx(Field, {
          key: 'previewChars',
          label: t('toolPreviewChars'),
          hint: t('toolPreviewHint'),
          children: jsx.jsxs('div', {
            style: { display: 'flex', alignItems: 'center', gap: 10 },
            children: [
              jsx.jsx('input', {
                type: 'range',
                min: 20,
                max: 200,
                step: 10,
                value: typeof value.toolPreviewChars === 'number' ? value.toolPreviewChars : 60,
                disabled: !writable,
                style: { flex: 1, minWidth: 0, accentColor: 'var(--dsw-alias-brand-primary, #3b6ef0)' },
                onChange: (e) => set('toolPreviewChars', Number(e.target.value)),
              }),
              jsx.jsx('span', {
                style: {
                  flex: '0 0 auto',
                  minWidth: 34,
                  textAlign: 'right',
                  fontSize: 12,
                  fontVariantNumeric: 'tabular-nums',
                  color: 'var(--dsw-alias-label-secondary, inherit)',
                },
                children: String(typeof value.toolPreviewChars === 'number' ? value.toolPreviewChars : 60),
              }),
            ],
          }),
        }),
      ]);

      const statusStyle = !status ? S.status : status.ok === false ? S.statusErr : dirty ? S.statusDirty : S.status;
      const statusText = status
        ? status.text
        : busy
          ? t('saving')
          : dirty
            ? t('unsaved')
            : '';

      const activeKey = tab && groups.some((g) => g.key === tab) ? tab : groups[0]?.key;
      const active = groups.find((g) => g.key === activeKey);

      const tabBar = jsx.jsx('div', {
        style: S.tabs,
        role: 'tablist',
        children: groups.map((g) =>
          jsx.jsx(
            'button',
            {
              key: 'tab-' + g.key,
              type: 'button',
              role: 'tab',
              'aria-selected': g.key === activeKey,
              style: g.key === activeKey ? S.tabActive : S.tab,
              onClick: () => setTab(g.key),
              onMouseEnter: (e) => {
                if (g.key !== activeKey) e.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.10))';
              },
              onMouseLeave: (e) => {
                if (g.key !== activeKey) e.currentTarget.style.background = 'transparent';
              },
              children: g.title,
            },
            'tab-' + g.key,
          ),
        ),
      });

      const body = active
        ? jsx.jsxs('div', { style: S.section, children: active.children })
        : jsx.jsx('div', { style: S.intro, children: t('unavailable') });

      return jsx.jsxs('div', {
        style: S.wrap,
        children: [
          /* ── 顶部：品牌 + 操作按钮 ── */
          jsx.jsxs('div', {
            style: S.topbar,
            children: [
              jsx.jsxs('div', {
                style: S.brand,
                children: [
                  jsx.jsx('div', { style: S.brandMark, children: '飞' }),
                  jsx.jsxs('div', {
                    style: { minWidth: 0 },
                    children: [
                      jsx.jsx('div', { style: S.brandName, children: t('navLabel') }),
                      jsx.jsx('div', {
                        style: { fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary, inherit)', marginTop: 1 },
                        children: writable ? t('intro') : t('readonly'),
                      }),
                    ],
                  }),
                ],
              }),
              jsx.jsx('button', {
                style: dirty ? S.primary : S.primaryIdle,
                type: 'button',
                disabled: !dirty || !writable || busy,
                onClick: doSave,
                children: busy ? t('saving') : t('save'),
              }),
              jsx.jsx('button', {
                style: S.small,
                type: 'button',
                disabled: !dirty || busy,
                onClick: () => {
                  setDraft(null);
                  setMediaDraft(null);
                  setWebDraft(null);
                  // 模型列表也得还原：不然 libId 回到已保存的 provider A，
                  // 下拉里还是刚才切到 B 时抓来的选项，
                  // 用户挑一个就存成「A 的 baseURL + B 的 model」，静默失效。
                  setOptOverride({ imageGen: null, vision: null });
                  setStatus(null);
                },
                children: t('reset'),
              }),
            ],
          }),
          statusText ? jsx.jsx('div', { style: statusStyle, children: statusText }) : null,
          tabBar,
          hotApplyHint,
          body,
        ].filter(Boolean),
      });
    }

    /** 注册文案与设置页。 */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'dsh-hermes-feishu: settings copy');
      const t = ctx.locale.bind(LOCALE_NS);
      const softGet = (serviceName) => ctx.get(serviceName);
      const scope = resolveScope(softGet);
      if (scope === undefined) {
        console.warn('[dsh-hermes-feishu] 找不到配置作用域，设置卡片将只读');
      }
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'hermes-feishu',
            order: 450,
            label: () => t('navLabel'),
            inject: () => ({ t, scope }),
          },
          FeishuCard,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = name;
    return module.exports;
  },
});
