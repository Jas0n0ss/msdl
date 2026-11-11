/** Browser work against Microsoft's download pages, shared by the Worker and its Durable Object. */

import puppeteer from '@cloudflare/puppeteer';

export const PAGES = {
    'windows-11': 'https://www.microsoft.com/en-us/software-download/windows11',
    'windows-11-arm64': 'https://www.microsoft.com/en-us/software-download/windows11arm64',
    'windows-10': 'https://www.microsoft.com/en-us/software-download/windows10ISO',
};

export const withTimeout = (promise, ms, message) =>
    Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
    ]);

export const isRateLimited = (error) => /429|rate limit/i.test(error?.message ?? '');

// One browser serves a burst of requests: launching a new one for every call
// burns the Browser Rendering quota. The Durable Object serialises access, so a
// shared browser is safe there; it is closed after two idle minutes.
let sharedBrowser = null;
let idleTimer = null;

export async function getBrowser(env) {
    if (sharedBrowser) return sharedBrowser;
    sharedBrowser = await puppeteer.launch(env.BROWSER);
    return sharedBrowser;
}

export function keepWarm() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
        sharedBrowser?.close().catch(() => {});
        sharedBrowser = null;
    }, 120_000);
}

export async function closeBrowser() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    await sharedBrowser?.close().catch(() => {});
    sharedBrowser = null;
}

export async function drivePage(env, { productId, skuId, family, arch }) {
    const pageKey = family === 'windows-11' && arch === 'arm64' ? 'windows-11-arm64' : family ?? 'windows-11';
    const pageUrl = PAGES[pageKey];
    if (!pageUrl) throw new Error(`Microsoft does not publish this family through the connector (${family})`);

    const attempt = async (retries) => {
        let browser;
        try {
            try {
                browser = await getBrowser(env);
            } catch (launchError) {
                // Quota or concurrency is exhausted: retrying only makes the
                // visitor wait longer, so fail fast with the real reason.
                if (isRateLimited(launchError)) throw Object.assign(launchError, { fatal: true });
                throw launchError;
            }
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

            if (!editionOk) throw new Error('Microsoft page did not offer this edition');

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
            // A broken page can leave the shared browser in a bad state.
            await closeBrowser().catch(() => {});
            if (!error?.fatal && isRateLimited(error) && retries > 0) {
                await new Promise((resolve) => setTimeout(resolve, 6000));
                return attempt(retries - 1);
            }
            throw error;
        } finally {
            keepWarm();
        }
    };

    return withTimeout(attempt(2), 45_000, 'Microsoft took too long to answer');
}

export async function driveAnyFamily(env, { productId, skuId, family, arch }) {
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
