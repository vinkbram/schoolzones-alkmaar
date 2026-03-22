# Schoolzones Alkmaar — Backlog

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done

---

## Epic 1: Project Setup & Infrastructure

- [x] **1.1** Create GitHub repo `schoolzones-alkmaar` (public)
- [x] **1.2** Init project with directory structure per ARCHITECTURE.md
- [x] **1.3** Add `package.json` with devDependencies
- [x] **1.4** Add `netlify.toml` with headers (CSP, X-Frame-Options) and cache rules
- [x] **1.5** Add `.gitignore` (node_modules, .DS_Store, etc.)
- [x] **1.6** Connect repo to Netlify (auto-deploy on push to `main`)

## Epic 2: Data Pipeline (GitHub Actions)

- [x] **2.1** Research STAR API — confirmed via.software PublicAccidents API (vector tiles + detail endpoint)
- [x] **2.2** Write `scripts/fetch-accidents.js` — fetches STAR tiles, decodes MVT, fetches detail, writes GeoJSON
- [x] **2.3** Write `.github/workflows/update-data.yml` — daily cron (06:00 CET), commit & push if changed
- [x] **2.4** Test workflow manually via `workflow_dispatch`
- [x] **2.5** Verify Netlify auto-redeploys after data commit

## Epic 3: Data Collection & Preparation

- [x] **3.1** Collect school data from DUO open onderwijsdata — 33 Alkmaar scholen (26 basisscholen + 7 middelbaar)
- [x] **3.2** Geocode school entrance coordinates (PDOK Locatieserver API)
- [x] **3.3** Create `data/schools.geojson` with real data (name, type, studentCount, entrances)
- [x] **3.4** Write `scripts/generate-zones.js` — Turf.js 100m buffer per entrance → write `data/zones.geojson`
- [x] **3.5** Run generate-zones.js with real school data and commit `data/zones.geojson`
- [x] **3.6** Create `data/priority-streets.geojson` — trace the five streets with real geometries
- [x] **3.7** Seed `data/accidents.geojson` — 2,524 accidents (2021-2026) from STAR API

## Epic 4: HTML Skeleton & Styling

- [x] **4.1** Create `index.html` with semantic structure: header, 6 sections, footer
- [x] **4.2** Add meta tags: charset, viewport, description, OG tags
- [x] **4.3** Add Leaflet + Turf CDN links with SRI hashes
- [x] **4.4** Create `css/main.css` — CSS custom properties, base typography, system font stack
- [x] **4.5** Style hero section — large counter, alarming visual treatment, dark background
- [x] **4.6** Style map container — full-width, responsive height, loading state
- [x] **4.7** Style ranking table — severity colour coding, responsive horizontal scroll on mobile
- [x] **4.8** Style priority streets section — cards with street details
- [x] **4.9** Style action stub section — CTA block, placeholder text
- [x] **4.10** Style footer — bronnen/methodologie, compact
- [x] **4.11** Add responsive breakpoints (mobile-first)

## Epic 5: Hero Banner & Day Counter

- [x] **5.1** Write JS: parse `accidents.geojson`, find most recent date, calculate days difference
- [x] **5.2** Render counter dynamically in hero section
- [x] **5.3** Add lead-in text below counter
- [x] **5.4** Handle edge cases: no data loaded, fallback to '?'

## Epic 6: Interactive Map

- [x] **6.1** Write `js/map.js` — init Leaflet map centered on Alkmaar, OpenStreetMap tiles
- [x] **6.2** Load and render `zones.geojson` as yellow/orange polygons with opacity
- [x] **6.3** Load and render `schools.geojson` as markers with school icon, popups
- [x] **6.4** Load and render `accidents.geojson` as red circle markers, sized/coloured by severity, popups
- [x] **6.5** Load and render `priority-streets.geojson` as red line overlays with popups
- [x] **6.6** Add map legend (zones, accidents by severity, priority streets)
- [x] **6.7** Cluster accident markers at low zoom levels (Leaflet.markercluster)
- [x] **6.8** Show loading spinner/skeleton until all layers loaded
- [ ] **6.9** Test map on mobile — touch interactions, popup readability

