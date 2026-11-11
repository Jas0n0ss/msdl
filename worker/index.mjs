/**
 * MSDL download API — Cloudflare Worker + Browser Rendering.
 *
 * Requests are forwarded to a single Durable Object that owns the browser work,
 * the cache and the queue, so parallel visitors never trip the Browser
 * Rendering concurrency limit.
 *
 *   GET /skuinfo?product_id=3813&family=windows-11&arch=x64
 *   GET /proxy?product_id=3813&sku_id=27160&family=windows-11&arch=x64
 *   GET /health
 */

export { Coordinator } from './coordinator.mjs';

const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store',
};

const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8', ...CORS },
    });

const failure = (message, status = 502) =>
    json({ Errors: [{ Key: 'ProxyError', Value: message, Type: 8 }] }, status);

const TIMEOUT_MS = 55_000;

async function coordinate(env, task) {
    const id = env.COORDINATOR.idFromName('msdl');
    const stub = env.COORDINATOR.get(id);
    const response = await Promise.race([
        stub.fetch('https://coordinator/run', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(task),
        }),
        new Promise((_, reject) =>
            setTimeout(() => reject(Object.assign(new Error('Timed out waiting for the browser'), { timeout: true })), TIMEOUT_MS),
        ),
    ]);
    const data = await response.json();
    return data.payload;
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
        if (request.method !== 'GET') return failure('Use GET', 405);

        try {
            if (url.pathname === '/health') {
                return json({ ok: true, service: 'msdl-api' });
            }

            if (url.pathname === '/skuinfo') {
                const productId = url.searchParams.get('product_id');
                if (!productId) return failure('product_id is required', 400);

                const payload = await coordinate(env, {
                    productId,
                    family: url.searchParams.get('family') ?? null,
                    arch: url.searchParams.get('arch') ?? '',
                });
                return json(payload);
            }

            if (url.pathname === '/proxy' || url.pathname === '/links') {
                const productId = url.searchParams.get('product_id');
                const skuId = url.searchParams.get('sku_id') ?? url.searchParams.get('sku');
                if (!productId && !skuId) return failure('product_id or sku_id is required', 400);

                const payload = await coordinate(env, {
                    productId,
                    skuId,
                    family: url.searchParams.get('family') ?? null,
                    arch: url.searchParams.get('arch') ?? '',
                });
                if (!payload?.ProductDownloadOptions?.length) {
                    return failure('Microsoft returned no download links for that language');
                }
                return json(payload);
            }

            return failure('Unknown endpoint', 404);
        } catch (error) {
            const message = error?.message ?? 'Unexpected error';
            if (error?.timeout) return failure('The browser took too long. Try again in a moment.', 504);
            if (/429|rate limit/i.test(message)) {
                return json(
                    {
                        Errors: [
                            {
                                Key: 'ErrorSettings.SentinelReject',
                                Value: 'Microsoft’s browser quota is temporarily exhausted. Try again in a minute.',
                                Type: 8,
                            },
                        ],
                    },
                    429,
                );
            }
            return failure(message);
        }
    },
};
