#!/usr/bin/env node
/**
 * Structural check for data/products.json.
 *
 * Runs in CI after every catalog refresh so a bad Microsoft response can never
 * publish a broken page. Also useful locally:
 *
 *   node tools/validate-products.mjs
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_PATH = path.join(ROOT, 'data', 'products.json');
const CONFIG_PATH = path.join(ROOT, 'data', 'catalog.config.json');

const errors = [];
const warnings = [];

const fail = (message) => errors.push(message);

function check(condition, message) {
    if (!condition) fail(message);
}

const data = JSON.parse(await readFile(DATA_PATH, 'utf8'));

/* ------------------------------------------------------------- top level */

check(typeof data.updated === 'string', 'top level: "updated" must be an ISO timestamp');
check(!Number.isNaN(Date.parse(data.updated)), 'top level: "updated" must parse as a date');
check(Array.isArray(data.families) && data.families.length > 0, 'top level: "families" must be a non-empty array');
check(Array.isArray(data.products) && data.products.length > 0, 'top level: "products" must be a non-empty array');

const familyIds = new Set();
for (const family of data.families ?? []) {
    check(typeof family.id === 'string' && family.id.length > 0, 'family: missing id');
    check(typeof family.label === 'string' && family.label.length > 0, `family ${family.id}: missing label`);
    check(!familyIds.has(family.id), `family ${family.id}: duplicate id`);
    familyIds.add(family.id);
}

/* -------------------------------------------------------------- products */

const ids = new Set();
const seenNames = new Set();
const sourceValues = new Set(['connector', 'evalcenter']);

for (const product of data.products ?? []) {
    const label = product?.name ?? product?.id ?? '<unknown>';

    check(typeof product.id === 'string' && product.id.length > 0, `${label}: id must be a non-empty string`);
    check(!ids.has(product.id), `${label}: duplicate id ${product.id}`);
    ids.add(product.id);

    check(typeof product.name === 'string' && product.name.trim().length > 0, `${product.id}: missing name`);
    check(familyIds.has(product.family), `${label}: unknown family "${product.family}"`);

    check(sourceValues.has(product.source), `${label}: unknown source "${product.source}"`);
    check(product.arch == null || ['x64', 'arm64'].includes(product.arch), `${label}: unexpected arch "${product.arch}"`);
    check(product.build == null || /^\d{5}(\.\d+)?$/.test(product.build), `${label}: unexpected build "${product.build}"`);

    if (product.source === 'connector') {
        check(/^\d+$/.test(product.id), `${label}: connector ids must be numeric`);
    }

    if (product.source === 'evalcenter') {
        check(Array.isArray(product.links) && product.links.length > 0, `${label}: evaluation products need ISO links`);
        for (const link of product.links ?? []) {
            check(typeof link.locale === 'string' && link.locale.length > 0, `${label}: link without locale`);
            check(
                typeof link.url === 'string' && link.url.startsWith('https://go.microsoft.com/fwlink/'),
                `${label}: link must point at a Microsoft fwlink`,
            );
        }
    }

    const nameKey = `${product.family}|${product.name?.toLowerCase()}|${product.arch ?? ''}`;
    check(!seenNames.has(nameKey), `${label}: duplicate entry for this family/arch`);
    seenNames.add(nameKey);

    if (/windows\s*8/i.test(product.name ?? '')) {
        fail(`${label}: Windows 8.x is intentionally excluded from this catalog`);
    }

    if (!product.build && product.family !== 'windows-7' && product.id !== 'windows-server-2022') {
        warnings.push(`${label}: no build number`);
    }
}

/* ---------------------------------------------------------------- policy */

for (const familyId of familyIds) {
    const count = (data.products ?? []).filter((product) => product.family === familyId).length;
    check(count > 0, `family ${familyId}: no products`);
}

for (const required of ['windows-11', 'windows-10', 'windows-server', 'windows-7']) {
    if (!familyIds.has(required)) warnings.push(`families: "${required}" is missing`);
}

/* ------------------------------------------------------- curation policy */

const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
const configFamilyIds = new Set((config.families ?? []).map((family) => family.id));

for (const familyId of familyIds) {
    check(configFamilyIds.has(familyId), `family ${familyId}: not declared in data/catalog.config.json`);
}

for (const familyId of configFamilyIds) {
    if (!familyIds.has(familyId)) warnings.push(`family ${familyId}: declared in the config but has no products`);
}

const excluded = (config.exclude ?? []).map((pattern) => new RegExp(pattern, 'i'));
for (const product of data.products ?? []) {
    const match = excluded.find((pattern) => pattern.test(product.name ?? ''));
    check(!match, `${product.name}: matches the exclude policy ${match}`);
}

/* ------------------------------------------------------------------ report */

for (const warning of warnings) console.warn('warning:', warning);

if (errors.length > 0) {
    for (const error of errors) console.error('error:', error);
    console.error(`\ndata/products.json is invalid (${errors.length} problem(s)).`);
    process.exit(1);
}

console.log(
    `data/products.json is valid — ${data.products.length} products across ${data.families.length} families.`,
);