## Epic 7: Per-School Ranking Table

- [x] **7.1** Write JS: for each school, count accidents within its zone (point-in-polygon via Turf.js)
- [x] **7.2** Calculate risk score (accidents per 1000 students)
- [x] **7.3** Render table: school name, leerlingen, # ongelukken, risicoscore
- [x] **7.4** Sort table by risk score descending
- [x] **7.5** Highlight top-5 riskiest schools visually
- [x] **7.6** Make table rows clickable → pan map to that school

## Epic 8: Priority Streets Section

- [x] **8.1** Create section with the five streets
- [x] **8.2** Per street: name, current situation, why it's dangerous
- [x] **8.3** Vondelstraat: note "30 km/u maar 50 km/u inrichting"
- [x] **8.4** Westerweg: mark as positive example ("al in uitvoering")
- [x] **8.5** Link each street to map location (scroll to map + highlight)

## Epic 9: Action Stub & Social Sharing

- [x] **9.1** Add action stub section with placeholder text
- [x] **9.2** Add WhatsApp share button (wa.me link with pre-filled text)
- [x] **9.3** Add copy-link button (Clipboard API with visual confirmation)
- [ ] **9.4** Verify OG meta tags render correctly (use opengraph.xyz or similar debugger)
- [x] **9.5** Create OG image (1200x630px)

## Epic 10: Sources & Methodology

- [x] **10.1** Write bronnen section: list data sources (STAR, scholenopdekaart.nl)
- [x] **10.2** Explain methodology: 100m zone radius, risk score formula, data date range
- [x] **10.3** Add disclaimer: data limitations, positional accuracy

## Epic 11: Testing & Polish

- [ ] **11.1** Cross-browser test: Chrome, Firefox, Safari, Edge
- [ ] **11.2** Mobile test: iOS Safari, Android Chrome
- [ ] **11.3** Accessibility audit: keyboard navigation, screen reader, contrast check
- [ ] **11.4** Performance check: Lighthouse score, page weight budget (<500KB excl. tiles)
- [ ] **11.5** Verify daily data pipeline runs successfully for 3+ days
- [ ] **11.6** Proof-read all Dutch text

## Epic 12: Launch

- [ ] **12.1** Configure custom domain on Netlify + HTTPS
- [ ] **12.2** Final deploy to production
- [ ] **12.3** Test OG tags / social sharing on WhatsApp, Twitter, Facebook
- [ ] **12.4** Share with stakeholders for review

---

## Dependencies & Blockers

| Blocker | Blocks | Resolution |
|---|---|---|
| ~~STAR API endpoint confirmation~~ | ~~Epic 2~~ | ✅ Resolved — using via.software API |
| School entrance coordinates | Epic 3 (zones), Epic 6-7 (map, ranking) | Manual geocoding from Google Maps |
| Real street geometries | Epic 3.6, map accuracy | Trace from OpenStreetMap |
| Gemeente overleg | Epic 9 (actie-stub final text) | Placeholder for now |
| OG image design | 9.5 | Can use generated/placeholder initially |

## Remaining Work (priority order)

1. ~~**3.1-3.3** — Real school data~~ ✅ Done (33 schools from DUO + PDOK)
2. ~~**3.6** — Real priority street geometries~~ ✅ Done (5 streets from Overpass API)
3. ~~**3.5** — Regenerate zones with real school data~~ ✅ Done (33 zones)
4. **1.6** — Connect Netlify
5. **2.4-2.5** — Test GitHub Actions workflow
6. **6.7** — Marker clustering
7. **9.4-9.5** — OG image & verification
8. **11.x** — Testing & polish
9. **12.x** — Launch
