#!/usr/bin/env node
/**
 * Guards the static site against missing files.
 *
 * The page has no bundler, so a renamed stylesheet, script or font only shows up
 * as a silent 404 in production. This script resolves every local reference in
 * index.html and css/style.css and fails when one of them is missing.
 *
 *   node tools/check-assets.mjs
 */

import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const isRemote = (url) => /^(?:[a-z]+:)?\/\//i.test(url) || /^(?:mailto|tel|data|javascript):/i.test(url);

const missing = [];
let checked = 0;

async function exists(target) {
    try {
        await access(target);
        return true;
    } catch {
        return false;
    }
}

async function checkReferences(file) {
    const source = await readFile(path.join(ROOT, file), 'utf8');
    const pattern = /(?:href|src)="([^"]+)"/g;
    let match;

    while ((match = pattern.exec(source)) !== null) {
        const raw = match[1].trim();
        if (!raw || raw.startsWith('#') || isRemote(raw)) continue;

        const url = raw.split('#')[0].split('?')[0];
        if (!url) continue;

        checked += 1;
        const resolved = path.resolve(ROOT, url);
        if (!(await exists(resolved))) missing.push(`${file} → ${url}`);
    }
}

async function checkCssUrls(file) {
    const source = await readFile(path.join(ROOT, file), 'utf8');
    const pattern = /url\((["']?)([^"')]+)\1\)/g;
    let match;

    while ((match = pattern.exec(source)) !== null) {
        const url = match[2].trim();
        if (!url || isRemote(url) || url.startsWith('data:')) continue;

        checked += 1;
        const resolved = path.resolve(ROOT, path.dirname(file), url);
        if (!(await exists(resolved))) missing.push(`${file} → ${url}`);
    }
}

await checkReferences('index.html');
await checkReferences('chocolatey.html');
await checkReferences('activation.html');
await checkReferences('404.html');
await checkCssUrls('css/style.css');

if (missing.length > 0) {
    for (const entry of missing) console.error('missing:', entry);
    console.error(`\n${missing.length} broken local reference(s).`);
    process.exit(1);
}

console.log(`All ${checked} local references resolve.`);
