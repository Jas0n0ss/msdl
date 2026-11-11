Microsoft Software Download Listing
===================================

**MSDL** is a static index of every official Windows release Microsoft still serves — retail,
Arm64 and Server images — with one-click paths to their real download pages.

The site is plain HTML, CSS and JavaScript: no build step, no framework, no tracker. The
catalogue underneath it is regenerated from Microsoft's own services by GitHub Actions, twice a
day.

Products listed
---------------

| Family | Source | Notes |
| --- | --- | --- |
| Windows 11 | Software Download connector, through the public [MSDL API](https://api.gravesoft.dev/msdl/) | x64 and Arm64, release and evaluation channels |
| Windows 10 | Software Download connector | The editions Microsoft still publishes |
| Windows 7 | Software Download connector | All remaining retail editions |
| Windows Server | Microsoft Evaluation Center | 180-day evaluation ISOs, linked per language |

**Windows 8 / 8.1 is deliberately excluded.** The curation policy in
`data/catalog.config.json` drops it, and `tools/validate-products.mjs` fails the build if a
Windows 8.x entry ever reaches `data/products.json`.

The data
--------

`data/products.json` is **generated, never edited by hand**:

```json
{
  "updated": "2026-11-11T05:58:38.505Z",
  "families": [{ "id": "windows-11", "label": "Windows 11" }],
  "products": [
    {
      "id": "3813",
      "family": "windows-11",
      "name": "Windows 11 26H2 (26300.9457)",
      "version": "26H2",
      "build": "26300.9457",
      "arch": "x64",
      "source": "connector",
      "skus": 38
    }
  ]
}
```

`data/catalog.config.json` is the curation policy: which families are published, what to
exclude, how many releases to retain per family, and which Evaluation Center pages to read.
Change that file to change what the site lists — CI applies it on the next run.

```bash
node tools/update-products.mjs             # regenerate data/products.json
node tools/update-products.mjs --dry-run   # print the result, write nothing
node tools/update-products.mjs --check     # exit 1 when the catalog is stale
node tools/validate-products.mjs           # structure + curation policy check
node tools/check-assets.mjs                # every local href/src/font resolves
```

Pinned products (`"pinned": true`) survive automatic pruning — that is how the Windows 7 and
Windows 10 entries stay listed.

### How the catalogue stays current

`.github/workflows/update-products.yml` runs **twice a day** (04:17 and 16:17 UTC) and on
demand. Each run:

1. re-reads every published product so renamed releases and new builds are picked up,
2. scans the next 300 product IDs for newly published releases,
3. refreshes the Windows Server evaluation links and their build numbers,
4. validates the result and commits `data/products.json` when anything changed.

If the refresh fails, the workflow opens (or comments on) a **Catalog refresh failed** issue, so
a silent failure cannot leave the site stale for weeks. A manual run accepts a `dry_run` input
that prints the would-be catalogue without committing.

`.github/workflows/validate.yml` runs on every push and pull request: it validates the data
against the policy, syntax-checks the scripts, and verifies that every local stylesheet, script
and font referenced by the page exists.

The design
----------

An editorial, technical index rather than a marketing page:

- **Type** — Space Grotesk for display, Inter for text, JetBrains Mono for every number, build
  and label. All three are self-hosted (latin subsets, ~100 KB total) so the page never calls a
  third-party font service.
- **Colour** — warm paper and ink in light mode, near-black in dark mode, with a single
  phosphor-green accent used only for signal. Both themes meet WCAG AA for text.
- **Layout** — numbered rows, hairline rules and a blueprint grid, with a sticky family rail on
  desktop and wrapping filter chips on mobile.
- **State** — the manifest card in the hero reports the catalogue's last sync, entry count and
  refresh cadence, and turns amber when the data is older than 36 hours.
- **Keyboard** — `/` or `⌘K` to search, `↓`/`↑` to move through rows, `↵` to open, `esc` to go
  back.
- `prefers-reduced-motion` and `prefers-color-scheme` are both respected, and the chosen theme
  is remembered.

Running locally
---------------

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

Any static file server works; the page only needs `index.html`, `css/`, `js/`, `fonts/` and
`data/`. Opening `index.html` from the filesystem will not work, because the page fetches
`data/products.json`.

Layout
------

```
index.html                  the catalogue
404.html                    self-contained not-found page
css/style.css               design tokens, layout, components
js/msdl.js                  catalogue, routing, download flow
data/products.json          generated catalogue
data/catalog.config.json    curation policy
fonts/                      self-hosted woff2 subsets (SIL OFL 1.1)
tools/                      catalog updater + validators
.github/workflows/          scheduled refresh + validation
```

License
-------

This project is licensed under the terms of GNU Affero General Public License Version 3.

The bundled typefaces — Space Grotesk, Inter and JetBrains Mono — are licensed under the SIL
Open Font License 1.1; see `fonts/LICENSE.txt`.
