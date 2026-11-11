Microsoft Software Download Listing
===================================

**MSDL** is a static index of every official Windows release Microsoft still serves — retail,
Arm64 and Server images — plus a Chocolatey command builder that turns a list of software into
one install line.

Plain HTML, CSS and JavaScript: no build step, no framework, no tracker. The catalogues are
regenerated from Microsoft's own services and from the Chocolatey community feed by GitHub
Actions, daily.

Pages
-----

| Page | What it does |
| --- | --- |
| `index.html` | Browse and download Windows, pick a product from the picker, copy a download link |
| `chocolatey.html` | Install Chocolatey and build a `choco install` command from 150+ packages |
| `office.html` | Download and install Office: ODT route, ready-made C2R images, checks |
| `activation.html` | Step-by-step guide to the MAS one-line command for Windows and Office |
| `404.html` | Self-contained not-found page |

**Activation** explains the Microsoft Activation Scripts one-liner
(`irm https://get.activated.win | iex`) in our own words: what each menu option does for Windows
and for Office, which one to pick, how to confirm the result, and what to watch out for. The
method belongs to the [massgrave.dev](https://massgrave.dev/) project, which is credited on the
page.

Products listed
---------------

| Family | Source | Notes |
| --- | --- | --- |
| Windows 11 | Software Download connector | x64 and Arm64, retail channel |
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

### How the catalogues stay current

`.github/workflows/update-products.yml` runs every day at **04:17 UTC** and on demand. Each run:

1. re-reads every published product so renamed releases and new builds are picked up,
2. scans the next 300 product IDs for newly published releases,
3. refreshes the Windows Server evaluation links and their build numbers,
4. refreshes the Chocolatey package list,
5. validates both files and commits them when anything changed.

`.github/workflows/validate.yml` runs on every push and pull request: syntax-checks the scripts,
validates both data files against their policies, and verifies that every local stylesheet,
script, font and page reference exists.

Download links and the proxy
----------------------------

Microsoft's download connector sits behind a bot check ("Sentinel"). A plain request — including
the public `api.gravesoft.dev` proxy — gets `ErrorSettings.SentinelReject` when generating links,
so the product list works but the last step fails.

`server/` contains a service that fixes this. It opens Microsoft's download page in a headless
browser **once**, completes a real download flow, keeps the resulting `sessionID`, and from then
on serves cheap HTTP calls for every product and language (generated links are cached for ten
minutes). It mirrors the endpoints the page already uses:

```bash
cd server
npm install
npm start                                          # http://127.0.0.1:8787
curl 'http://127.0.0.1:8787/skuinfo?product_id=3262'
curl 'http://127.0.0.1:8787/proxy?product_id=3262&sku_id=19675'
```

Deploy it with `server/Dockerfile` on any Node 20+ host, then point the site at it with one line
in `index.html`:

```html
<meta name="msdl-api" content="https://your-proxy.example">
```

Without a proxy the site still works — it shows a clear error plus a link to Microsoft's own
download page.

Chocolatey builder
------------------

`chocolatey.html` explains how to install Chocolatey and builds a `choco install` command from
156 verified packages, grouped by category and searchable. The selection is stored in
`localStorage` and mirrored into the URL (`chocolatey.html#git,vscode,7zip`), so a setup can be
shared.

`data/chocolatey.json` is generated from the Chocolatey community feed:

```bash
node tools/update-chocolatey.mjs            # refresh titles, summaries, download counts
node tools/update-chocolatey.mjs --dry-run  # preview
```

Which packages appear is decided by `data/chocolatey.config.json` — add a package id with a
category and the updater validates it against the live feed, dropping anything that no longer
exists.

The design
----------

Quiet surfaces and real typography, with the index's technical detail kept intact:

- **Type** — the system stack (SF on Apple platforms, Segoe UI on Windows) for the interface;
  a self-hosted JetBrains Mono (latin subset, SIL OFL — see `fonts/LICENSE.txt`) for build
  numbers, package ids, status readouts and code.
- **Colour** — near-white `#fbfbfd` and true black, a single blue accent for anything
  interactive, and a green dot used only for the live-catalogue signal. Both themes meet WCAG AA.
- **Layout** — a two-column hero with the catalogue-status card, a product picker instead of a
  long list, hairline cards and generous whitespace.
- **State** — loading skeletons, empty states, a clear error panel when Microsoft rejects a
  request, and a link to the manual download page.
- **Keyboard** — `/` or `⌘K` focuses search, `↓` jumps into the picker, `esc` closes the detail.
- `prefers-reduced-motion` and `prefers-color-scheme` are respected, and the chosen theme is
  remembered.

Deploying to Cloudflare Pages
----------------------------

The site is static, so Pages serves the repository root as-is.

1. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git** and pick
   `Jas0n0ss/msdl`. Framework preset: *None*, build command: empty, output directory: `/`.
2. **Custom domains → Set up a custom domain** → `msdl.404x.io`. The `404x.io` zone must be in
   the same Cloudflare account; the CNAME is created automatically.
3. `.github/workflows/deploy-cloudflare.yml` deploys on every push once two repository secrets
   exist: `CLOUDFLARE_API_TOKEN` (Pages:Edit) and `CLOUDFLARE_ACCOUNT_ID`. If you use Pages' own
   Git integration instead, delete that workflow — running both deploys twice.

`_headers` sets security and cache headers (HTML revalidates, fonts are immutable, JSON is
cached for five minutes). `_redirects` maps the short paths (`/catalog`, `/choco`, `/activate`).

The download proxy is **not** part of Pages. It runs as a Worker with Browser Rendering
(`worker/`), which drives Microsoft's page in a real browser so Sentinel accepts the request:

```bash
cd worker && npm install && npx wrangler deploy
# https://api.msdl.404x.io/skuinfo?product_id=3813
# https://api.msdl.404x.io/proxy?product_id=3813&sku_id=27160
```

`index.html` points `<meta name="msdl-api">` at that Worker. A Node container (`server/`) is kept
as an alternative for hosts without Browser Rendering.

Running locally
---------------

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

Any static file server works; the page only needs `index.html`, `chocolatey.html`, `css/`,
`js/`, `fonts/` and `data/`. Opening the files from disk will not work, because the pages fetch
their JSON.

Layout
------

```
index.html                  the catalogue
chocolatey.html             the package builder
404.html                    self-contained not-found page
css/style.css               design tokens, layout, components
js/msdl.js                  catalogue, picker, routing, download flow
js/choco.js                 Chocolatey builder
data/products.json          generated Windows catalogue
data/catalog.config.json    curation policy
data/chocolatey.json        generated package catalogue
data/chocolatey.config.json package curation policy
fonts/                      JetBrains Mono woff2 subset (SIL OFL 1.1)
server/                     download-link proxy (Node + Playwright, Dockerfile included)
tools/                      catalog updaters + validators
.github/workflows/          scheduled refresh + validation
```

License
-------
This project is licensed under the terms of GNU Affero General Public License Version 3.
