# Schoolzones Alkmaar — Architecture & Code Standards

## 1. Architecture Principles

### 1.1 Zero-build static site
- **No bundler, no framework, no transpiler.** The site ships as plain HTML, CSS, and vanilla JS.
- All dependencies (Leaflet, Turf.js) are loaded from CDN with SRI hashes and local fallback is NOT required (static site, always online).
- The deploy pipeline: GitHub Actions updates data → commits to `main` → Netlify auto-deploys.

### 1.2 Single HTML entry point
- One `index.html` file contains all sections in document order.
- CSS in `css/main.css`, JS in `js/main.js` (plus `js/map.js` for map-specific logic if needed).
- No SPA router — the page is one long scroll with in-page anchor links.

### 1.3 Data as static GeoJSON
- All data lives in `/data/*.geojson` files, fetched at runtime with `fetch()`.
- Four canonical data files:
  - `data/schools.geojson` — school locations, metadata, entrance coordinates (manual, updated rarely)
  - `data/accidents.geojson` — STAR-registered traffic accidents (auto-updated daily)
  - `data/priority-streets.geojson` — the five priority street geometries (manual)
  - `data/zones.geojson` — 100m buffers around school entrances (generated from schools.geojson)
- Zone buffers are **generated** via a Node script (`scripts/generate-zones.js`) using Turf.js, NOT computed in the browser. Re-run only when schools.geojson changes.
- GeoJSON files are the single source of truth. The HTML never hardcodes data that belongs in GeoJSON.

### 1.4 Automated data pipeline
- **GitHub Actions** runs a scheduled workflow daily at 06:00 CET.
- The workflow executes `scripts/fetch-accidents.js`, which:
  1. Queries the STAR open data API (Rijkswaterstaat / data.overheid.nl) for Alkmaar traffic accidents
  2. Filters to the relevant date range (Jan 2021 – present) and municipality
  3. Transforms results to the canonical `accidents.geojson` schema
  4. Writes `data/accidents.geojson`
- If the data changed, the workflow commits and pushes to `main`, triggering a Netlify redeploy.
- If the API is unreachable or returns an error, the workflow fails silently (keeps the previous data) and logs an error. The existing `accidents.geojson` in the repo is always a valid fallback.
- The hero banner day counter is derived from the most recent `date` in `accidents.geojson`, so it updates automatically after each successful data refresh.
- School data (`schools.geojson`) is maintained manually — school openings/closures are infrequent and require editorial review.

### 1.5 Progressive rendering
- The page is usable (hero, text, table) before JS loads.
- The map initialises after `DOMContentLoaded` and fetches data asynchronously.
- A loading spinner or skeleton is shown inside the map container until tiles + data are ready.

### 1.6 Mobile-first responsive
- CSS uses mobile-first `min-width` breakpoints.
- The map is full-width on mobile; the table scrolls horizontally if needed.
- Touch targets ≥ 44px.

### 1.7 Accessibility baseline
- Semantic HTML5 elements (`<header>`, `<main>`, `<section>`, `<table>`, `<footer>`).
- All images/icons have `alt` text.
- Colour contrast ≥ 4.5:1 (WCAG AA).
- The map is supplemented by the ranking table — screen reader users get the same information via the table.

### 1.8 Performance budget
- Total page weight < 500 KB (excluding map tiles).
- No web fonts heavier than one variable-weight file; prefer system fonts where possible.
- Images optimised as WebP with `<picture>` fallback.

---

## 2. File Structure

```
schoolzones-alkmaar/
├── index.html
├── css/
│   └── main.css
├── js/
│   ├── main.js          # hero counter, table rendering, social sharing
│   └── map.js           # Leaflet map init, layers, popups
├── data/
│   ├── schools.geojson
│   ├── accidents.geojson
│   ├── priority-streets.geojson
│   └── zones.geojson    # generated, not hand-edited
├── scripts/
│   ├── generate-zones.js    # Node script: reads schools.geojson → outputs zones.geojson
│   └── fetch-accidents.js   # Node script: fetches STAR data → outputs accidents.geojson
├── .github/
│   └── workflows/
│       └── update-data.yml  # Daily cron: runs fetch-accidents.js, commits if changed
├── img/                     # favicons, OG image, any illustrations
├── ARCHITECTURE.md          # this file
├── BACKLOG.md               # project backlog
└── netlify.toml
```

---

## 3. Code Standards

### 3.1 HTML
- Language attribute: `<html lang="nl">`.
- UTF-8, viewport meta, descriptive `<title>`.
- Sections use `id` attributes matching the nav anchors (e.g., `id="kaart"`, `id="ranking"`).
- No inline styles. No inline `onclick`; all event binding in JS.

