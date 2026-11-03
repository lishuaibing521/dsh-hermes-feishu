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
      secAgent: 'Agent 与模型',
      secProgress: '进度气泡',
      secMedia: '媒体',
      imageGenProvider: '图片生成 Provider',
      imageGenModel: '图片生成模型',
      visionProvider: '识别 Provider',
      visionModel: '识别模型',
      mediaUnavailable: '（未检测到 image-gen / modlens 插件）',
      imageGenHead: '图片生成（dsh-image-gen）',
      secWeb: '联网',
      webSearchProvider: '搜索 Provider',
      webFetchProvider: '抓取 Provider',
      webUnavailable: '（未检测到 web 运行时）',
      sttHead: '语音转文字',
      sttProvider: '识别 Provider',
      ttsProvider: '合成 Provider',
      sttNoProvider: '没有已注册的识别 provider，请先安装 dsh-baidu-stt 或 SenseVoice',
      ttsNoProvider: '没有已注册的语音合成工具，请先装一个 TTS 插件（例如 dsh-baidu-tts）',
      ttsHead: '文字转语音',
      voiceCredsMissing: '缺少百度语音凭据，需要在 .env 里设置 BAIDU_VOICE_API_KEY 和 BAIDU_VOICE_SECRET_KEY',
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
      appSecretHint: '已保存的密钥不会回显，留空表示不改',
      domain: '服务区域',
      domainFeishu: '中国版（feishu）',
      domainLark: '国际版（lark）',
      domainHint:
        '国内注册的飞书应用必须选「中国版」。飞书和 Lark 是两套独立的开放平台，App ID / Secret 不通用，选错会连不上、收不到消息。改动后需要重启 dsh web 才生效。',
      botName: '机器人名称',
      defaultChatId: '默认会话 chat_id',
      agentModel: '主模型',
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
      secAgent: 'Agent & Models',
      secProgress: 'Progress Bubble',
      secMedia: 'Media',
      imageGenProvider: 'Image provider',
      imageGenModel: 'Image model',
      visionProvider: 'Vision provider',
      visionModel: 'Vision model',
      mediaUnavailable: '(image-gen / modlens not detected)',
      imageGenHead: 'Image generation (dsh-image-gen)',
      secWeb: 'Web',
      webSearchProvider: 'Search provider',
      webFetchProvider: 'Fetch provider',
      webUnavailable: '(web runtime not detected)',
      sttHead: 'Speech to text',
      sttProvider: 'STT provider',
      ttsProvider: 'Tool',
      sttNoProvider: 'No speech provider registered — install dsh-baidu-stt first',
      ttsNoProvider: 'No TTS tool registered — install a TTS plugin (e.g. dsh-baidu-tts)',
      ttsHead: 'Text to speech',
      voiceCredsMissing: 'Baidu voice credentials missing — set BAIDU_VOICE_API_KEY and BAIDU_VOICE_SECRET_KEY in .env',
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
      appSecretHint: 'Saved secrets are never echoed; leave blank to keep',
      domain: 'Region',
      domainFeishu: 'China (feishu)',
      domainLark: 'International (lark)',
      domainHint:
        'Apps registered on Feishu must stay on Feishu. Feishu and Lark are separate platforms — credentials are not interchangeable. Takes effect after restarting dsh web.',
      botName: 'Bot name',
      defaultChatId: 'Default chat_id',
      agentModel: 'Primary model',
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
    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 18, padding: '4px 2px' },
      intro: { fontSize: 13, opacity: 0.72, lineHeight: 1.6 },
      bar: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      status: { fontSize: 12, opacity: 0.75 },
      statusErr: { fontSize: 12, color: '#e5534b' },
      statusDirty: { fontSize: 12, color: '#d29922' },
      primary: {
        flex: '0 0 auto',
        background: 'var(--dsw-alias-bg-accent, #3b6ef0)',
        border: '1px solid var(--dsw-alias-bg-accent, #3b6ef0)',
        color: '#fff',
        borderRadius: 8,
        fontSize: 13,
        padding: '6px 18px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      section: {
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        border: '1px solid var(--dsw-alias-border-l2, #36373b)',
        background: 'var(--dsw-alias-bg-layer-2, #232529)',
        borderRadius: 12,
        padding: '14px 16px',
      },
      secTitle: { fontSize: 13, fontWeight: 600, letterSpacing: '0.02em', opacity: 0.9 },
      row: { display: 'flex', alignItems: 'center', gap: 10, minHeight: 32 },
      label: { width: 112, flexShrink: 0, fontSize: 13, opacity: 0.85 },
      input: {
        flex: 1,
        minWidth: 0,
        background: 'var(--dsw-alias-bg-layer-1, #1b1c1f)',
        border: '1px solid rgba(128, 128, 128, 0.45)',
        borderRadius: 8,
        color: 'inherit',
        fontSize: 13,
        padding: '6px 9px',
        fontFamily: 'inherit',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      /* 下拉不能带 overflow/ellipsis，否则会把原生箭头裁掉 */
      selectBase: {
        minWidth: 0,
        background: 'var(--dsw-alias-bg-layer-1, #1b1c1f)',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'rgba(128, 128, 128, 0.45)',
        outline: 'none',
        borderRadius: 8,
        color: 'inherit',
        fontSize: 13,
        padding: '6px 9px',
        fontFamily: 'inherit',
        cursor: 'pointer',
      },
      hint: { fontSize: 12, opacity: 0.55, marginLeft: 122, marginTop: -6 },
      small: {
        flex: '0 0 auto',
        background: 'var(--dsw-alias-bg-layer-3, #2c2e33)',
        border: '1px solid var(--dsw-alias-border-l2, #36373b)',
        color: 'inherit',
        borderRadius: 8,
        fontSize: 12,
        padding: '6px 14px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
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
        background: 'var(--dsw-alias-bg-layer-3, #2c2e33)',
        border: '1px solid var(--dsw-alias-border-l2, #36373b)',
        color: 'inherit',
        borderRadius: 8,
        cursor: 'pointer',
      },
      addBtn: {
        alignSelf: 'flex-start',
        background: 'var(--dsw-alias-bg-layer-3, #2c2e33)',
        border: '1px dashed var(--dsw-alias-border-l2, #36373b)',
        color: 'inherit',
        borderRadius: 8,
        fontSize: 12,
        padding: '5px 12px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      chainHint: { fontSize: 12, opacity: 0.55, lineHeight: 1.5 },
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

    function ProviderSelect({ providers, value, onChange, disabled, placeholder }) {
      return jsx.jsx(Select, {
        style: { flex: '0 1 170px' },
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

    function ModelSelect({ providers, provider, value, onChange, disabled, placeholder }) {
      const list = providers.find((p) => p.provider === provider)?.models ?? [];
      return jsx.jsx(Select, {
        style: { flex: '1 1 120px' },
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

    function TextRow({ label, value, onChange, disabled, placeholder }) {
      const [focus, setFocus] = react.useState(false);
      return jsx.jsxs('div', {
        style: S.row,
        children: [
          jsx.jsx('label', { style: S.label, children: label }),
          jsx.jsx('input', {
            style: S.input,
            type: 'text',
            value: value ?? '',
            placeholder: placeholder ?? '',
            disabled,
            onFocus: () => setFocus(true),
            onBlur: () => setFocus(false),
            onChange: (e) => onChange(e.target.value),
          }),
        ],
      });
    }

    function BoolRow({ label, checked, onChange, disabled }) {
      return jsx.jsxs('div', {
        style: S.row,
        children: [
          jsx.jsx('label', { style: S.label, children: label }),
          jsx.jsx('input', {
            type: 'checkbox',
            checked: checked === true,
            disabled,
            onChange: (e) => onChange(e.target.checked),
          }),
        ],
      });
    }

    function SelectRow({ label, value, options, onChange, disabled }) {
      return jsx.jsxs('div', {
        style: S.row,
        children: [
          jsx.jsx('label', { style: S.label, children: label }),
          jsx.jsx(Select, {
            style: { flex: '0 1 300px' },
            value: value ?? options[0].value,
            disabled,
            onChange: (e) => onChange(e.target.value),
            children: options.map((o) => jsx.jsx('option', { value: o.value, children: o.label }, o.value)),
          }),
        ],
      });
    }

    /** TTS 参数区所有控件的统一宽度——长短一致才算排好版。 */
    const FIELD_W = { flex: '0 1 260px', minWidth: 0 };

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

    /** 整数参数：整数输入框 + 步进按钮，不做滑块（滑块表达不了「必须是整数」）。 */
    function IntegerRow({ label, value, fallback, onChange, disabled, hint }) {
      const cur = Number.isFinite(Number(value)) ? Math.round(Number(value)) : fallback;
      // 输入过程中的原始字符串单独存一份：如果直接受控成数字，
      // 用户退格清空时 onChange 拿到的 '' 被忽略、state 不变，
      // React 又把输入框刷回旧值 —— 想从 5 改成 7 根本删不掉。
      const [buf, setBuf] = react.useState(null);
      const shown = buf ?? String(cur);
      return jsx.jsxs('div', {
        style: S.row,
        title: hint ?? '',
        children: [
          jsx.jsx('label', { style: S.label, children: label }),
          jsx.jsx('input', {
            style: { ...S.input, ...FIELD_W, textAlign: 'center' },
            type: 'number',
            step: 1,
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
              // 失焦时才把空值补回默认值，让显示和真实 state 一致
              if (buf === '' || !Number.isFinite(Number(buf))) onChange(fallback);
              setBuf(null);
            },
          }),
        ],
      });
    }


    function NumberRow({ label, value, min, max, step, onChange, disabled }) {
      const v = typeof value === 'number' ? value : min;
      return jsx.jsxs('div', {
        style: S.row,
        children: [
          jsx.jsx('label', { style: S.label, children: label }),
          jsx.jsx('input', {
            type: 'range',
            min,
            max,
            step,
            value: v,
            disabled,
            style: { flex: 1, minWidth: 0 },
            onChange: (e) => onChange(Number(e.target.value)),
          }),
          jsx.jsx('span', { style: { width: 44, textAlign: 'center', fontSize: 12, opacity: 0.7 }, children: String(v) }),
        ],
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
        const changed = [];
        for (const f of fields) {
          if (f === 'appSecret') continue;
          if (JSON.stringify(saved[f] ?? null) !== JSON.stringify(next[f] ?? null)) changed.push(f);
        }
        const secret = typeof next.appSecret === 'string' ? next.appSecret : '';
        if (!changed.length && !secret && !mediaDirty && !webDirty) {
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
          if (secret) {
            const ok = await scope.set('appSecret', secret);
            if (ok === false) rejected.push('appSecret');
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

      const rows = [];
      // 生效范围说明：避免用户以为所有项都要重启
      rows.push(jsx.jsx('div', { key: 'hotApplyHint', style: { fontSize: 12, opacity: 0.7, marginBottom: 8 }, children: t('hotApplyHint') }));
      const sec = (title, children) =>
        rows.push(
          jsx.jsxs('div', { style: S.section, children: [jsx.jsx('div', { style: S.secTitle, children: title }), ...children] }, title),
        );

      // ── 飞书应用 ──
      sec(t('secFeishu'), [
        jsx.jsx(TextRow, {
          key: 'appId',
          label: t('appId'),
          value: value.appId,
          disabled: !writable,
          onChange: (v) => set('appId', v),
        }),
        jsx.jsx(TextRow, {
          key: 'appSecret',
          label: t('appSecret'),
          value: value.appSecret,
          placeholder: t('appSecretHint'),
          disabled: !writable,
          onChange: (v) => set('appSecret', v),
        }),
        jsx.jsx(SelectRow, {
          key: 'domain',
          label: t('domain'),
          value: value.domain ?? 'feishu',
          options: [
            { value: 'feishu', label: t('domainFeishu') },
            { value: 'lark', label: t('domainLark') },
          ],
          disabled: !writable,
          onChange: (v) => set('domain', v),
        }),
        jsx.jsx('div', {
          key: 'domainHint',
          style: { fontSize: 12, opacity: 0.6, lineHeight: 1.7, marginTop: -4 },
          children: t('domainHint'),
        }),
        jsx.jsx(TextRow, {
          key: 'botName',
          label: t('botName'),
          value: value.botName,
          disabled: !writable,
          onChange: (v) => set('botName', v),
        }),
        jsx.jsx(TextRow, {
          key: 'defaultChatId',
          label: t('defaultChatId'),
          value: value.defaultChatId,
          disabled: !writable,
          onChange: (v) => set('defaultChatId', v),
        }),
      ]);

      // ── Agent 与模型 ──
      sec(t('secAgent'), [
        jsx.jsxs(
          'div',
          {
            key: 'primary',
            style: S.row,
            children: [
              jsx.jsx('label', { style: S.label, children: t('agentModel') }),
              jsx.jsx(ProviderSelect, {
                providers,
                value: value.agentProvider,
                disabled: !writable || !catalog.ready,
                placeholder: t('pickProvider'),
                onChange: (p) => {
                  const first = providers.find((x) => x.provider === p)?.models?.[0]?.id;
                  setDraft({ ...(draft ?? saved), agentProvider: p, ...(first ? { agentModel: first } : {}) });
                  setStatus(null);
                },
              }),
              jsx.jsx(ModelSelect, {
                providers,
                provider: value.agentProvider,
                value: value.agentModel,
                disabled: !writable || !catalog.ready,
                placeholder: t('pickModel'),
                onChange: (m) => set('agentModel', m),
              }),
            ],
          },
          'primary',
        ),
        catalog.error
          ? jsx.jsx('div', { key: 'catErr', style: S.hint, children: t('catalogFailed') + ': ' + catalog.error })
          : null,
        jsx.jsxs(
          'div',
          {
            key: 'chain',
            style: { ...S.row, alignItems: 'flex-start' },
            children: [
              jsx.jsx('label', { style: { ...S.label, paddingTop: 6 }, children: t('fallbackModels') }),
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
        return jsx.jsxs(
          'div',
          {
            style: {
              marginTop: 6,
              marginBottom: 6,
              padding: '8px 10px',
              borderRadius: 8,
              fontSize: 12,
              lineHeight: 1.7,
              border: `1px solid ${ok && !credsBad ? 'rgba(63,185,80,0.45)' : 'rgba(210,153,34,0.55)'}`,
              background: ok && !credsBad ? 'rgba(63,185,80,0.08)' : 'rgba(210,153,34,0.10)',
            },
            children: [
              jsx.jsx('div', {
                style: { fontWeight: 600 },
                children: `${key} — ${ok ? t('depInstalled') : t('depMissing')}${dep.version ? ' v' + dep.version : ''}`,
              }),
              jsx.jsx('div', { style: { opacity: 0.75 }, children: dep.purpose }),
              ok
                ? null
                : jsx.jsxs('div', {
                    style: { marginTop: 4 },
                    children: [
                      jsx.jsx('div', { style: { opacity: 0.85, fontWeight: 600 }, children: t('depHowTo') }),
                      jsx.jsx('code', {
                        style: {
                          display: 'block',
                          marginTop: 2,
                          padding: '6px 8px',
                          borderRadius: 6,
                          fontFamily: 'var(--dsh-font-family-code, monospace)',
                          fontSize: 11,
                          background: 'rgba(127,127,127,0.16)',
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

      const libSelect = (target, current, onPick) =>
        jsx.jsx(Select, {
          style: { flex: '0 1 200px' },
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

      const modelSelect = (target, current, options) => {
        const opts = options ?? [];
        if (!opts.length) {
          return jsx.jsx('span', { style: { fontSize: 12, opacity: 0.55 }, children: t('noModelOptions') });
        }
        return jsx.jsx(Select, {
          style: { flex: '1 1 200px' },
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
            jsx.jsx('div', { key: 'imgHead', style: { fontSize: 13, opacity: 0.85, marginTop: 4 }, children: t('imageGenHead') }),
            jsx.jsxs(
              'div',
              {
                key: 'imgProvider',
                style: S.row,
                children: [
                  jsx.jsx('label', { style: S.label, children: t('imageGenProvider') }),
                  libSelect('imageGen', imageGen.libId, (v) => {
                    setMedia('imageGen', { libId: v, model: '' });
                    refreshModels('imageGen', v);
                  }),
                ],
              },
              'imgProvider',
            ),
            jsx.jsxs(
              'div',
              {
                key: 'imgModelRow',
                style: S.row,
                children: [
                  jsx.jsx('label', { style: S.label, children: t('imageGenModel') }),
                  modelSelect('imageGen', imageGen.model, optOverride.imageGen ?? imageGen.modelOptions),
                ],
              },
              'imgModelRow',
            ),
          );
        }

        if (vision?.ok) {
          mediaRows.push(
            depCard('@liustack/modlens'),
            jsx.jsx('div', { key: 'visHead', style: { fontSize: 13, opacity: 0.85, marginTop: 10 }, children: t('visionHead') }),
            jsx.jsxs(
              'div',
              {
                key: 'visProvider',
                style: S.row,
                children: [
                  jsx.jsx('label', { style: S.label, children: t('visionProvider') }),
                  libSelect('vision', vision.libId, (v) => {
                    setMedia('vision', { libId: v, model: '' });
                    refreshModels('vision', v);
                  }),
                ],
              },
              'visProvider',
            ),
            jsx.jsxs(
              'div',
              {
                key: 'visModelRow',
                style: S.row,
                children: [
                  jsx.jsx('label', { style: S.label, children: t('visionModel') }),
                  modelSelect('vision', vision.model, optOverride.vision ?? vision.modelOptions),
                ],
              },
              'visModelRow',
            ),
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

        const ttsProviders = voice.tts?.providers ?? [];
        // 老配置里可能存着已经卸掉的 TTS 工具名，不在候选里就退回后端解析出的那个
        const ttsSavedCandidate = value.ttsTool;
        const ttsCurrent = ttsProviders.some((p) => p.id === ttsSavedCandidate)
          ? ttsSavedCandidate
          : voice.tts?.provider ?? ttsProviders[0]?.id ?? '';

        const voiceRows = [
          depWarn('dsh-baidu-stt'),
          jsx.jsx('div', { key: 'sttHead', style: { fontSize: 13, opacity: 0.85, marginTop: 6 }, children: t('sttHead') }),
          sttProviders.length === 0
            ? jsx.jsx('div', { key: 'sttEmpty', style: { fontSize: 12, opacity: 0.65 }, children: t('sttNoProvider') })
            : jsx.jsxs(
                'div',
                {
                  key: 'sttProvider',
                  style: S.row,
                  children: [
                    jsx.jsx('label', { style: S.label, children: t('sttProvider') }),
                    jsx.jsx(Select, {
                      style: FIELD_W,
                      value: activeStt?.id ?? '',
                      disabled: !writable,
                      onChange: (e) => {
                        const next = sttProviders.find((p) => p.id === e.target.value);
                        const patch = { sttProvider: e.target.value };
                        // 换 provider 时把语言拉回它支持的第一个，避免存出不支持的组合。
                        // 必须和 provider 一起提交，分开两次 set 会互相覆盖。
                        if (next && !next.languages.includes(value.sttLanguage ?? 'auto')) {
                          patch.sttLanguage = next.languages[0] ?? 'auto';
                        }
                        set(patch);
                      },
                      children: sttProviders.map((provider) =>
                        jsx.jsx('option', { value: provider.id, children: provider.name }, provider.id),
                      ),
                    }),
                  ],
                },
                'sttProvider',
              ),
          jsx.jsxs(
            'div',
            {
              key: 'sttLang',
              style: S.row,
              children: [
                jsx.jsx('label', { style: S.label, children: t('sttLanguage') }),
                jsx.jsx(Select, {
                      style: FIELD_W,
                  value: value.sttLanguage ?? 'auto',
                  disabled: !writable || sttProviders.length === 0,
                  onChange: (e) => set('sttLanguage', e.target.value),
                  children: [
                    // 已保存的语言可能不在当前 provider 的支持列表里
                    //（换过 provider、手工改过配置、provider 升级后缩了能力）。
                    // 不补一个兜底 option 的话，受控组件找不到匹配项会渲染成
                    // 空选择 —— 界面显示和真实保存值对不上。
                    ...(value.sttLanguage && !sttLanguages.includes(value.sttLanguage)
                      ? [
                          jsx.jsx(
                            'option',
                            {
                              value: value.sttLanguage,
                              children: `${LANG_LABELS[value.sttLanguage] ?? value.sttLanguage}（当前）`,
                            },
                            '__cur',
                          ),
                        ]
                      : []),
                    ...sttLanguages.map((lang) =>
                      jsx.jsx('option', { value: lang, children: LANG_LABELS[lang] ?? lang }, lang),
                    ),
                  ],
                }),
              ],
            },
            'sttLang',
          ),
          depWarn('dsh-baidu-tts'),
          jsx.jsx('div', { key: 'ttsHead', style: { fontSize: 13, opacity: 0.85, marginTop: 6 }, children: t('ttsHead') }),
          ttsProviders.length === 0
            ? jsx.jsx('div', { key: 'ttsEmpty', style: { fontSize: 12, opacity: 0.65 }, children: t('ttsNoProvider') })
            : jsx.jsxs(
                'div',
                {
                  key: 'ttsProvider',
                  style: S.row,
                  children: [
                    jsx.jsx('label', { style: S.label, children: t('ttsProvider') }),
                    jsx.jsx(Select, {
                      style: FIELD_W,
                      value: ttsCurrent,
                      disabled: !writable,
                      onChange: (e) => set({ ttsTool: e.target.value, ttsArgs: '' }),
                      children: ttsProviders.map((provider) =>
                        jsx.jsx(
                          'option',
                          {
                            value: provider.id,
                            children: provider.name,
                          },
                          provider.id,
                        ),
                      ),
                    }),
                  ],
                },
                'ttsProvider',
              ),
        ];

        // ── TTS 参数：完全按所选工具声明的 inputSchema 生成 ──
        // 不在前端写死任何厂商字段：工具声明什么，这里就出什么控件。
        // 参数整体以 JSON 字符串存进 ttsArgs，换工具时旧值会被后端按新 schema 过滤。
        const readJsonObject = (raw) => {
          try {
            const parsed = JSON.parse(typeof raw === 'string' ? raw : '{}');
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
          } catch {
            return {};
          }
        };
        const currentTtsArgs = readJsonObject(value.ttsArgs);
        const setTtsArg = (name, v) => set('ttsArgs', JSON.stringify({ ...currentTtsArgs, [name]: v }));
        // 从当前下拉选中的那个工具取 schema（不必先保存），切工具即刻换表单
        const ttsProperties = (ttsProviders.find((p) => p.id === ttsCurrent) ?? voice.tts)?.properties ?? {};

        for (const [name, prop] of Object.entries(ttsProperties)) {
          // text 是调用时由运行时传的，不需要在这里配
          if (name === 'text') continue;
          if (!prop || typeof prop !== 'object') continue;
          // 标签：优先 title（写给人看的名字），退化到参数名
          const label = typeof prop.title === 'string' && prop.title ? prop.title : name;
          const hint = typeof prop.description === 'string' ? prop.description : '';
          const cur = currentTtsArgs[name] ?? prop.default;
          const rowKey = `ttsArg-${name}`;
          const opts = optionsOf(prop);

          // ── ① 可枚举 → 选择框（发音人这类就是走这里）──
          if (opts) {
            voiceRows.push(
              jsx.jsxs(
                'div',
                {
                  key: rowKey,
                  style: S.row,
                  title: hint,
                  children: [
                    jsx.jsx('label', { style: S.label, children: label }),
                    jsx.jsx(Select, {
                      style: FIELD_W,
                      value: cur === undefined ? String(opts[0].value) : String(cur),
                      disabled: !writable,
                      onChange: (e) => {
                        // 回到原类型：数字枚举存数字，其余存字符串
                        const hit = opts.find((o) => String(o.value) === e.target.value);
                        setTtsArg(name, hit ? hit.value : e.target.value);
                      },
                      children: opts.map((o) =>
                        jsx.jsx('option', { value: String(o.value), children: o.label }, String(o.value)),
                      ),
                    }),
                  ],
                },
                rowKey,
              ),
            );
          // ── ② 整数 → 整数输入框（语速/音调/音量只能是整数）──
          } else if (prop.type === 'integer' || (prop.multipleOf === 1 && prop.type === 'number')) {
            voiceRows.push(
              jsx.jsx(IntegerRow, {
                key: rowKey,
                label,
                hint,
                value: cur,
                fallback: Number.isFinite(Number(prop.default)) ? Number(prop.default) : 0,
                disabled: !writable,
                onChange: (v) => setTtsArg(name, v),
              }),
            );
          // ── ③ 小数 → 滑块 ──
          } else if (prop.type === 'number') {
            voiceRows.push(
              jsx.jsx(NumberRow, {
                key: rowKey,
                label,
                value: cur === undefined ? 0 : Number(cur),
              // 别拿 default 当上下界：default 一填 min===max，滑块就锁死。
              min: 0,
              max: Math.max(Number(prop.default) * 2 || 0, 1),
                step: 0.1,
                disabled: !writable,
                onChange: (v) => setTtsArg(name, v),
              }),
            );
          } else if (prop.type === 'boolean') {
            voiceRows.push(
              jsx.jsxs(
                'div',
                {
                  key: rowKey,
                  style: S.row,
                  title: hint,
                  children: [
                    jsx.jsx('label', { style: S.label, children: label }),
                    jsx.jsx('input', {
                      type: 'checkbox',
                      checked: cur === true,
                      disabled: !writable,
                      onChange: (e) => setTtsArg(name, e.target.checked),
                    }),
                  ],
                },
                rowKey,
              ),
            );
          } else {
            voiceRows.push(
              jsx.jsxs(
                'div',
                {
                  key: rowKey,
                  style: S.row,
                  title: hint,
                  children: [
                    jsx.jsx('label', { style: S.label, children: label }),
                    jsx.jsx('input', {
                      style: { ...S.input, ...FIELD_W },
                      type: 'text',
                      value: cur === undefined ? '' : String(cur),
                      disabled: !writable,
                      onChange: (e) => setTtsArg(name, e.target.value),
                    }),
                  ],
                },
                rowKey,
              ),
            );
          }
        }
        sec(t('voiceHead'), voiceRows);
      }

      // ── 联网 ──
      if (media.ready && webValue) {
        const webProviderSelect = (label, current, options, field) =>
          jsx.jsxs(
            'div',
            {
              key: field,
              style: S.row,
              children: [
                jsx.jsx('label', { style: S.label, children: label }),
                jsx.jsx(Select, {
                   style: FIELD_W,
                  value: current ?? '',
                  disabled: !writable || !options.length,
                  onChange: (e) => setWebDraft({ ...(webDraft ?? webSaved ?? {}), [field]: e.target.value }),
                  children: [
                    jsx.jsx('option', { value: '', disabled: true, children: t('pickProvider') }, '__ph'),
                    ...options.map((p) =>
                      jsx.jsx(
                        'option',
                        {
                          value: p.id,
                          children: p.available ? p.id : `${p.id}（不可用）`,
                          disabled: p.available !== true,
                        },
                        p.id,
                      ),
                    ),
                  ],
                }),
              ],
            },
            field,
          );

        const webRows = [
          webProviderSelect(t('webSearchProvider'), webValue.searchProvider, webValue.searchProviderOptions ?? [], 'searchProvider'),
          webProviderSelect(t('webFetchProvider'), webValue.fetchProvider, webValue.fetchProviderOptions ?? [], 'fetchProvider'),
        ];
        sec(t('secWeb'), webRows);
      } else if (media.ready) {
        sec(t('secWeb'), [jsx.jsx('div', { style: { fontSize: 12, opacity: 0.6 }, children: t('webUnavailable') })]);
      }

      // ── 进度气泡 ──
      sec(t('secProgress'), [
        jsx.jsx(BoolRow, {
          key: 'thinkingEnabled',
          label: t('thinkingEnabled'),
          checked: value.thinkingEnabled,
          disabled: !writable,
          onChange: (v) => set('thinkingEnabled', v),
        }),
        jsx.jsx(BoolRow, {
          key: 'thinkingFilterUserEcho',
          label: t('thinkingFilterUserEcho'),
          checked: value.thinkingFilterUserEcho,
          disabled: !writable,
          onChange: (v) => set('thinkingFilterUserEcho', v),
        }),
        jsx.jsx(NumberRow, {
          key: 'toolPreviewChars',
          label: t('toolPreviewChars'),
          value: value.toolPreviewChars ?? 60,
          min: 20,
          max: 200,
          step: 10,
          disabled: !writable,
          onChange: (v) => set('toolPreviewChars', v),
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

      return jsx.jsxs('div', {
        style: S.wrap,
        children: [
          jsx.jsx('div', { style: S.intro, children: writable ? t('intro') : t('readonly') }),
          jsx.jsxs('div', {
            style: S.bar,
            children: [
              jsx.jsx('button', {
                style: dirty ? S.primary : { ...S.primary, opacity: 0.45, cursor: 'default' },
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
              jsx.jsx('span', { style: statusStyle, children: statusText }),
            ],
          }),
          ...rows,
        ],
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
