/* Theme (light → dark → system) and language (en → zh) shared by every page. */
(() => {
    'use strict';

    const THEME_KEY = 'msdl-theme';
    const LANG_KEY = 'msdl-lang';
    const root = document.documentElement;
    const media = window.matchMedia('(prefers-color-scheme: dark)');

    /* ------------------------------- theme ------------------------------- */
    const resolve = (mode) => (mode === 'auto' ? (media.matches ? 'dark' : 'light') : mode);

    function applyTheme(mode, persist = true) {
        root.dataset.themeMode = mode;
        root.dataset.theme = resolve(mode);
        document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
            button.setAttribute('aria-label', `Theme: ${mode} — switch`);
            button.dataset.mode = mode;
        });
        if (persist) {
            try { localStorage.setItem(THEME_KEY, mode); } catch { /* ignore */ }
        }
    }

    function cycleTheme() {
        const order = ['light', 'dark', 'auto'];
        const next = order[(order.indexOf(root.dataset.themeMode ?? 'light') + 1) % order.length];
        applyTheme(next);
    }

    media.addEventListener('change', () => {
        if ((root.dataset.themeMode ?? 'light') === 'auto') applyTheme('auto', false);
    });

    /* ------------------------------ language ----------------------------- */
    const STRINGS = {
        zh: {
            'nav.catalog': '产品目录',
            'nav.chocolatey': 'Chocolatey',
            'nav.office': 'Office',
            'nav.activation': '激活',
            'nav.source': '源码',
            'hero.eyebrow': 'Microsoft 软件下载',
            'hero.title1': '每一份官方 Windows 版本，',
            'hero.title2': '都在一个地方。',
            'hero.lede': '零售版、Arm64 与 Server 镜像，全部读取自微软官方目录，每晚校验，直达下载服务器。',
            'search.label': '搜索产品',
            'search.placeholder': '按版本、版本号、build 或架构筛选',
            'catalog.choose': '选择产品',
            'catalog.select': '选择一个版本…',
            'catalog.jump': '快速前往',
            'catalog.updated': '更新于',
            'detail.back': '全部版本',
            'detail.language': '选择语言',
            'detail.languages': '语言',
            'detail.version': '版本',
            'detail.build': 'Build',
            'detail.arch': '架构',
            'detail.channel': '通道',
            'detail.retail': '零售',
            'detail.evaluation': '评估版',
            'detail.chooseLanguage': '选择语言',
            'detail.languageNote': '安装 Windows 时请选择相同语言。',
            'detail.evalLanguageNote': '微软为每种语言发布独立的评估版 ISO。',
            'detail.links': '下载链接',
            'detail.linksNote': '链接由微软生成，通常在 24 小时后失效。',
            'detail.evalLinks': '官方评估版下载',
            'detail.evalLinksNote': '即将前往微软评估中心，文件由微软直接提供。',
            'detail.another': '换一个语言',
            'detail.retry': '重试',
            'detail.ms': '打开微软下载页',
            'footer.note': '微软软件的第三方索引。下载由微软提供，MSDL 与微软无关。',
        },
    };

    const t = (key, fallback = '') => (STRINGS[document.documentElement.lang] ?? {})[key] ?? fallback;

    function applyLanguage(lang, persist = true) {
        const next = lang === 'zh' ? 'zh' : 'en';
        root.lang = next;
        document.querySelectorAll('[data-i18n]').forEach((node) => {
            const key = node.dataset.i18n;
            if (!node.dataset.en) node.dataset.en = node.innerHTML;
            node.innerHTML = next === 'zh' ? t(key, node.dataset.en) : node.dataset.en;
        });
        document.querySelectorAll('[data-lang-toggle]').forEach((button) => {
            button.textContent = next === 'zh' ? 'EN' : '中文';
            button.setAttribute('aria-label', next === 'zh' ? 'Switch to English' : '切换到中文');
        });
        document.querySelectorAll('[data-i18n-placeholder]').forEach((node) => {
            const key = node.dataset.i18nPlaceholder;
            if (!node.dataset.enPlaceholder) node.dataset.enPlaceholder = node.placeholder;
            node.placeholder = next === 'zh' ? t(key, node.dataset.enPlaceholder) : node.dataset.enPlaceholder;
        });
        if (persist) {
            try { localStorage.setItem(LANG_KEY, next); } catch { /* ignore */ }
        }
    }

    /* -------------------------------- boot -------------------------------- */
    let storedTheme = 'auto';
    let storedLang = navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
    try {
        storedTheme = localStorage.getItem(THEME_KEY) ?? storedTheme;
        storedLang = localStorage.getItem(LANG_KEY) ?? storedLang;
    } catch { /* ignore */ }

    applyTheme(storedTheme, false);
    applyLanguage(storedLang, false);

    document.addEventListener('click', (event) => {
        if (event.target.closest('[data-theme-toggle]')) return cycleTheme();
        if (event.target.closest('[data-lang-toggle]')) {
            return applyLanguage(document.documentElement.lang === 'zh' ? 'en' : 'zh');
        }
    });
})();