### 3.2 CSS
- Single file `css/main.css`, no preprocessor.
- Use CSS custom properties (variables) for the colour palette and spacing scale.
- BEM-light naming: `.hero__counter`, `.ranking-table__row--highlight`.
- Colour palette:
  - `--clr-danger`: red (#D32F2F) — accidents, urgency
  - `--clr-warning`: amber/orange (#F57C00) — zones, caution
  - `--clr-safe`: green (#388E3C) — positive example (Westerweg)
  - `--clr-bg`: near-white (#FAFAFA)
  - `--clr-text`: near-black (#212121)
- No `!important` unless overriding third-party (Leaflet) styles.
- Media queries at the bottom of the file, grouped by breakpoint.

### 3.3 JavaScript
- ES6+ (const/let, arrow functions, template literals, async/await). No var.
- Strict mode implicit via `type="module"` on `<script>` tags.
- No global variables — each module exports what it needs.
- All DOM queries use `document.querySelector` / `querySelectorAll`.
- Error handling: every `fetch()` has a `.catch()` or try/catch with user-visible fallback (e.g., "Data kon niet geladen worden").
- Numbers and dates formatted with `Intl.NumberFormat('nl-NL')` and `Intl.DateTimeFormat('nl-NL')`.
- Comments in English (code is shared context); UI text in Dutch.

### 3.4 GeoJSON
- CRS: WGS 84 (EPSG:4326) — Leaflet's default.
- Feature properties use camelCase keys.
- Required properties per feature type:

**schools.geojson**
```json
{
  "name": "string",
  "type": "basisschool | middelbaar",
  "studentCount": "number",
  "entrances": [[lon, lat], ...]
}
```

**accidents.geojson**
```json
{
  "date": "YYYY-MM-DD",
  "severity": "materieel | letsel | dodelijk",
  "description": "string (optional)"
}
```

**priority-streets.geojson**
```json
{
  "name": "string",
  "currentLimit": 30 | 50,
  "note": "string (optional)"
}
```

### 3.5 Git & deploy
- Commits in English, imperative mood, max 72 chars subject.
- `main` branch deploys to production via Netlify.
- `netlify.toml` sets headers: `X-Frame-Options`, `Content-Security-Policy`, caching for static assets.

---

## 4. Key Technical Decisions

| Decision | Rationale |
|---|---|
| No framework | Audience is non-technical citizens & council; site must load fast, last long without maintenance. Vanilla JS has zero dependency rot. |
| CDN dependencies | Leaflet (~40 KB gz) and Turf (~60 KB gz) are stable, versioned libraries. CDN gives caching benefits across sites. |
| Pre-generated zone buffers | Computing 100m buffers for ~30 schools is trivial in Node but wasteful to repeat on every page load. Generate once, commit result. |
| GeoJSON over CSV | Native format for Leaflet; no parsing step; supports geometries directly. |
| No backend | Data is public and static. No user accounts, no forms (yet). A petition form can be added later via Netlify Forms or a third-party embed. |
| GitHub Actions for data | Free, version-controlled data history (every change is a commit), transparent, no paid infra. Netlify redeploys automatically on push. |
| Fail-safe data pipeline | If the STAR API is down, the last committed GeoJSON remains valid. The site never breaks due to an API outage. |
| System font stack | Fastest possible text rendering; no FOUT/FOIT. If a branded font is added later, load it async with `font-display: swap`. |

---

### 3.6 Data pipeline scripts
- Scripts live in `/scripts/` and run in Node.js (≥18).
- `fetch-accidents.js`: pure data fetching — no side effects beyond writing `data/accidents.geojson`. Exits with code 0 on success, 1 on failure.
- `generate-zones.js`: reads `data/schools.geojson`, generates 100m Turf.js buffers, writes `data/zones.geojson`.
- Scripts log to stdout/stderr only. No interactive prompts.
- Scripts have a `package.json` in the project root with `@turf/buffer` and `@turf/helpers` as devDependencies (used by generate-zones.js and optionally by fetch-accidents.js for spatial filtering).

### 3.7 GitHub Actions workflow
- Workflow file: `.github/workflows/update-data.yml`.
- Trigger: `schedule` (cron `0 5 * * *` = 05:00 UTC / 06:00 CET) + `workflow_dispatch` (manual trigger).
- Steps: checkout → setup Node → install deps → run fetch script → check for diff → commit & push if changed.
- Uses the built-in `GITHUB_TOKEN` — no additional secrets needed (STAR API is public).
- Commit messages: `chore(data): update accidents.geojson [skip ci]` — the `[skip ci]` prevents infinite workflow loops.

---

## 5. Future Considerations (out of scope for v1)
- Netlify Forms or external form for petition signatures.
- Multilingual support (English version).
- Analytics (Plausible or similar privacy-friendly tool).
- Monitoring/alerting if the daily data fetch fails for multiple consecutive days.
