#!/usr/bin/env node
/**
 * Regenerates data/products.json from Microsoft's own download services.
 *
 * Sources
 *   1. The Microsoft software download connector (through the public MSDL API),
 *      which serves the retail Windows 7 / 10 / 11 products.
 *   2. The Microsoft Evaluation Center, which serves the stable Windows Server
 *      evaluation ISOs (the connector only carries Server preview builds).
 *
 * Usage
 *   node tools/update-products.mjs             # update data/products.json
 *   node tools/update-products.mjs --dry-run   # print the result, write nothing
 *   node tools/update-products.mjs --check     # exit 1 when the file is stale (CI)
 *
 * The script only depends on Node 20+ and never needs a lockfile.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(ROOT, 'data', 'catalog.config.json');
const DATA_PATH = path.join(ROOT, 'data', 'products.json');

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const CHECK = args.has('--check');

const CONCURRENCY = 12;
const REQUEST_TIMEOUT = 20_000;
const UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const log = (...parts) => console.error('[catalog]', ...parts);
const warn = (...parts) => console.warn('[catalog]', ...parts);

/* ------------------------------------------------------------------ utils */

async function request(url, init = {}) {
    return fetch(url, {
        redirect: 'follow',
        headers: { 'user-agent': UA, accept: 'application/json, text/html;q=0.9, */*;q=0.8', ...init.headers },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
        ...init,
    });
}

async function runPool(items, worker, concurrency = CONCURRENCY) {
    const results = new Array(items.length);
    let cursor = 0;

    async function drain() {
        while (cursor < items.length) {
            const index = cursor++;
            results[index] = await worker(items[index], index);
        }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, drain));
    return results;
}

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

/* ------------------------------------------------- product name normalising */

/**
 * Turns Microsoft's connector display names into a short, consistent label.
 * Examples:
 *   "Windows 11 Client - Build 26300.9457"      -> "Windows 11 26H2 (26300.9457)"
 *   "Windows 11 ARM 64 26H2 26300.9457"         -> "Windows 11 26H2 Arm64 (26300.9457)"
 *   "Windows 11 China Only - Build 26300.9457"  -> "Windows 11 26H2 Home China (26300.9457)"
 *   "Windows 10 22H2_v1"                        -> "Windows 10 22H2 v1"
 *   "Windows 7 Professional SP1"                -> "Windows 7 Professional SP1"
 */
function labelOf(rawName, { build, version, family }) {
    let text = clean(rawName).replace(/[_]+/g, ' ').replace(/\bV(\d+)\b/g, 'v$1');

    // Microsoft appends the build in several shapes; drop it, it is re-added at the end.
    text = text.replace(/\s*-\s*Build\s*[\d.]+\s*$/i, '').replace(/\s+\d{5}\.\d+\s*$/, '');
    text = clean(text.replace(/\s*\([\d.]+\)\s*$/, ''));

    const arm = /\b(arm ?64|arm)\b/i.test(text);
    text = clean(text.replace(/\b(ARM ?64|ARM)\b/gi, ' '));

    const parts = text.match(/^(Windows (?:Server )?\d+(?:\.\d+)?)\b(.*)$/i);
    const head = parts ? parts[1] : text;
    let rest = parts ? clean(parts[2]) : '';

    rest = clean(
        rest
            .replace(/\bClient\b/i, ' ')
            .replace(/\bPro China Only\b/i, 'Pro China')
            .replace(/\bChina Only\b/i, 'Home China'),
    );
    if (version) rest = clean(rest.replace(new RegExp(`\\b${version}\\b`, 'gi'), ' '));

    let name;
    if (family === 'windows-7') {
        // "Windows 7 Professional SP1"
        name = clean([head, rest, version].filter(Boolean).join(' '));
    } else {
        // "Windows 11 26H2", "Windows 11 26H2 Arm64", "Windows 10 22H2 Home China"
        name = clean([head, version, family === 'windows-11' && arm ? 'Arm64' : '', rest].filter(Boolean).join(' '));
    }

    return build ? `${name} (${build})` : name;
}

