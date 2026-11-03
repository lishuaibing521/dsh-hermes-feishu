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
      ttsNoProvider: '没有已安装的合成插件，请先安装 dsh-baidu-tts',
      ttsHead: '文字转语音',
      voiceCredsMissing: '缺少百度语音凭据，需要在 .env 里设置 BAIDU_VOICE_API_KEY 和 BAIDU_VOICE_SECRET_KEY',
      voiceCredsOk: '百度语音凭据已配置',
      depMissing: '未安装',
      depInstalled: '已安装',
      depHowTo: '安装方式',
      depAfterInstall: '装完重启 dsh web 生效',
      ttsVoice: '音色',
      ttsSpeed: '语速',
      ttsPitch: '音调',
      ttsVolume: '音量',
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
      ttsProvider: 'TTS provider',
      sttNoProvider: 'No speech provider registered — install dsh-baidu-stt first',
      ttsNoProvider: 'No TTS plugin installed — install dsh-baidu-tts first',
      ttsHead: 'Text to speech',
      voiceCredsMissing: 'Baidu voice credentials missing — set BAIDU_VOICE_API_KEY and BAIDU_VOICE_SECRET_KEY in .env',
      voiceCredsOk: 'Baidu voice credentials configured',
      depMissing: 'Not installed',
      depInstalled: 'Installed',
      depHowTo: 'How to install',
      depAfterInstall: 'Restart dsh web after installing',
      ttsVoice: 'Voice',
      ttsSpeed: 'Speed',
      ttsPitch: 'Pitch',
      ttsVolume: 'Volume',
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

    /** 百度语音音色表（跟 tts.js 保持一致）。 */
    const VOICE_LABELS = {
      0: '度小美（女声）',
      1: '度小宇（男声）',
      3: '度逍遥（男声）',
      4: '度丫丫（童声）',
      5003: '度逍遥（情感男声）',
    };

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
          jsx.jsx('span', { style: { width: 44, textAlign: 'right', fontSize: 12, opacity: 0.7 }, children: String(v) }),
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
      /** 联网 provider 草稿。 */
      const [webDraft, setWebDraft] = react.useState(null);
      const [busy, setBusy] = react.useState(false);
      const [status, setStatus] = react.useState(null);

      const saved = snap?.value ?? {};
      const writable = snap?.writable === true;
      const value = draft ?? saved;
      const dirty = draft !== null || mediaDraft !== null || webDraft !== null;

      const refreshModels = (target, provider) => {
        fetch(`${MEDIA_MODELS_URL}?target=${target}&provider=${encodeURIComponent(provider)}`, {
          headers: { accept: 'application/json' },
        })
          .then((r) => (r.ok ? r.json() : { options: [] }))
          .then((d) => setOptOverride((prev) => ({ ...prev, [target]: d.options ?? [] })))
          .catch(() => setOptOverride((prev) => ({ ...prev, [target]: [] })));
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

      const set = (field, next) => {
        setDraft({ ...(draft ?? saved), [field]: next });
        setStatus(null);
      };

      const doSave = async () => {
        const next = draft ?? {};
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
          for (const f of changed) await scope.set(f, next[f]);
          if (secret) await scope.set('appSecret', secret);
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
          window.setTimeout(() => setStatus(null), 3000);
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
        // 老配置里可能存着已改名的 provider id，不在候选里就退回后端解析出的那个
        const ttsSavedCandidate = value.ttsProvider;
        const ttsCurrent = ttsProviders.some((p) => p.id === ttsSavedCandidate)
          ? ttsSavedCandidate
          : voice.tts?.provider ?? ttsProviders[0]?.id ?? '';

        const voiceRows = [
          depCard('dsh-baidu-stt'),
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
                      style: { flex: '0 1 260px' },
                      value: activeStt?.id ?? '',
                      disabled: !writable,
                      onChange: (e) => {
                        const next = sttProviders.find((p) => p.id === e.target.value);
                        set('sttProvider', e.target.value);
                        // 换 provider 时把语言拉回它支持的第一个，避免不支持的组合
                        if (next && !next.languages.includes(value.sttLanguage ?? 'auto')) {
                          set('sttLanguage', next.languages[0] ?? 'auto');
                        }
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
                  style: { flex: '0 1 220px' },
                  value: value.sttLanguage ?? 'auto',
                  disabled: !writable || sttProviders.length === 0,
                  onChange: (e) => set('sttLanguage', e.target.value),
                  children: sttLanguages.map((lang) =>
                    jsx.jsx('option', { value: lang, children: LANG_LABELS[lang] ?? lang }, lang),
                  ),
                }),
              ],
            },
            'sttLang',
          ),
          depCard('dsh-baidu-tts'),
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
                      style: { flex: '0 1 260px' },
                      value: ttsCurrent,
                      disabled: !writable,
                      onChange: (e) => set('ttsProvider', e.target.value),
                      children: ttsProviders.map((provider) =>
                        jsx.jsx(
                          'option',
                          {
                            value: provider.id,
                            children: provider.version ? `${provider.name} ${provider.version}` : provider.name,
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

        // 音色下拉
        voiceRows.push(
          jsx.jsxs(
            'div',
            {
              key: 'ttsVoice',
              style: S.row,
              children: [
                jsx.jsx('label', { style: S.label, children: t('ttsVoice') }),
                jsx.jsx(Select, {
                  style: { flex: '0 1 240px' },
                  value: String(value.ttsVoice ?? '0'),
                  disabled: !writable,
                  onChange: (e) => set('ttsVoice', e.target.value),
                  children: Object.entries(VOICE_LABELS).map(([k, label]) =>
                    jsx.jsx('option', { value: k, children: label }, k),
                  ),
                }),
              ],
            },
            'ttsVoice',
          ),
        );

        // 语速 / 音调 / 音量
        for (const [key, label, field] of [
          ['ttsSpeed', t('ttsSpeed'), 'ttsSpeed'],
          ['ttsPitch', t('ttsPitch'), 'ttsPitch'],
          ['ttsVolume', t('ttsVolume'), 'ttsVolume'],
        ]) {
          voiceRows.push(
            jsx.jsx(NumberRow, {
              key,
              label,
              value: Number(value[field] ?? 5),
              min: 0,
              max: 15,
              step: 1,
              disabled: !writable,
              onChange: (v) => set(field, v),
            }),
          );
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
                  style: { flex: '0 1 280px' },
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
