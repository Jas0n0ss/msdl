/* ==========================================================================
   MSDL — product catalogue and download flow
   Vanilla ES2020, no build step. Data comes from data/products.json, which is
   regenerated nightly by tools/update-products.mjs (see .github/workflows).
   ========================================================================== */

(() => {
    'use strict';

    const API_BASE = (
        document.querySelector('meta[name="msdl-api"]')?.getAttribute('content') ||
        'https://api.gravesoft.dev/msdl'
    ).replace(/\/+$/, '');
    const MICROSOFT_DOWNLOAD_PAGE = 'https://www.microsoft.com/software-download';
    const THEME_KEY = 'msdl-theme';
    const STALE_AFTER_MS = 36 * 60 * 60 * 1000;

    const state = {
        data: null,
        query: '',
        family: 'all',
        product: null,
        step: 'languages', // languages | links
        selectedSku: null,
        languages: [],
        links: [],
        loading: false,
        error: null,
        requestId: 0,
    };

    const el = {};

    const ICON_PATHS = {
        'arrow-right': '<path d="M4 10h11m0 0-4.4-4.4M15 10l-4.4 4.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
        'arrow-left': '<path d="M16 10H5m0 0 4.4-4.4M5 10l4.4 4.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
        external: '<path d="M8 4.2h7.8V12M15.8 4.2 6.2 13.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
        download: '<path d="M10 3v8.4m0 0 3.2-3.2M10 11.4 6.8 8.2M4 16h12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
        alert: '<path d="M10 3.2 18 17H2L10 3.2Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M10 7.6v3.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="10" cy="14" r=".95" fill="currentColor"/>',
        copy: '<rect x="7" y="7" width="9.5" height="9.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M13 4.6A2.1 2.1 0 0 0 11 3.5H5.6A2.1 2.1 0 0 0 3.5 5.6V11a2.1 2.1 0 0 0 1.1 1.9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
        check: '<path d="m4 10.6 3.9 3.9L16 6.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
        info: '<circle cx="10" cy="10" r="7.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10 9v4.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="10" cy="6.4" r=".95" fill="currentColor"/>',
        search: '<circle cx="8.8" cy="8.8" r="5.4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m13 13 3.8 3.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    };

    const icon = (name, className = '') =>
        `<svg class="icon${className ? ` ${className}` : ''}" aria-hidden="true" focusable="false" viewBox="0 0 20 20">${ICON_PATHS[name] ?? ''}</svg>`;

    const tr = (text) => window.msdlI18n?.translate(text) ?? text;

    const escapeHtml = (value) =>
        String(value ?? '').replace(/[&<>"']/g, (character) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
        })[character]);

    const plural = (count, singular, pluralForm = `${singular}s`) =>
        `${count} ${count === 1 ? singular : pluralForm}`;

    const pad2 = (value) => String(value).padStart(2, '0');

    const describeError = (error) =>
        /failed to fetch|networkerror|load failed/i.test(error?.message ?? '')
            ? 'The request to Microsoft could not be completed'
            : error?.message ?? 'Unknown error';

    const safeUrl = (value) => (/^https?:\/\//i.test(String(value ?? '')) ? String(value) : '#');

    const archLabel = (arch) => (arch === 'arm64' ? 'Arm64' : arch === 'x64' ? 'x64' : '');

    const LOCALE_LABELS = {
        'en-US': 'English (United States)',
        'en-GB': 'English (United Kingdom)',
        'zh-CN': 'Chinese (Simplified)',
        'zh-TW': 'Chinese (Traditional)',
        'fr-FR': 'French',
        'de-DE': 'German',
        'it-IT': 'Italian',
        'ja-JP': 'Japanese',
        'ko-KR': 'Korean',
        'es-ES': 'Spanish',
        'ru-RU': 'Russian',
        'pt-BR': 'Portuguese (Brazil)',
    };

    const languageName = (locale) => {
        if (LOCALE_LABELS[locale]) return LOCALE_LABELS[locale];
        try {
            const names = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'code' });
            const label = names.of(locale);
            return label ? label.charAt(0).toUpperCase() + label.slice(1) : locale;
        } catch {
            return locale;
        }
    };

    /** "Windows 11 26H2 (26300.9457)" -> { title: "Windows 11 26H2", build: "26300.9457" } */
    function splitName(name) {
        const match = String(name).match(/^(.*?)\s*\(([\d.]+)\)$/);
        return match ? { title: match[1], build: match[2] } : { title: String(name), build: null };
    }

    const buildOf = (product) => splitName(product.name).build ?? product.build ?? null;

    function debounce(fn, wait) {
        let timer;
        return (...args) => {
            clearTimeout(timer);
            timer = setTimeout(() => fn(...args), wait);
        };
    }

    /** Small, stable fingerprint of the catalogue timestamp — purely cosmetic. */
    function fingerprint(value) {
        let hash = 0x811c9dc5;
        for (let index = 0; index < value.length; index += 1) {
            hash ^= value.charCodeAt(index);
            hash = Math.imul(hash, 0x01000193) >>> 0;
        }
        return hash.toString(16).padStart(8, '0').slice(0, 6);
    }

    function relativeTime(date) {
        const delta = Date.now() - date.getTime();
        if (delta < 60_000) return 'just now';
        if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
        if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
        return `${Math.floor(delta / 86_400_000)}d ago`;
    }

    const utcDate = (date) =>
        date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });

    const utcTime = (date) =>
        `${date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC`;

    const utcStamp = (date) => `${utcDate(date)} · ${utcTime(date)}`;

    /* -------------------------------------------------------------- theme */

    const root = document.documentElement;


    /* --------------------------------------------------------- data + view */

    async function loadCatalog({ retry = false } = {}) {
        el.catalogBody.setAttribute('aria-busy', 'true');
        if (retry) el.catalogBody.innerHTML = skeletonCatalog(3);

        try {
            const response = await fetch('data/products.json', { cache: 'no-cache' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();

            if (!data || !Array.isArray(data.products) || data.products.length === 0) {
                throw new Error('The product list is empty.');
            }

            state.data = data;
            state.loading = false;
            state.error = null;
            el.catalogBody.setAttribute('aria-busy', 'false');

            renderManifest();
            renderFilters();
            renderCatalog();
            route({ fromLoad: true });
        } catch (error) {
            state.loading = false;
            state.error = error;
            el.catalogBody.setAttribute('aria-busy', 'false');
            renderCatalogError(error);
        }
    }

    /** Products matching the current family filter and search query. */
    function visibleProducts() {
        if (!state.data) return [];

        const family = state.family;
        const query = state.query.trim();
        const familyLabel = new Map((state.data.families ?? []).map((entry) => [entry.id, entry.label]));

        const haystack = (product) =>
            [
                product.name,
                product.version,
                product.build,
                archLabel(product.arch),
                familyLabel.get(product.family) ?? '',
            ]
                .filter(Boolean)
                .join(' ');

        let matcher = () => true;
        if (query) {
            try {
                const regex = new RegExp(query, 'i');
                matcher = (product) => regex.test(haystack(product));
            } catch {
                const needle = query.toLowerCase();
                matcher = (product) => haystack(product).toLowerCase().includes(needle);
            }
        }

        return state.data.products.filter((product) => {
            if (family !== 'all' && product.family !== family) return false;
            return matcher(product);
        });
    }

    /** The newest entry of each family, used for the "latest" flag. */
    function latestIds() {
        const seen = new Set();
        const ids = new Set();
        for (const product of state.data?.products ?? []) {
            if (product.family === 'windows-7') continue;
            if (seen.has(product.family)) continue;
            seen.add(product.family);
            ids.add(product.id);
        }
        return ids;
    }

    function renderManifest() {
        const updated = new Date(state.data?.updated ?? '');
        const valid = !Number.isNaN(updated.getTime());

        if (el.manifestUpdated) {
            el.manifestUpdated.textContent = valid ? utcDate(updated) : 'unknown';
            if (valid) el.manifestUpdated.title = `${utcStamp(updated)} (${relativeTime(updated)})`;
        }
        if (el.manifestEntries) el.manifestEntries.textContent = String(state.data?.products.length ?? 0);
        if (el.manifestFamilies) el.manifestFamilies.textContent = String(state.data?.families.length ?? 0);
        if (el.manifestId) el.manifestId.textContent = valid ? `#${fingerprint(state.data.updated)}` : '';

        if (el.manifestPulse && valid) {
            const stale = Date.now() - updated.getTime() > STALE_AFTER_MS;
            el.manifestPulse.classList.toggle('is-stale', stale);
            el.manifestPulse.title = stale ? 'Last sync is older than expected' : 'Synced recently';
        }

        if (el.catalogUpdated && valid) {
            el.catalogUpdated.textContent = `${tr('synced')} ${relativeTime(updated)}`;
            el.catalogUpdated.title = utcStamp(updated);
        }

        if (el.footerStamp) {
            el.footerStamp.textContent = valid
                ? `data/products.json · ${utcStamp(updated)} · ${plural(state.data.products.length, 'entry', 'entries')}`
                : 'data/products.json';
        }
    }

    function renderFilters() {
        if (!el.filters || !state.data) return;

        const products = state.data.products;
        const families = [
            { id: 'all', label: 'All releases', count: products.length },
            ...(state.data.families ?? []).map((family) => ({
                ...family,
                count: products.filter((product) => product.family === family.id).length,
            })),
        ];

        el.filters.innerHTML = families
            .map(
                (family) => `<button class="filter" type="button" data-family="${escapeHtml(family.id)}"
                    aria-pressed="${state.family === family.id}">
                    <span class="filter-label">${escapeHtml(family.label)}</span>
                    <span class="filter-count">${pad2(family.count)}</span>
                </button>`,
            )
            .join('');
    }

    function renderCatalog() {
        if (!state.data) return;

        const products = visibleProducts();
        const total = state.data.products.length;
        const isFiltered = state.query.trim() !== '' || state.family !== 'all';

        el.resultCount.textContent = isFiltered
            ? `${pad2(products.length)} / ${pad2(total)} ${tr('entries')}`
            : `${pad2(total)} ${tr('entries')}`;

        el.searchClear.hidden = state.query === '';

        if (products.length === 0) {
            el.catalogBody.innerHTML = `
                <div class="empty">
                    <p class="empty-title">Nothing matches ${state.query.trim() ? `“${escapeHtml(state.query.trim())}”` : 'this filter'}</p>
                    <p class="empty-note">Try a release such as 26H2, an edition such as Professional, a build number, or an architecture.</p>
                    <button class="button button-secondary" type="button" data-action="reset-filters">Show all releases</button>
                </div>`;
            return;
        }

        const families = state.data.families ?? [];
        const latest = latestIds();

        const options = families
            .map((family) => {
                const items = products.filter((product) => product.family === family.id);
                if (items.length === 0) return '';

                const rows = items
                    .map((product) => {
                        const { title } = splitName(product.name);
                        const build = buildOf(product);
                        const arch = archLabel(product.arch);
                        const meta = [build, arch].filter(Boolean).join(' · ');
                        const suffix = meta ? ` — ${meta}` : '';

                        return `<option value="${escapeHtml(product.id)}">${escapeHtml(title)}${escapeHtml(suffix)}${
                            latest.has(product.id) ? ' · latest' : ''
                        }</option>`;
                    })
                    .join('');

                return `<optgroup label="${escapeHtml(family.label)}">${rows}</optgroup>`;
            })
            .join('');

        // One quick entry per family, so the common cases stay one click away.
        const quick = families
            .filter((family) => family.id !== 'windows-7')
            .map((family) => state.data.products.find((product) => product.family === family.id))
            .filter(Boolean);

        el.catalogBody.innerHTML = `
            <div class="picker">
                <div class="picker-main">
                    <label class="picker-label" for="product-select">Choose a product</label>
                    <div class="select-wrap">
                        <select class="select" id="product-select">
                            <option value="" selected>Select a release…</option>
                            ${options}
                        </select>
                        <svg class="select-chevron" viewBox="0 0 20 20" aria-hidden="true" focusable="false">${ICON_PATHS['chevron-down'] ?? ''}</svg>
                    </div>
                </div>
                <div class="quick-picks">
                    <span class="picker-label">Jump to</span>
                    <div class="quick-pick-row">
                        ${quick
                            .map((product) => {
                                const { title } = splitName(product.name);
                                const build = buildOf(product);
                                return `<a class="quick-pick" href="#${encodeURIComponent(product.id)}">${escapeHtml(title)}${
                                    build ? `<span>${escapeHtml(build)}</span>` : ''
                                }</a>`;
                            })
                            .join('')}
                    </div>
                </div>
            </div>`;
    }

    function skeletonCatalog() {
        return `
            <div class="picker">
                <div class="skeleton skeleton-line" style="width:120px;height:10px;margin-bottom:10px"></div>
                <div class="skeleton" style="height:54px;border-radius:999px"></div>
                <div class="skeleton skeleton-line" style="width:46%;height:10px;margin-top:22px"></div>
            </div>`;
    }

    function renderCatalogError(error) {
        el.resultCount.textContent = 'unavailable';
        el.catalogBody.innerHTML = `
            <div class="alert" role="alert">
                ${icon('alert', 'alert-icon')}
                <div>
                    <p class="alert-title">The catalogue could not be loaded</p>
                    <p class="alert-body">${escapeHtml(error?.message ?? 'Unknown error.')} Check your connection and try again.</p>
                    <div class="alert-actions">
                        <button class="button" type="button" data-action="retry-catalog">Try again</button>
                    </div>
                </div>
            </div>`;
    }

    /* -------------------------------------------------------- detail view */

    function openProduct(id, { focus = true } = {}) {
        const product = state.data?.products.find((entry) => entry.id === id);
        if (!product) return;

        state.product = product;
        state.step = 'languages';
        state.selectedSku = null;
        state.languages = [];
        state.links = [];
        state.error = null;
        state.loading = product.source === 'connector';

        document.title = `${splitName(product.name).title} — MSDL`;
        el.hero.hidden = true;
        el.catalog.hidden = true;
        el.detail.hidden = false;

        renderDetail();

        if (state.loading) {
            loadLanguages(product);
        } else {
            prepareEvalLinks(product);
        }

        if (focus) {
            window.scrollTo({ top: 0, behavior: 'smooth' });
            document.getElementById('detail-title')?.focus({ preventScroll: true });
        }
    }

    function closeProduct({ focus = true } = {}) {
        const hadProduct = state.product !== null;
        state.product = null;
        state.selectedSku = null;
        state.languages = [];
        state.links = [];
        state.step = 'languages';
        state.error = null;
        state.loading = false;
        state.requestId += 1;

        el.detail.hidden = true;
        el.detail.innerHTML = '';
        el.catalog.hidden = false;
        el.hero.hidden = false;
        const select = document.getElementById('product-select');
        if (select) select.value = '';
        document.title = 'MSDL — Microsoft Software Download Listing';

        if (focus) {
            window.scrollTo({ top: 0, behavior: 'smooth' });
            if (hadProduct) el.search.focus({ preventScroll: true });
        }
    }

    function renderDetail() {
        const product = state.product;
        if (!product) return;

        const { title } = splitName(product.name);
        const build = buildOf(product);
        const isEval = product.source === 'evalcenter';
        const languageCount = isEval ? (product.links ?? []).length : product.skus ?? 0;

        el.detail.innerHTML = `
            <div class="detail-wrap">
                <button class="detail-back" type="button" data-action="back">
                    ${icon('arrow-left')} All releases
                </button>

                <header class="detail-head">
                    <p class="detail-kicker">
                        <span>product</span>
                        <span class="sep" aria-hidden="true">/</span>
                        <span>${escapeHtml(product.id)}</span>
                        <span class="sep" aria-hidden="true">/</span>
                        <span>${isEval ? 'evaluation' : 'retail'}</span>
                    </p>
                    <h1 class="detail-title" id="detail-title" tabindex="-1">${escapeHtml(title)}</h1>

                    <dl class="facts-bar">
                        <div class="fact-cell">
                            <dt>Version</dt>
                            <dd>${escapeHtml(product.version ?? '—')}</dd>
                        </div>
                        <div class="fact-cell">
                            <dt>Build</dt>
                            <dd>
                                ${build ? escapeHtml(build) : '—'}
                                ${build ? `<button class="copy" type="button" data-copy="${escapeHtml(build)}" data-copy-label="Build number" aria-label="Copy build number">${icon('copy')}</button>` : ''}
                            </dd>
                        </div>
                        <div class="fact-cell">
                            <dt>Architecture</dt>
                            <dd>${escapeHtml(archLabel(product.arch) || '—')}</dd>
                        </div>
                        <div class="fact-cell">
                            <dt>Languages</dt>
                            <dd>${languageCount ? pad2(languageCount) : '—'}</dd>
                        </div>
                        <div class="fact-cell">
                            <dt>Channel</dt>
                            <dd>${isEval ? 'Evaluation' : 'Retail'}</dd>
                        </div>
                    </dl>
                </header>

                <div id="detail-body"></div>
            </div>`;

        renderDetailBody();
    }

    function detailNote(text) {
        return `<p class="note">${icon('info')}<span>${text}</span></p>`;
    }

    function renderDetailBody() {
        const body = document.getElementById('detail-body');
        if (!body) return;

        if (state.loading) {
            body.innerHTML = `
                <div class="panel" aria-busy="true" aria-live="polite">
                    <div class="skeleton skeleton-line medium" style="margin-bottom:14px"></div>
                    <div class="skeleton skeleton-line" style="width:64%;margin-bottom:24px"></div>
                    <div class="langs" style="border:none">
                        ${Array.from({ length: 8 }, () => '<div class="skeleton" style="height:46px"></div>').join('')}
                    </div>
                </div>`;
            return;
        }

        if (state.error) {
            body.innerHTML = `
                <div class="alert" role="alert">
                    ${icon('alert', 'alert-icon')}
                    <div>
                        <p class="alert-title">${escapeHtml(state.error.title)}</p>
                        <p class="alert-body">${escapeHtml(state.error.message)}</p>
                        <div class="alert-actions">
                            <button class="button button-secondary" type="button" data-action="retry">Try again</button>
                            <a class="button" href="${MICROSOFT_DOWNLOAD_PAGE}" target="_blank" rel="noreferrer noopener">
                                Open Microsoft downloads ${icon('external')}
                            </a>
                        </div>
                    </div>
                </div>`;
            return;
        }

        if (state.step === 'links' && state.links.length > 0) {
            renderLinks();
            return;
        }

        renderLanguages();
    }

    function renderLanguages() {
        const body = document.getElementById('detail-body');
        if (!body) return;

        const isEval = state.product?.source === 'evalcenter';
        const languages = state.languages;
        const searchable = languages.length > 12;

        body.innerHTML = `
            <div class="panel">
                <div class="panel-head">
                    <div>
                        <h2 class="panel-title">Choose a language</h2>
                        <p class="panel-note">${isEval
                            ? 'Microsoft publishes a separate evaluation ISO per language. Picking one opens its official download.'
                            : 'Microsoft generates a fresh download link for the language you pick — use the same language when you install.'}</p>
                    </div>
                    <span class="group-count">${pad2(languages.length)} available</span>
                </div>

                ${searchable
                    ? `<div class="panel-tools">
                           <div class="filter-input">
                               ${icon('search')}
                               <label class="visually-hidden" for="language-filter">Filter languages</label>
                               <input id="language-filter" type="search" placeholder="Filter languages" autocomplete="off" spellcheck="false">
                           </div>
                       </div>`
                    : ''}

                <div class="langs" id="lang-grid">
                    ${languages
                        .map(
                            (language) => `
                        <button class="lang" type="button" data-sku="${escapeHtml(language.id)}">
                            <span class="lang-name">${escapeHtml(language.label)}</span>
                            ${icon('arrow-right')}
                        </button>`,
                        )
                        .join('')}
                </div>

                ${detailNote(isEval
                    ? 'Evaluation editions run for 180 days and can be converted to a licensed installation.'
                    : 'Links are generated by Microsoft and usually expire about 24 hours after they are created.')}
            </div>`;

        const filter = document.getElementById('language-filter');
        if (filter) {
            filter.addEventListener('input', () => {
                const needle = filter.value.trim().toLowerCase();
                let shown = 0;
                body.querySelectorAll('.lang').forEach((button) => {
                    const match = button.textContent.toLowerCase().includes(needle);
                    button.hidden = !match;
                    if (match) shown += 1;
                });
                const counter = body.querySelector('.panel-head .group-count');
                if (counter) {
                    counter.textContent = `${pad2(shown)} / ${pad2(languages.length)}`;
                }
            });
        }
    }

    function renderLinks() {
        const body = document.getElementById('detail-body');
        if (!body) return;

        const isEval = state.product?.source === 'evalcenter';

        body.innerHTML = `
            <div class="panel">
                <div class="panel-head">
                    <div>
                        <h2 class="panel-title">${isEval ? 'Official evaluation download' : 'Your download links'}</h2>
                        <p class="panel-note">${isEval
                            ? 'You are leaving for Microsoft’s Evaluation Center. The download is served directly by Microsoft.'
                            : 'These links are generated by Microsoft for this session and point at their own download servers.'}</p>
                    </div>
                </div>

                <ul class="links">
                    ${state.links
                        .map(
                            (link) => `
                        <li>
                            <a class="link-row" href="${escapeHtml(safeUrl(link.url))}" target="_blank" rel="noreferrer noopener">
                                ${icon('download')}
                                <span class="link-name">${escapeHtml(link.name)}</span>
                                ${icon('external')}
                            </a>
                            <button class="copy" type="button" data-copy="${escapeHtml(link.url)}" data-copy-label="Download link" aria-label="Copy download link">
                                ${icon('copy')}
                            </button>
                        </li>`,
                        )
                        .join('')}
                </ul>

                <div class="panel-foot">
                    <button class="button button-secondary" type="button" data-action="restart">
                        ${icon('arrow-left')} Choose another language
                    </button>
                </div>

                ${detailNote(isEval
                    ? 'Evaluation downloads require a Microsoft account and a short registration form.'
                    : 'If a link stops working, generate a new one — Microsoft expires them after roughly a day.')}
            </div>`;
    }

    /* ------------------------------------------------------ download flow */

    async function loadLanguages(product) {
        const requestId = ++state.requestId;
        state.loading = true;
        state.error = null;
        renderDetailBody();

        try {
            const response = await fetch(`${API_BASE}/skuinfo?product_id=${encodeURIComponent(product.id)}`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const payload = await response.json();
            if (requestId !== state.requestId) return;

            const skus = Array.isArray(payload.Skus) ? payload.Skus : [];
            if (skus.length === 0) {
                throw new Error(
                    payload.Errors?.[0]?.Value ??
                    'Microsoft does not publish downloadable media for this product any more.',
                );
            }

            state.languages = skus
                .map((sku) => ({
                    id: sku.Id,
                    label: sku.LocalizedLanguage ?? sku.Language ?? sku.Id,
                }))
                .sort((a, b) => a.label.localeCompare(b.label));

            state.loading = false;
            renderDetailBody();
        } catch (error) {
            if (requestId !== state.requestId) return;
            state.loading = false;
            state.error = {
                title: 'Couldn’t load the language list',
                message: `${describeError(error)}. The Microsoft service may be temporarily unavailable.`,
            };
            renderDetailBody();
        }
    }

    async function requestDownloadLinks(product, skuId) {
        const requestId = ++state.requestId;
        state.selectedSku = skuId;
        state.loading = true;
        state.error = null;
        renderDetailBody();

        try {
            const url = `${API_BASE}/proxy?product_id=${encodeURIComponent(product.id)}&sku_id=${encodeURIComponent(skuId)}`;
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const payload = await response.json();
            if (requestId !== state.requestId) return;

            if (Array.isArray(payload.Errors) && payload.Errors.length > 0) {
                const rejection = payload.Errors[0];
                const isSentinel = /sentinel/i.test(rejection.Key ?? '');
                throw Object.assign(new Error(rejection.Value ?? 'Microsoft rejected the request.'), {
                    sentinel: isSentinel,
                });
            }

            const options = Array.isArray(payload.ProductDownloadOptions) ? payload.ProductDownloadOptions : [];
            if (options.length === 0) {
                throw new Error('Microsoft returned no download links for this language.');
            }

            state.links = options.map((option) => {
                const file = String(option.Uri ?? '').split('?')[0].split('/').pop();
                return { url: option.Uri, name: file || 'Download' };
            });
            state.loading = false;
            state.step = 'links';
            renderDetailBody();
        } catch (error) {
            if (requestId !== state.requestId) return;
            state.loading = false;
            state.error = error.sentinel
                ? {
                      title: 'Microsoft blocked the request',
                      message:
                          'Microsoft’s bot check rejected this session (it rate-limits link generation). Wait a minute and retry, or download from Microsoft directly. Deploying the bundled proxy makes this reliable.',
                  }
                : {
                      title: 'Couldn’t generate download links',
                      message: `${describeError(error)}. Try again, or download from Microsoft directly.`,
                  };
            renderDetailBody();
        }
    }

    function prepareEvalLinks(product) {
        state.languages = (product.links ?? []).map((link) => ({
            id: link.locale,
            label: languageName(link.locale),
            url: link.url,
        }));
        state.loading = false;
        state.error =
            state.languages.length === 0
                ? {
                      title: 'No official download is listed',
                      message: 'Microsoft is not publishing this release on its download pages right now.',
                  }
                : null;
        renderDetailBody();
    }

    /* --------------------------------------------------------------- copy */

    async function copyText(text) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            try {
                const helper = document.createElement('textarea');
                helper.value = text;
                helper.setAttribute('readonly', '');
                helper.style.position = 'fixed';
                helper.style.opacity = '0';
                document.body.appendChild(helper);
                helper.select();
                const ok = document.execCommand('copy');
                helper.remove();
                return ok;
            } catch {
                return false;
            }
        }
    }

    async function handleCopy(button) {
        const text = button?.dataset.copy;
        if (!text || button.classList.contains('is-copied')) return;

        const ok = await copyText(text);
        if (!ok) return;

        const original = button.innerHTML;
        button.innerHTML = icon('check');
        button.classList.add('is-copied');
        window.setTimeout(() => {
            button.innerHTML = original;
            button.classList.remove('is-copied');
        }, 1400);
    }

    /* ---------------------------------------------------------- navigation */

    /** Leaves the detail view without leaving a duplicate history entry behind. */
    function closeProductFromUi() {
        if (window.location.hash) {
            history.replaceState(null, '', window.location.pathname + window.location.search);
        }
        closeProduct();
    }

    function route({ fromLoad = false } = {}) {
        if (!state.data) return;

        const id = decodeURIComponent(window.location.hash.replace(/^#/, ''));

        // In-page section anchors (the "Catalog" nav link) keep native scrolling.
        if (id === 'catalog') {
            if (!el.detail.hidden) closeProduct({ focus: false });
            document.getElementById('catalog')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            return;
        }

        if (id) {
            const exists = state.data.products.some((product) => product.id === id);
            if (exists) {
                openProduct(id, { focus: !fromLoad });
                return;
            }
        }

        if (!el.detail.hidden || fromLoad) closeProduct({ focus: false });
    }

    function navigateToProduct(id) {
        window.location.hash = encodeURIComponent(id);
    }

    function resetFilters() {
        state.query = '';
        state.family = 'all';
        el.search.value = '';
        renderFilters();
        renderCatalog();
        el.search.focus();
    }

    function focusSearch() {
        if (!el.detail.hidden) closeProduct({ focus: false });
        el.search.focus({ preventScroll: true });
        el.search.select();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    /* ---------------------------------------------------------------- init */

    function bindEvents() {
        el.filters.addEventListener('click', (event) => {
            const button = event.target.closest('[data-family]');
            if (!button) return;
            state.family = button.dataset.family;
            el.filters.querySelectorAll('[data-family]').forEach((filter) => {
                filter.setAttribute('aria-pressed', String(filter === button));
            });
            renderCatalog();
        });

        el.catalogBody.addEventListener('change', (event) => {
            if (event.target.id === 'product-select' && event.target.value) {
                navigateToProduct(event.target.value);
            }
        });

        el.catalogBody.addEventListener('click', (event) => {
            const action = event.target.closest('[data-action]')?.dataset.action;
            if (action === 'retry-catalog') loadCatalog({ retry: true });
            if (action === 'reset-filters') resetFilters();
        });

        el.detail.addEventListener('click', (event) => {
            const copyButton = event.target.closest('[data-copy]');
            if (copyButton) {
                handleCopy(copyButton);
                return;
            }

            const skuButton = event.target.closest('[data-sku]');
            if (skuButton && state.product) {
                if (state.product.source === 'evalcenter') {
                    const language = state.languages.find((entry) => entry.id === skuButton.dataset.sku);
                    if (!language) return;
                    state.links = [
                        {
                            url: language.url,
                            name: `${splitName(state.product.name).title} — ${language.label}`,
                        },
                    ];
                    state.step = 'links';
                    renderDetailBody();
                } else {
                    requestDownloadLinks(state.product, skuButton.dataset.sku);
                }
                return;
            }

            const action = event.target.closest('[data-action]')?.dataset.action;
            if (action === 'back') {
                closeProductFromUi();
                return;
            }
            if (action === 'retry' && state.product) {
                if (state.product.source !== 'connector') {
                    prepareEvalLinks(state.product);
                } else if (state.selectedSku && state.languages.length > 0) {
                    requestDownloadLinks(state.product, state.selectedSku);
                } else {
                    state.step = 'languages';
                    state.links = [];
                    loadLanguages(state.product);
                }
                return;
            }
            if (action === 'restart') {
                state.step = 'languages';
                state.selectedSku = null;
                state.links = [];
                state.error = null;
                if (state.product?.source !== 'connector') {
                    prepareEvalLinks(state.product);
                } else if (state.languages.length > 0) {
                    renderDetailBody();
                } else {
                    loadLanguages(state.product);
                }
            }
        });

        const onSearch = debounce(() => {
            state.query = el.search.value;
            renderCatalog();
        }, 90);

        el.search.addEventListener('input', onSearch);
        el.search.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                event.stopPropagation();
                if (el.search.value !== '') {
                    el.search.value = '';
                    state.query = '';
                    renderCatalog();
                } else {
                    el.search.blur();
                }
                return;
            }
            if (event.key === 'ArrowDown') {
                const select = document.getElementById('product-select');
                if (select) {
                    event.preventDefault();
                    event.stopPropagation();
                    select.focus();
                }
            }
        });

        el.searchClear.addEventListener('click', () => {
            el.search.value = '';
            state.query = '';
            renderCatalog();
            el.search.focus();
        });

        document.addEventListener('keydown', (event) => {
            const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '');
            const isSlash = event.key === '/' && !typing;
            const isCommandK = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k';

            if (isCommandK || isSlash) {
                event.preventDefault();
                focusSearch();
                return;
            }

            if (event.key === 'ArrowDown' && !typing && el.detail.hidden && document.activeElement === el.search) {
                const select = document.getElementById('product-select');
                if (select) {
                    event.preventDefault();
                    select.focus();
                }
                return;
            }

            if (event.key === 'Escape' && !el.detail.hidden) {
                closeProductFromUi();
            }
        });

        window.addEventListener('hashchange', () => route());
    }

    function cacheElements() {
        Object.assign(el, {
            search: document.getElementById('search-products'),
            searchClear: document.getElementById('search-clear'),
            filters: document.getElementById('filters'),
            hero: document.querySelector('.hero'),
            catalog: document.getElementById('catalog'),
            catalogBody: document.getElementById('catalog-body'),
            catalogUpdated: document.getElementById('catalog-updated'),
            resultCount: document.getElementById('result-count'),
            detail: document.getElementById('detail'),
            themeToggle: document.getElementById('theme-toggle'),
            manifestUpdated: document.getElementById('manifest-updated'),
            manifestEntries: document.getElementById('manifest-entries'),
            manifestFamilies: document.getElementById('manifest-families'),
            manifestId: document.getElementById('manifest-id'),
            manifestPulse: document.getElementById('manifest-pulse'),
            footerStamp: document.getElementById('footer-stamp'),
        });
    }

    function init() {
        cacheElements();
        bindEvents();
        el.catalogBody.innerHTML = skeletonCatalog(3);
        loadCatalog();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
