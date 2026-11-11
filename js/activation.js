(() => {
    'use strict';
    const body = document.getElementById('act-body');
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    document.getElementById('theme-toggle')?.addEventListener('click', () => {
        const root = document.documentElement;
        const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
        root.dataset.theme = next;
        try { localStorage.setItem('msdl-theme', next); } catch { }
    });

    fetch('data/activation.json', { cache: 'no-cache' })
        .then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
        })
        .then((data) => {
            const updated = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(data.updated));
            document.getElementById('act-stamp').textContent = `${data.entries.length} guides · captured ${updated} · source ${data.source}`;
            document.getElementById('footer-stamp').textContent = `data/activation.json · ${data.entries.length} guides · ${updated}`;

            body.innerHTML = data.categories
                .map((category) => {
                    const entries = data.entries.filter((entry) => entry.category === category.id);
                    if (entries.length === 0) return '';
                    return `
                        <section class="act-section" aria-labelledby="act-${category.id}">
                            <h2 class="act-heading" id="act-${category.id}">${esc(category.label)}</h2>
                            <div class="act-grid">
                                ${entries.map((entry) => `
                                    <a class="act-card" href="${esc(entry.url)}" target="_blank" rel="noreferrer noopener">
                                        <img class="act-shot" src="${esc(entry.image)}" alt="Screenshot of the ${esc(entry.title)} guide on massgrave.dev" loading="lazy" width="1200" height="750">
                                        <span class="act-body">
                                            <span class="act-title">${esc(entry.title)}</span>
                                            <span class="act-blurb">${esc(entry.blurb)}</span>
                                            <span class="act-link">Open the official guide →</span>
                                        </span>
                                    </a>`).join('')}
                            </div>
                        </section>`;
                })
                .join('');
            body.setAttribute('aria-busy', 'false');
        })
        .catch((error) => {
            body.innerHTML = `<div class="alert" role="alert"><div><p class="alert-title">The activation index could not be loaded</p><p class="alert-body">${esc(error.message)}</p></div></div>`;
        });
})();
