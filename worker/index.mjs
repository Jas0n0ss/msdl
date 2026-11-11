/**
 * MSDL download API — Cloudflare Worker + Browser Rendering.
 *
 * Microsoft's connector only answers link requests made from a real browser
 * page (Sentinel). The Worker therefore runs the two calls *inside* the
 * Microsoft download page, where cookies, referrer and origin are already
 * correct, and returns the JSON to the site.
 *
 * Deployed by .github/workflows/deploy-worker.yml on every worker/ change.
 *
 *   GET /skuinfo?product_id=3813
 *   GET /proxy?product_id=3813&sku_id=27160
 *   GET /health
 */

import puppeteer from '@cloudflare/puppeteer';

const PAGES = {
    'windows-11': 'https://www.microsoft.com/en-us/software-download/windows11',
    'windows-11-arm64': 'https://www.microsoft.com/en-us/software-download/windows11arm64',
    'windows-10': 'https://www.microsoft.com/en-us/software-download/windows10ISO',
};
const CONNECTOR = 'https://www.microsoft.com/software-download-connector/api';
const PROFILE = '606624d44113';
const LOCALE = 'en-US';
const CACHE_TTL_MS = 10 * 60 * 1000;

const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store',
};

const cache = new Map();
const inflight = new Map();

/** Collapses concurrent identical requests into one browser run. */
function dedupe(key, factory) {
    const existing = inflight.get(key);
    if (existing) return existing;

    const promise = factory().finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
}
const ttl = (key) => {
    const hit = cache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > CACHE_TTL_MS) {
        cache.delete(key);
        return null;
    }
    return hit.value;
};

const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8', ...CORS },
    });

const failure = (message, status = 502) =>
    json({ Errors: [{ Key: 'ProxyError', Value: message, Type: 8 }] }, status);

/** Browser Rendering allows only a few concurrent browsers, so reuse one. */
let browserPromise = null;
let queue = Promise.resolve();

async function getBrowser(env) {
    // A Browser Rendering account only allows a couple of open browsers, and a
    // Worker isolate can be recycled without warning, so never keep one around.
    return puppeteer.launch(env.BROWSER);
}

/** Serialises browser work so parallel requests cannot hit the concurrency cap. */
function withBrowserSlot(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
}

const isRateLimited = (error) => /429|rate limit/i.test(error?.message ?? '');

