/* Theme (light → dark → system) and language (en → zh) shared by every page. */
(() => {
    'use strict';

    const THEME_KEY = 'msdl-theme';
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

    /* -------------------------------- boot -------------------------------- */
    let storedTheme = 'auto';
    try {
        storedTheme = localStorage.getItem(THEME_KEY) ?? storedTheme;
    } catch { /* ignore */ }

    applyTheme(storedTheme, false);

    document.addEventListener('click', (event) => {
        if (event.target.closest('[data-theme-toggle]')) return cycleTheme();
    });
})();
