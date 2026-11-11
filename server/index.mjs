#!/usr/bin/env node
/**
 * MSDL download proxy.
 *
 * Microsoft's download connector is protected by Sentinel: a session has to be
 * "warmed" by a real browser once, after which plain HTTP calls with that
 * session id are accepted. This service does exactly that and mirrors the
 * contract the front-end already speaks:
 *
 *   GET /skuinfo?product_id=3262
 *   GET /proxy?product_id=3262&sku_id=19675
 *
 * Deploy it anywhere Node 20+ runs (Docker image included) and point the site at
 * it with <meta name="msdl-api" content="https://your-proxy.example">.
 */

import { createServer } from 'node:http';
import { chromium } from 'playwright';

const PORT = Number(process.env.PORT ?? 8787);
const PROFILE = process.env.PROFILE_ID ?? '606624d44113';
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS ?? 20 * 60 * 1000);
const LOCALE = process.env.LOCALE ?? 'en-US';
const REFERER = 'https://www.microsoft.com/en-us/software-download/windows11';
const UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CONNECTOR = 'https://www.microsoft.com/software-download-connector/api';

/* ------------------------------------------------------------------ session */

const session = { id: null, warmedAt: 0, warming: null };

// Microsoft rate-limits link generation; a short cache keeps repeat visits cheap.
const linkCache = new Map();
const LINK_TTL_MS = Number(process.env.LINK_TTL_MS ?? 10 * 60 * 1000);

const log = (...parts) => console.log(new Date().toISOString(), '[proxy]', ...parts);
const warn = (...parts) => console.warn(new Date().toISOString(), '[proxy]', ...parts);

async function launchBrowser() {
    // Local development can reuse an installed Chrome; containers use the
    // browser that ships with the playwright image.
    try {
        return await chromium.launch({ channel: 'chrome' });
    } catch {
        return await chromium.launch();
    }
}

/**
 * Opens Microsoft's Windows 11 ISO page and lets it issue a connector session.
 * Returns the sessionID the page generated.
 */
async function warmSession() {
    const started = Date.now();
    const browser = await launchBrowser();
    const page = await browser.newPage();

    let sessionId = null;
    page.on('request', (request) => {
        if (sessionId || !request.url().includes('software-download-connector')) return;
        try {
            sessionId = new URL(request.url()).searchParams.get('sessionID');
        } catch {
            /* ignore malformed urls */
        }
    });

    try {
        await page.goto(REFERER, { waitUntil: 'domcontentloaded', timeout: 60_000 });

        await page
            .getByText('Download Windows 11 Disk Image (ISO)')
            .first()
            .click({ timeout: 20_000 })
            .catch(() => {});

        await page.locator('#product-edition').selectOption({ index: 1 }).catch(() => {});
        await page.locator('#submit-product-edition').click({ timeout: 20_000 }).catch(() => {});

        // The session id appears on the first connector request.
        const deadline = Date.now() + 20_000;
        while (!sessionId && Date.now() < deadline) {
            await page.waitForTimeout(250);
        }

        // Finish the flow once: a session only becomes usable for link
        // generation after the page has completed a real request for links.
        await page.locator('#product-languages').waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {});
        await page.locator('#product-languages').selectOption({ index: 1 }).catch(() => {});
        await page.locator('#submit-sku').click({ timeout: 20_000 }).catch(() => {});
        await page.waitForTimeout(1500);
    } finally {
        await page.close().catch(() => {});
        await browser.close().catch(() => {});
    }

    if (!sessionId) throw new Error('Microsoft did not issue a connector session');

    session.id = sessionId;
    session.warmedAt = Date.now();
    log(`session warmed in ${Date.now() - started}ms: ${sessionId}`);
    return sessionId;
}

/** Returns a fresh session id, warming one when needed. */
function getSession({ force = false } = {}) {
    const expired = Date.now() - session.warmedAt > SESSION_TTL_MS;

    if (!force && session.id && !expired) return Promise.resolve(session.id);
    if (session.warming) return session.warming;

    session.warming = warmSession().finally(() => {
        session.warming = null;
    });

    return session.warming;
}

/* ---------------------------------------------------------------- connector */

const connectorHeaders = () => ({
    'user-agent': UA,
    referer: REFERER,
    accept: 'application/json, text/plain, */*',
});