function versionOf(rawName, build, config) {
    const fromName = clean(rawName).match(/\b(\d{2}H[12])\b|\b(20\d{2})\b|\b(SP\d)\b/i);
    if (fromName) return fromName[1] ?? fromName[2] ?? fromName[3];

    const major = String(build ?? '').split('.')[0];
    if (major && config.buildVersion[major]) return config.buildVersion[major];
    return '';
}

function archOf(rawName, family) {
    if (family === 'windows-7') return null;
    return /\barm ?64\b/i.test(rawName) ? 'arm64' : 'x64';
}

function versionSortKey(version) {
    if (!version) return 0;
    const h = version.match(/^(\d{2})H([12])$/i);
    if (h) return Number(h[1]) * 10 + Number(h[2]);
    const sp = version.match(/^SP(\d)$/i);
    if (sp) return Number(sp[1]);
    const year = version.match(/^(20\d{2})$/);
    if (year) return Number(year[1]);
    return 0;
}

/* --------------------------------------------------------- connector input */

async function fetchSkuInfo(apiBase, productId) {
    const response = await request(`${apiBase}/skuinfo?product_id=${encodeURIComponent(productId)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const payload = await response.json();
    const skus = Array.isArray(payload.Skus) ? payload.Skus : [];
    const errors = Array.isArray(payload.Errors) ? payload.Errors : [];

    if (skus.length === 0) {
        const reason = errors[0]?.Key ?? 'no-skus';
        // Only an explicit "this product no longer exists" removes an entry. Anything else is
        // treated as a transient failure so a bad day at Microsoft cannot wipe the catalog.
        if (reason !== 'ErrorSettings.UnsupportedProduct') {
            throw new Error(`empty response (${reason})`);
        }
        return { supported: false, reason, skuCount: 0, displayName: null };
    }

    const displayName = skus.find((sku) => sku.ProductDisplayName)?.ProductDisplayName ?? null;
    return { supported: true, skuCount: skus.length, displayName, languages: skus.length };
}

function classify(name, config) {
    const isExcluded = config.exclude.some((pattern) => new RegExp(pattern, 'i').test(name));
    if (isExcluded) return null;

    const family = config.families.find(
        (entry) => entry.source === 'connector' && new RegExp(entry.match, 'i').test(name),
    );
    return family ?? null;
}

function buildProduct(id, family, rawName, { skuCount, config }) {
    const raw = clean(rawName);
    const knownBuild = config.knownBuilds?.[id] ?? null;
    const parsedBuild = raw.match(/\b(\d{5}\.\d+)\b/)?.[1] ?? null;
    const build = knownBuild ?? parsedBuild;
    const version = versionOf(raw, build, config);

    const base = {
        id: String(id),
        family: family.id,
        name: labelOf(raw, { build, version, family: family.id }),
        version,
        build,
        arch: archOf(raw, family.id),
        source: 'connector',
        skus: skuCount,
    };
    return base;
}

async function collectConnector(config, current) {
    const apiBase = config.apiBase;
    const known = current.products.filter((product) => (product.source ?? 'connector') === 'connector');
    const products = [];
    const seen = new Map();
    let dropped = 0;

    log(`checking ${known.length} published connector product(s)`);
    const refreshed = await runPool(known, async (product) => {
        try {
            const info = await fetchSkuInfo(apiBase, product.id);
            if (!info.supported) {
                dropped += 1;
                warn(`product ${product.id} (${product.name}) is no longer offered by Microsoft — removing`);
                return null;
            }
            const family = config.families.find((entry) => entry.id === product.family) ?? null;
            if (!family) {
                warn(`dropped ${product.id} (${product.name}) — family "${product.family}" is no longer published`);
                return null;
            }

            const next = buildProduct(product.id, family, info.displayName, { skuCount: info.skuCount, config });
            next.pinned = Boolean(product.pinned);
            if (!next.name) {
                next.name = product.name;
            }
            return next;
        } catch (error) {
            warn(`kept ${product.id} (${product.name}) — could not verify: ${error.message}`);
            return { ...product };
        }
    });

    for (const product of refreshed) {
        if (!product) continue;
        const key = `${product.family}|${product.name.toLowerCase()}|${product.arch ?? ''}`;
        const existing = seen.get(key);
        if (existing) {
            // Microsoft occasionally publishes the same release twice (x64/ARM mixes).
            // Keep the entry with the richer language list.
            if ((product.skus ?? 0) > (existing.skus ?? 0)) {
                warn(`duplicate "${product.name}" — keeping product ${product.id} over ${existing.id}`);
                seen.set(key, product);
            } else {
                warn(`duplicate "${product.name}" — dropping product ${product.id} in favour of ${existing.id}`);
            }
            continue;
        }
        seen.set(key, product);
    }
    products.push(...seen.values());

    /* Discovery: Microsoft assigns increasing ids, so only the tail is scanned. */
    const numericIds = products.map((product) => Number(product.id)).filter(Number.isFinite);
    const start = (numericIds.length ? Math.max(...numericIds) : 0) + 1;
    const window = Number(config.discoveryWindow ?? 0);

    if (window > 0) {
        const candidates = Array.from({ length: window }, (_, index) => start + index);
        log(`scanning ids ${start}–${start + window - 1} for new releases`);

        const discovered = await runPool(candidates, async (id) => {
            try {
                const info = await fetchSkuInfo(apiBase, id);
                if (!info.supported || !info.displayName) return null;

                const family = classify(info.displayName, config);
                if (!family) return null;

                return buildProduct(id, family, info.displayName, { skuCount: info.skuCount, config });
            } catch {
                return null;
            }
        });

        let added = 0;
        for (const product of discovered.filter(Boolean)) {
            const key = `${product.family}|${product.name.toLowerCase()}|${product.arch ?? ''}`;
            if (seen.has(key)) continue;
            seen.set(key, product);
            products.push(product);
            added += 1;
            log(`new product ${product.id}: ${product.name}`);
        }
        log(added ? `discovered ${added} new product(s)` : 'no new products this run');
    }

    if (known.length >= 4 && dropped > known.length / 2) {
        throw new Error(
            `refusing to remove ${dropped} of ${known.length} products — the API response looks wrong, catalog left untouched`,
        );
    }

    log(`connector: ${products.length} product(s)${dropped ? `, ${dropped} removed` : ''}`);
    return products;
}

/* -------------------------------------------------------- evaluation center */

function parseEvalLinks(html) {
    const links = new Map();
    const anchor = /<a\b[^>]*>/gi;
    let match;

    while ((match = anchor.exec(html)) !== null) {
        const tag = match[0];
        const href = tag.match(/href="(https:\/\/go\.microsoft\.com\/fwlink\/[^"]+)"/i)?.[1];
        const label = tag.match(/aria-label="([^"]*)"/i)?.[1];
        if (!href || !label) continue;
        if (!/download/i.test(label) || !/\biso\b/i.test(label)) continue;

        const locale = label.match(/\(([A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?)\)\s*$/)?.[1];
        if (!locale) continue;
        if (links.has(locale)) continue;

        links.set(locale, href.replace(/&amp;/g, '&'));
    }

    return [...links].map(([locale, url]) => ({ locale, url }));
}

async function resolveBuild(url) {
    try {
        const response = await request(url, { method: 'HEAD' });
        const file = decodeURIComponent(new URL(response.url).pathname.split('/').pop() ?? '');
        return file.match(/\b(\d{5}\.\d+)\b/)?.[1] ?? null;
    } catch {
        return null;
    }
}

async function collectEvalCenter(config, current) {
    const products = [];

    for (const page of config.evalPages ?? []) {
        const family = config.families.find((entry) => entry.id === 'windows-server');
        if (!family) continue;

        let links = [];
        try {
            const response = await request(page.url, { headers: { accept: 'text/html' } });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            links = parseEvalLinks(await response.text());
        } catch (error) {
            warn(`${page.name}: ${error.message}`);
        }

        const previous = current.products.find((product) => product.id === page.id);

        if (links.length === 0) {
            if (previous) {
                warn(`${page.name}: no ISO links found this run — keeping the previous entry`);
                products.push(previous);
            } else {
                warn(`${page.name}: no ISO links found — skipping`);
            }
            continue;
        }

        const preferred = links.find((link) => link.locale === 'en-US') ?? links[0];
        const build = (await resolveBuild(preferred.url)) ?? previous?.build ?? null;
        const version = page.name.match(/(20\d{2})/)?.[1] ?? versionOf(page.name, build, config);

        products.push({
            id: page.id,
            family: family.id,
            name: page.name,
            version,
            build,
            arch: 'x64',
            channel: 'evaluation',
            source: 'evalcenter',
            skus: links.length,
            links,
            pinned: true,
        });
        log(`${page.name}: ${links.length} language(s), build ${build ?? 'unknown'}`);
    }

    return products;
}

/* -------------------------------------------------------------- assembly */

function sortProducts(products, config) {
    const familyOrder = new Map(config.families.map((family, index) => [family.id, index]));

    return [...products].sort((a, b) => {
        const familyDelta = (familyOrder.get(a.family) ?? 99) - (familyOrder.get(b.family) ?? 99);
        if (familyDelta !== 0) return familyDelta;

        const versionDelta = versionSortKey(b.version) - versionSortKey(a.version);
        if (versionDelta !== 0) return versionDelta;

        const buildDelta = String(b.build ?? '').localeCompare(String(a.build ?? ''), undefined, { numeric: true });
        if (buildDelta !== 0) return buildDelta;

        return a.name.localeCompare(b.name);
    });
}

function prune(products, config) {
    const byFamily = new Map();
    for (const product of products) {
        if (!byFamily.has(product.family)) byFamily.set(product.family, []);
        byFamily.get(product.family).push(product);
    }

    const kept = [];
    for (const [familyId, entries] of byFamily) {
        const limit = config.families.find((family) => family.id === familyId)?.retain ?? entries.length;
        let budget = limit;
        for (const product of entries) {
            if (product.pinned) {
                kept.push(product);
                continue;
            }
            if (budget > 0) {
                kept.push(product);
                budget -= 1;
            } else {
                log(`pruned ${product.id} (${product.name}) — keeping the ${limit} newest ${familyId} product(s)`);
            }
        }
    }

    return kept;
}

/* -------------------------------------------------------------------- main */

async function main() {
    const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));

    let current = { products: [] };
    try {
        current = JSON.parse(await readFile(DATA_PATH, 'utf8'));
        if (!Array.isArray(current.products)) current = { products: [] };
    } catch {
        log('no existing data/products.json — starting from scratch');
    }

    const connector = await collectConnector(config, current);
    const evalCenter = await collectEvalCenter(config, current);

    const products = sortProducts(prune([...connector, ...evalCenter], config), config);
    const families = config.families
        .filter((family) => products.some((product) => product.family === family.id))
        .map((family) => ({ id: family.id, label: family.label }));

    const next = {
        updated: new Date().toISOString(),
        generator: 'tools/update-products.mjs',
        families,
        products,
    };

    if (products.length === 0) {
        console.error('[catalog] refusing to write an empty catalog');
        process.exit(1);
    }

    const previousBody = JSON.stringify({ ...current, updated: null }, null, 2);
    const nextBody = JSON.stringify({ ...next, updated: null }, null, 2);
    const changed = previousBody !== nextBody;

    if (!changed) {
        next.updated = current.updated ?? next.updated;
        log('catalog is already up to date');
    } else {
        log(`catalog changed: ${current.products.length} → ${products.length} product(s)`);
    }

    const output = `${JSON.stringify(next, null, 2)}\n`;

    if (CHECK) {
        if (changed) {
            console.error('[catalog] data/products.json is stale — run: node tools/update-products.mjs');
            process.exit(1);
        }
        return;
    }

    if (DRY_RUN) {
        process.stdout.write(output);
        return;
    }

    await writeFile(DATA_PATH, output);
    log(`wrote data/products.json (${products.length} products)`);
}

main().catch((error) => {
    console.error('[catalog] failed:', error);
    process.exit(1);
});