/** Tries the known Microsoft pages when the caller did not say which family. */
async function driveAnyFamily(env, { productId, skuId, family, arch }) {
    const numeric = Number(productId);
    const auto = Number.isFinite(numeric) && numeric < 3000
        ? ['windows-10', 'windows-11']
        : ['windows-11', 'windows-10'];
    const candidates = family
        ? family === 'windows-11' && arch === 'arm64'
            ? ['windows-11-arm64', 'windows-11']
            : [family]
        : auto;
    let lastError;
    for (const candidate of candidates) {
        try {
            const result = await drivePage(env, { productId, skuId, family: candidate, arch });
            if (skuId ? result.links?.length : result.languages?.length) return result;
            lastError = new Error('No data returned');
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError ?? new Error('No family matched this product');
}

/**
 * Drives Microsoft's own download page and reads what it produces. Doing the
 * flow in the page is what makes Sentinel accept the requests; a bare fetch
 * with a fresh session id is rejected.
 */
async function drivePage(env, { productId, skuId, family, arch }) {
    const key = family === 'windows-11' && arch === 'arm64' ? 'windows-11-arm64' : family ?? 'windows-11';
    const pageUrl = PAGES[key];
    if (!pageUrl) throw new Error(`Microsoft does not publish this family through the connector (${family})`);
    const attempt = async (retries) => {
        let browser;
        try {
            browser = await getBrowser(env);
            const page = await browser.newPage();

            await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
            await new Promise((resolve) => setTimeout(resolve, 1200));

            await page.evaluate(() => {
                const link = [...document.querySelectorAll('a, button, h2, h3')].find((node) =>
                    /Disk Image \(ISO\)/i.test(node.textContent ?? ''),
                );
                link?.click();
            });
            await new Promise((resolve) => setTimeout(resolve, 1200));

            const editionOk = await page.evaluate((pid) => {
                const select = document.querySelector('#product-edition');
                if (!select) return false;
                const option = [...select.options].find((o) => String(o.value) === String(pid));
                if (!option) return false;
                select.value = option.value;
                select.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
            }, productId);

            if (!editionOk) throw new Error('Microsoft page did not offer an edition picker');

            await page.evaluate(() => document.querySelector('#submit-product-edition')?.click());
            await new Promise((resolve) => setTimeout(resolve, 2500));

            const languages = await page.evaluate(() => {
                const select = document.querySelector('#product-languages');
                if (!select) return null;
                return [...select.options]
                    .filter((o) => o.value && o.value !== 'null' && !/Choose one/i.test(o.textContent))
                    .map((o) => ({ value: o.value, label: o.textContent.trim() }));
            });

            if (!languages) throw new Error('Microsoft page did not load languages');
            if (!skuId) return { languages };

            const match = languages.find((o) => o.value.includes(String(skuId)));
            if (!match) throw new Error('That language is no longer offered for this product');

            await page.evaluate((value) => {
                const select = document.querySelector('#product-languages');
                select.value = value;
                select.dispatchEvent(new Event('change', { bubbles: true }));
                document.querySelector('#submit-sku')?.click();
            }, match.value);
            await new Promise((resolve) => setTimeout(resolve, 3500));

            const links = await page.evaluate(() =>
                [...document.querySelectorAll('a[href*=".iso"]')].map((a) => ({ uri: a.href, name: a.textContent.trim() })),
            );

            return { links };
        } catch (error) {
            if (isRateLimited(error) && retries > 0) {
                await new Promise((resolve) => setTimeout(resolve, 6000));
                return attempt(retries - 1);
            }
            throw error;
        } finally {
            if (browser) await browser.close().catch(() => {});
        }
    };

    return withBrowserSlot(() => attempt(4));
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
        if (request.method !== 'GET') return failure('Use GET', 405);

        try {
            if (url.pathname === '/health') {
                return json({ ok: true, service: 'msdl-api', cached: cache.size });
            }

            if (url.pathname === '/skuinfo') {
                const productId = url.searchParams.get('product_id');
                const family = url.searchParams.get('family') ?? null;
                const arch = url.searchParams.get('arch') ?? '';
                if (!productId) return failure('product_id is required', 400);

                const key = `sku:${family ?? 'auto'}:${arch}:${productId}`;
                const hit = ttl(key);
                if (hit) return json(hit);

                const payload = await dedupe(key, async () => {
                    const { languages } = await driveAnyFamily(env, { productId, family, arch });
                    const value = {
                        ValidationContainer: { Errors: [] },
                        Skus: languages.map((entry) => {
                            let id = entry.value;
                            try {
                                id = JSON.parse(entry.value).id ?? entry.value;
                            } catch {
                                /* value is already the id */
                            }
                            return { Id: String(id), LocalizedLanguage: entry.label, Language: entry.label };
                        }),
                    };
                    cache.set(key, { at: Date.now(), value });
                    return value;
                });

                return json(payload);
            }

            if (url.pathname === '/proxy' || url.pathname === '/links') {
                const productId = url.searchParams.get('product_id');
                const skuId = url.searchParams.get('sku_id') ?? url.searchParams.get('sku');
                const family = url.searchParams.get('family') ?? null;
                const arch = url.searchParams.get('arch') ?? '';
                if (!productId && !skuId) return failure('product_id or sku_id is required', 400);

                const key = `link:${family ?? 'auto'}:${arch}:${productId}:${skuId}`;
                const hit = ttl(key);
                if (hit) return json(hit);

                const payload = await dedupe(key, async () => {
                    const { links } = await driveAnyFamily(env, { productId, skuId, family, arch });
                    const value = {
                        ProductDownloadOptions: links.map((link) => ({
                            Name: link.name,
                            Uri: link.uri,
                            DownloadType: /arm64/i.test(link.uri) ? 1 : 0,
                        })),
                    };
                    if (value.ProductDownloadOptions.length > 0) {
                        cache.set(key, { at: Date.now(), value });
                    }
                    return value;
                });

                if (payload.ProductDownloadOptions.length === 0) {
                    return failure('Microsoft returned no download links for that language');
                }
                return json(payload);
            }

            return failure('Unknown endpoint', 404);
        } catch (error) {
            return failure(error?.message ?? 'Unexpected error');
        }
    },
};