async function fetchJson(url) {
    const response = await fetch(url, { headers: connectorHeaders(), signal: AbortSignal.timeout(30_000) });
    const text = await response.text();
    if (!response.ok) throw new Error(`Microsoft returned HTTP ${response.status}`);
    try {
        return JSON.parse(text);
    } catch {
        throw new Error('Microsoft returned an unexpected response');
    }
}

const isSentinelReject = (payload) =>
    Array.isArray(payload?.Errors) && payload.Errors.some((error) => /sentinel/i.test(error?.Key ?? ''));

/** Calls the connector, re-warming the session once if Sentinel rejects it. */
async function callConnector(buildUrl) {
    let sessionId = await getSession();
    let payload = await fetchJson(buildUrl(sessionId));

    if (isSentinelReject(payload)) {
        warn('sentinel rejected the session — warming a new one');
        sessionId = await getSession({ force: true });
        payload = await fetchJson(buildUrl(sessionId));
    }

    return payload;
}

const skuInfoUrl = (productId) => (sessionId) =>
    `${CONNECTOR}/getskuinformationbyproductedition?profile=${PROFILE}` +
    `&productEditionId=${encodeURIComponent(productId)}&SKU=undefined&friendlyFileName=undefined` +
    `&Locale=${LOCALE}&sessionID=${sessionId}`;

const linksUrl = (skuId) => (sessionId) =>
    `${CONNECTOR}/GetProductDownloadLinksBySku?profile=${PROFILE}` +
    `&ProductEditionId=undefined&SKU=${encodeURIComponent(skuId)}&friendlyFileName=undefined` +
    `&Locale=${LOCALE}&sessionID=${sessionId}`;

/* ------------------------------------------------------------------- server */

const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store',
};

function send(response, status, payload) {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...CORS });
    response.end(JSON.stringify(payload));
}

const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);

    if (request.method === 'OPTIONS') {
        response.writeHead(204, CORS);
        return response.end();
    }

    if (request.method !== 'GET') return send(response, 405, { error: 'Use GET' });

    try {
        if (url.pathname === '/health') {
            return send(response, 200, {
                ok: Boolean(session.id),
                sessionAgeSeconds: session.id ? Math.round((Date.now() - session.warmedAt) / 1000) : null,
            });
        }

        if (url.pathname === '/skuinfo') {
            const productId = url.searchParams.get('product_id');
            if (!productId) return send(response, 400, { Errors: [{ Key: 'MissingProduct', Value: 'product_id is required' }] });

            const payload = await callConnector(skuInfoUrl(productId));
            return send(response, 200, payload);
        }

        if (url.pathname === '/proxy' || url.pathname === '/links') {
            const productId = url.searchParams.get('product_id');
            let skuId = url.searchParams.get('sku_id') ?? url.searchParams.get('sku');

            // Callers may pass only a product id; resolve its first sku then.
            if (!skuId) {
                if (!productId) {
                    return send(response, 400, { Errors: [{ Key: 'MissingSku', Value: 'sku_id is required' }] });
                }
                const skus = await callConnector(skuInfoUrl(productId));
                skuId = skus?.Skus?.[0]?.Id;
                if (!skuId) return send(response, 200, skus);
            }

            const cached = linkCache.get(skuId);
            if (cached && Date.now() - cached.at < LINK_TTL_MS) {
                return send(response, 200, cached.payload);
            }

            const payload = await callConnector(linksUrl(skuId));
            if (Array.isArray(payload?.ProductDownloadOptions) && payload.ProductDownloadOptions.length > 0) {
                linkCache.set(skuId, { at: Date.now(), payload });
                if (linkCache.size > 200) linkCache.delete(linkCache.keys().next().value);
            }

            return send(response, 200, payload);
        }

        return send(response, 404, { error: 'Unknown endpoint' });
    } catch (error) {
        warn(url.pathname, '→', error.message);
        return send(response, 502, {
            Errors: [{ Key: 'ProxyError', Value: error.message, Type: 8 }],
        });
    }
});

server.listen(PORT, () => {
    log(`listening on http://127.0.0.1:${PORT}`);
    getSession().catch((error) => warn('initial warm-up failed:', error.message));
});
