#!/usr/bin/env node
/**
 * Builds data/activation.json and img/activation/*.jpg from massgrave.dev.
 * Text and screenshots are theirs; the page always links back to the source.
 *
 *   node tools/update-activation.mjs
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'activation.json');
const SHOTS = path.join(ROOT, 'img', 'activation');

const PAGES = [
    { slug: 'hwid', category: 'windows', title: 'HWID', blurb: 'Permanent digital licence tied to the hardware — survives reinstalls.' },
    { slug: 'tsforge', category: 'windows', title: 'TSforge', blurb: 'Offline activation for Windows 7 through 11 and Server.' },
    { slug: 'kms38', category: 'windows', title: 'KMS38', blurb: 'Activates until 2038 without running a background service.' },
    { slug: 'online_kms', category: 'windows', title: 'Online KMS', blurb: 'Renewable 180-day activation, renewed automatically.' },
    { slug: 'ohook', category: 'office', title: 'Ohook', blurb: 'Permanent Office activation that never touches the licence servers.' },
    { slug: 'online_kms', category: 'office', title: 'Online KMS', blurb: 'The same 180-day renewable route, applied to Office.' },
    { slug: 'check_activation_status', category: 'guides', title: 'Check activation status', blurb: 'See exactly what is activated on the machine.' },
    { slug: 'change_windows_edition', category: 'guides', title: 'Change Windows edition', blurb: 'Switch editions in place without reinstalling.' },
];

const clean = (text) => text.replace(/\s+/g, ' ').trim();

async function scrape(page) {
    const url = `https://massgrave.dev/${page.slug}`;
    const html = await (await fetch(url)).text();
    const article = html.match(/<article[^>]*>([\s\S]*?)<\/article>/)?.[1] ?? html;
    const text = clean(
        article
            .replace(/<(script|style)[\s\S]*?<\/\1>/g, ' ')
            .replace(/<[^>]+>/g, ' '),
    );
    return { ...page, url, excerpt: text.slice(0, 260) };
}

const { chromium } = await import('playwright').catch(() => import('/Users/hubo/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs'));

const entries = [];
await mkdir(SHOTS, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
const shot = await browser.newPage({ viewport: { width: 1200, height: 750 }, deviceScaleFactor: 1 });

for (const [index, page] of PAGES.entries()) {
    const entry = await scrape(page);
    const file = `${page.category}-${page.slug}${page.category === 'windows' && page.slug === 'online_kms' ? '-win' : ''}.jpg`;
    await shot.goto(entry.url, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
    await shot.waitForTimeout(400);
    await shot.screenshot({ path: path.join(SHOTS, file), type: 'jpeg', quality: 78 });
    entries.push({ ...entry, image: `img/activation/${file}` });
    console.log('captured', entry.url);
}
await browser.close();

await writeFile(
    OUT,
    `${JSON.stringify(
        {
            updated: new Date().toISOString(),
            source: 'https://massgrave.dev/',
            credit: 'Activation guides and screenshots © massgrave.dev contributors.',
            categories: [
                { id: 'windows', label: 'Windows activation' },
                { id: 'office', label: 'Office activation' },
                { id: 'guides', label: 'Guides' },
            ],
            entries,
        },
        null,
        2,
    )}\n`,
);
console.log(`wrote ${entries.length} entries`);
