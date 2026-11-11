#!/usr/bin/env node
/**
 * Refreshes data/chocolatey.json from the Chocolatey community feed.
 *
 * Only packages listed in data/chocolatey.config.json are published, so the
 * page always shows verified ids together with their real title, summary and
 * download count.
 *
 *   node tools/update-chocolatey.mjs           # write the file
 *   node tools/update-chocolatey.mjs --dry-run # print what would change
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(ROOT, 'data', 'chocolatey.config.json');
const DATA_PATH = path.join(ROOT, 'data', 'chocolatey.json');

const DRY_RUN = process.argv.includes('--dry-run');
const PAGE_SIZE = 200;
const PAGES = 8; // the 1,600 most downloaded packages cover the whole curated list
const CONCURRENCY = 6;

const log = (...parts) => console.error('[choco]', ...parts);
const warn = (...parts) => console.warn('[choco]', ...parts);

const decode = (value) =>
    String(value ?? '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
        .replace(/&apos;/g, "'");

/** Parses an OData Atom feed into compact package records. */
function parseFeed(xml) {
    const packages = [];
    const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];

    for (const entry of entries) {
        const id = entry.match(/<title type="text">([^<]+)<\/title>/)?.[1]?.trim();
        if (!id) continue;

        const title = entry.match(/<d:Title>([^<]*)<\/d:Title>/)?.[1];
        const summary = entry.match(/<summary type="text">([^<]*)<\/summary>/)?.[1];
        const downloads = entry.match(/<d:DownloadCount[^>]*>(\d+)<\/d:DownloadCount>/)?.[1];

        packages.push({
            id: id.toLowerCase(),
            name: decode(title ?? id),
            summary: decode(summary ?? '').trim(),
            downloads: Number(downloads ?? 0),
        });
    }

    return packages;
}

async function fetchPage(feed, skip, top) {
    const url =
        `${feed}?$filter=IsLatestVersion&$orderby=DownloadCount%20desc` +
        `&$skip=${skip}&$top=${top}&$select=Id,Title,Summary,DownloadCount`;

    const response = await fetch(url, {
        headers: { accept: 'application/atom+xml', 'user-agent': 'msdl-catalog-updater' },
        signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) throw new Error(`feed responded ${response.status}`);
    return parseFeed(await response.text());
}

async function fetchOne(feed, id) {
    const url = `${feed}?$filter=Id%20eq%20'${encodeURIComponent(id)}'%20and%20IsLatestVersion&$top=1&$select=Id,Title,Summary,DownloadCount`;
    try {
        const response = await fetch(url, {
            headers: { accept: 'application/atom+xml', 'user-agent': 'msdl-catalog-updater' },
            signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) return null;
        return parseFeed(await response.text())[0] ?? null;
    } catch {
        return null;
    }
}

async function pool(items, worker, concurrency = CONCURRENCY) {
    const results = new Array(items.length);
    let cursor = 0;

    await Promise.all(
        Array.from({ length: Math.min(concurrency, items.length) }, async () => {
            while (cursor < items.length) {
                const index = cursor++;
                results[index] = await worker(items[index]);
            }
        }),
    );
    return results;
}

const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
const feed = config.feed ?? 'https://community.chocolatey.org/api/v2/Packages()';
const wanted = Object.keys(config.packages ?? {});

// Download counts matter for ordering only; the curated list decides membership.
for (const id of wanted) config.packages[id] = config.packages[id].trim();

const found = new Map();

for (let page = 0; page < PAGES; page += 1) {
    let entries = [];
    try {
        entries = await fetchPage(feed, page * PAGE_SIZE, PAGE_SIZE);
    } catch (error) {
        warn(`page ${page}: ${error.message}`);
        break;
    }
    if (entries.length === 0) break;

    for (const entry of entries) {
        if (config.packages[entry.id] && !found.has(entry.id)) found.set(entry.id, entry);
    }
    if (found.size === wanted.length) break;
}

const missing = wanted.filter((id) => !found.has(id));
if (missing.length > 0) {
    log(`resolving ${missing.length} package(s) outside the top ${PAGES * PAGE_SIZE}`);
    const resolved = await pool(missing, (id) => fetchOne(feed, id));
    resolved.forEach((entry, index) => {
        if (entry) found.set(missing[index], entry);
    });
}

const dropped = wanted.filter((id) => !found.has(id));
for (const id of dropped) warn(`package "${id}" was not found on the feed — dropping it`);

if (found.size === 0) {
    console.error('[choco] no packages resolved; leaving the existing file untouched');
    process.exit(1);
}

if (wanted.length >= 20 && found.size / wanted.length < 0.5) {
    console.error(`[choco] only ${found.size}/${wanted.length} packages resolved — refusing to rewrite`);
    process.exit(1);
}

const categoryOrder = new Map((config.categories ?? []).map((category, index) => [category.id, index]));

const packages = [...found.values()]
    .map((entry) => ({
        id: entry.id,
        name: entry.name,
        summary: entry.summary,
        category: config.packages[entry.id],
        downloads: entry.downloads,
    }))
    .filter((entry) => entry.category && categoryOrder.has(entry.category))
    .sort((a, b) => {
        const byCategory = categoryOrder.get(a.category) - categoryOrder.get(b.category);
        if (byCategory !== 0) return byCategory;
        if (b.downloads !== a.downloads) return b.downloads - a.downloads;
        return a.name.localeCompare(b.name);
    });

const next = {
    updated: new Date().toISOString(),
    source: 'community.chocolatey.org',
    installCommand: config.installCommand,
    categories: (config.categories ?? []).filter((category) =>
        packages.some((entry) => entry.category === category.id),
    ),
    packages,
};

let current = null;
try {
    current = JSON.parse(await readFile(DATA_PATH, 'utf8'));
} catch {
    /* first run */
}

const stable = (value) => JSON.stringify({ ...value, updated: null });
const changed = stable(current ?? {}) !== stable(next);

if (!changed) {
    next.updated = current.updated;
    log(`catalogue is up to date (${packages.length} packages)`);
} else {
    log(`catalogue changed: ${current?.packages?.length ?? 0} → ${packages.length} packages`);
}

const output = `${JSON.stringify(next, null, 2)}\n`;

if (DRY_RUN) {
    process.stdout.write(output);
} else if (changed) {
    await writeFile(DATA_PATH, output);
    log(`wrote data/chocolatey.json`);
} else {
    await writeFile(DATA_PATH, output);
}
