# Schoolzones Alkmaar — Backlog

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done

---

## Epic 1: Project Setup & Infrastructure

- [ ] **1.1** Create GitHub repo `schoolzones-alkmaar` (public)
- [ ] **1.2** Init project with directory structure per ARCHITECTURE.md
- [ ] **1.3** Add `package.json` with devDependencies (`@turf/buffer`, `@turf/helpers`)
- [ ] **1.4** Add `netlify.toml` with headers (CSP, X-Frame-Options) and cache rules
- [ ] **1.5** Add `.gitignore` (node_modules, .DS_Store, etc.)
- [ ] **1.6** Connect repo to Netlify (auto-deploy on push to `main`)

## Epic 2: Data Pipeline (GitHub Actions)

- [ ] **2.1** Research STAR open data API — confirm endpoint, query parameters, response format for Alkmaar accidents
- [ ] **2.2** Write `scripts/fetch-accidents.js` — fetch STAR data, filter Alkmaar + date range, transform to GeoJSON schema, write `data/accidents.geojson`
- [ ] **2.3** Write `.github/workflows/update-data.yml` — daily cron (06:00 CET), run fetch script, commit & push if data changed
- [ ] **2.4** Test workflow manually via `workflow_dispatch`
- [ ] **2.5** Verify Netlify auto-redeploys after data commit

## Epic 3: Data Collection & Preparation

- [ ] **3.1** Collect school data from scholenopdekaart.nl — Alkmaar basisscholen + middelbare scholen >100 leerlingen
- [ ] **3.2** Geocode school entrance coordinates (Google Maps / manual verification)
- [ ] **3.3** Create `data/schools.geojson` with name, type, studentCount, entrances
- [ ] **3.4** Write `scripts/generate-zones.js` — Turf.js 100m buffer per entrance → merge per school → write `data/zones.geojson`
- [ ] **3.5** Run generate-zones.js and commit `data/zones.geojson`
- [ ] **3.6** Create `data/priority-streets.geojson` — trace the five streets as LineString geometries with properties
- [ ] **3.7** Seed initial `data/accidents.geojson` via first run of fetch script (or manual if API not yet confirmed)

## Epic 4: HTML Skeleton & Styling

- [ ] **4.1** Create `index.html` with semantic structure: header, 6 sections (hero, kaart, ranking, straten, actie, bronnen), footer
- [ ] **4.2** Add meta tags: charset, viewport, description, OG tags (og:title, og:description, og:image, og:url)
- [ ] **4.3** Add Leaflet + Turf CDN links with SRI hashes
- [ ] **4.4** Create `css/main.css` — CSS custom properties, base typography, system font stack
- [ ] **4.5** Style hero section — large counter, alarming visual treatment, dark background
- [ ] **4.6** Style map container — full-width, responsive height, loading state
- [ ] **4.7** Style ranking table — sortable look, severity colour coding, responsive horizontal scroll on mobile
- [ ] **4.8** Style priority streets section — cards or list with street details
- [ ] **4.9** Style action stub section — CTA block, placeholder text
- [ ] **4.10** Style footer — bronnen/methodologie, compact
- [ ] **4.11** Add responsive breakpoints (mobile-first)

## Epic 5: Hero Banner & Day Counter

- [ ] **5.1** Write JS: parse `accidents.geojson`, find most recent date, calculate days difference
- [ ] **5.2** Render counter dynamically in hero section
- [ ] **5.3** Add lead-in text below counter ("Het is al X dagen geleden dat…")
- [ ] **5.4** Handle edge cases: no data loaded, date in the future, zero days

## Epic 6: Interactive Map

- [ ] **6.1** Write `js/map.js` — init Leaflet map centered on Alkmaar, OpenStreetMap tiles
- [ ] **6.2** Load and render `zones.geojson` as yellow/orange polygons with opacity
- [ ] **6.3** Load and render `schools.geojson` as markers with school icon, popups (name, type, students)
- [ ] **6.4** Load and render `accidents.geojson` as red circle markers, sized/coloured by severity, popups (date, severity, description)
- [ ] **6.5** Load and render `priority-streets.geojson` as red line overlays with popups (name, current limit, note)
- [ ] **6.6** Add map legend (zones, accidents by severity, priority streets)
- [ ] **6.7** Cluster accident markers at low zoom levels (Leaflet.markercluster or manual)
- [ ] **6.8** Show loading spinner/skeleton until all layers loaded
- [ ] **6.9** Test map on mobile — touch interactions, popup readability

## Epic 7: Per-School Ranking Table

- [ ] **7.1** Write JS: for each school, count accidents within its zone (spatial join using point-in-polygon or distance)
- [ ] **7.2** Calculate risk score (accidents / students or similar metric — define formula)
- [ ] **7.3** Render table: school name, leerlingen, # ongelukken, risicoscore
- [ ] **7.4** Sort table by risk score descending (most dangerous first)
- [ ] **7.5** Highlight top-5 riskiest schools visually
- [ ] **7.6** Make table rows clickable → pan map to that school

## Epic 8: Priority Streets Section

- [ ] **8.1** Create section with the five streets: Bergerweg/Geestersingel, Terborchlaan/Aert de Gelderlaan, Schinkelwaard, Vondelstraat, Westerweg
- [ ] **8.2** Per street: name, current situation, why it's dangerous, proposed change
- [ ] **8.3** Vondelstraat: note "30 km/u maar 50 km/u inrichting"
- [ ] **8.4** Westerweg: mark as positive example ("al in uitvoering")
- [ ] **8.5** Link each street to map location (scroll to map + highlight)

## Epic 9: Action Stub & Social Sharing

- [ ] **9.1** Add action stub section with placeholder text: "Wil jij ook veilige schoolroutes? We zijn in gesprek met de gemeente Alkmaar."
- [ ] **9.2** Add WhatsApp share button (wa.me link with pre-filled text)
- [ ] **9.3** Add copy-link button (Clipboard API with visual confirmation)
- [ ] **9.4** Verify OG meta tags render correctly (use opengraph.xyz or similar debugger)
- [ ] **9.5** Create OG image (1200x630px) — needs graphic design or generated

## Epic 10: Sources & Methodology

- [ ] **10.1** Write bronnen section: list data sources (STAR/BRON via RWS, scholenopdekaart.nl)
- [ ] **10.2** Explain methodology: 100m zone radius, risk score formula, data date range
- [ ] **10.3** Add disclaimer: data limitations, positional accuracy of STAR coordinates

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
| STAR API endpoint confirmation | Epic 2 (data pipeline) | Research API, test queries |
| School entrance coordinates | Epic 3 (zones), Epic 6-7 (map, ranking) | Manual geocoding from Google Maps |
| Gemeente overleg | Epic 9 (actie-stub final text) | Placeholder for now |
| OG image design | 9.5 | Can use generated/placeholder initially |

## Priority Order

Build in this order to get a working site as fast as possible:

1. **Epic 1** — infra (repo, Netlify)
2. **Epic 3** — manual data (schools, streets) — can start before API is confirmed
3. **Epic 2** — data pipeline (accidents) — research API first
4. **Epic 4** — HTML/CSS skeleton
5. **Epic 5** — hero counter (quick win, very visible)
6. **Epic 6** — map (core feature)
7. **Epic 7** — ranking table
8. **Epic 8** — priority streets
9. **Epic 9** — social/action
10. **Epic 10** — sources
11. **Epic 11** — testing
12. **Epic 12** — launch
