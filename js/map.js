// map.js — Leaflet map initialization, layers, popups

const DATA_BASE = './data';

// Gemeente Alkmaar center coordinates
const ALKMAAR_CENTER = [52.63, 4.77];
const DEFAULT_ZOOM = 13;

// Zone color scale: green (safe) → orange → red (dangerous)
// Thresholds based on 100m zone data
function zoneColor(accidentCount) {
  if (accidentCount === 0) return '#4CAF50';
  if (accidentCount <= 1) return '#8BC34A';
  if (accidentCount <= 3) return '#FF9800';
  if (accidentCount <= 6) return '#E64A19';
  return '#B71C1C';
}

function zoneBorderColor(accidentCount) {
  if (accidentCount === 0) return '#388E3C';
  if (accidentCount <= 1) return '#558B2F';
  if (accidentCount <= 3) return '#E65100';
  if (accidentCount <= 6) return '#BF360C';
  return '#7F0000';
}

const SEVERITY_COLORS = {
  materieel: '#FFA726',
  letsel: '#E53935',
  dodelijk: '#212121',
};

const SEVERITY_RADIUS = {
  materieel: 5,
  letsel: 7,
  dodelijk: 10,
};

let map = null;

async function initMap() {
  const container = document.getElementById('map');
  const loading = document.getElementById('map-loading');

  if (!container) return;

  // Initialize map
  map = L.map('map', {
    center: ALKMAAR_CENTER,
    zoom: DEFAULT_ZOOM,
    scrollWheelZoom: false,
    tap: true,
  });

  // Enable scroll zoom only after user clicks/focuses the map
  map.once('focus', () => map.scrollWheelZoom.enable());
  map.once('click', () => map.scrollWheelZoom.enable());

  // OpenStreetMap tiles
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(map);

  try {
    // Fetch core data in parallel
    const [zonesRes, schoolsRes, accidentsRes] = await Promise.all([
      fetch(`${DATA_BASE}/zones.geojson`),
      fetch(`${DATA_BASE}/schools.geojson`),
      fetch(`${DATA_BASE}/accidents-filtered.geojson`),
    ]);

    const [zones, schools, accidents] = await Promise.all([
      zonesRes.json(),
      schoolsRes.json(),
      accidentsRes.json(),
    ]);

    // Fetch routes separately (large file, non-blocking)
    let routes = { features: [] };
    try {
      const routesRes = await fetch(`${DATA_BASE}/school-routes.geojson`);
      if (routesRes.ok) routes = await routesRes.json();
    } catch (e) {
      console.warn('School routes failed to load:', e);
    }

    // Pre-compute accident stats per zone
    const dateFormatter = new Intl.DateTimeFormat('nl-NL', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    const zoneStats = {};
    for (const zone of zones.features) {
      const name = zone.properties.school;
      zoneStats[name] = { count: 0, lastDate: null };
    }
    for (const acc of accidents.features) {
      const d = acc.properties.date;
      // Match accident to zone by checking which school's zone it belongs to
      for (const zone of zones.features) {
        const name = zone.properties.school;
        if (typeof turf !== 'undefined' && turf.booleanPointInPolygon(
          turf.point(acc.geometry.coordinates), zone
        )) {
          zoneStats[name].count++;
          if (d && (!zoneStats[name].lastDate || d > zoneStats[name].lastDate)) {
            zoneStats[name].lastDate = d;
          }
          break;
        }
      }
    }

    // Find school data for popups
    const schoolMap = {};
    for (const s of schools.features) {
      schoolMap[s.properties.name] = s.properties;
    }

    // Route corridor colors
    const ROUTE_COLORS = {
      veilig: { fill: '#388E3C', border: '#2E7D32' },
      aandacht: { fill: '#F57C00', border: '#E65100' },
      onveilig: { fill: '#D32F2F', border: '#B71C1C' },
    };

    // 0a. School route corridors — colored by CROW safety score
    const routeLayer = L.geoJSON(routes, {
      style: (feature) => {
        const score = feature.properties.composite || 0;
        const label = score >= 2.5 ? 'veilig' : score >= 2 ? 'aandacht' : 'onveilig';
        const colors = ROUTE_COLORS[label] || ROUTE_COLORS.aandacht;
        return {
          color: colors.border,
          weight: 1,
          fillColor: colors.fill,
          fillOpacity: 0.25,
        };
      },
      onEachFeature: (feature, layer) => {
        const props = feature.properties;
        const scoreLabels = {
          scheiding: 'Scheiding van rijbaan',
          breedte: 'Breedte fietspad',
          verharding: 'Verharding',
          verlichting: 'Verlichting',
          snelheid: 'Snelheidscontext',
          conflicten: 'Ongevallen nabijheid',
        };

        const scoreHtml = Object.entries(props.scores || {}).map(([key, val]) => {
          const label = scoreLabels[key] || key;
          const dot = val >= 2.5
            ? '<span style="color:#2E7D32">&#9679;</span>'
            : val >= 2
              ? '<span style="color:#E65100">&#9679;</span>'
              : '<span style="color:#B71C1C">&#9679;</span>';
          return `${dot} ${label}: ${val.toFixed(1)}`;
        }).join('<br>');

        const schoolsStr = (props.schools || [props.school]).join(', ');
        const wijkenStr = (props.wijken || []).join(', ');

        const accDot = (props.accidentScore || 3) >= 2.5
          ? '<span style="color:#2E7D32">&#9679;</span>'
          : (props.accidentScore || 3) >= 2
            ? '<span style="color:#E65100">&#9679;</span>'
            : '<span style="color:#B71C1C">&#9679;</span>';

        layer.bindPopup(`
          <strong>${schoolsStr}</strong><br>
          ${props.streetName ? `<em>${props.streetName}</em><br>` : ''}
          Route vanuit: ${wijkenStr}<br>
          <hr style="margin:4px 0">
          <strong>CROW-score: ${props.crowScore || '–'}</strong><br>
          ${scoreHtml}<br>
          ${accDot} Ongevallen: ${props.accidentCount || 0}
          ${props.accidentScore ? ` (score: ${props.accidentScore})` : ''}<br>
          <hr style="margin:4px 0">
          <strong>Totaalscore: ${props.composite} (${props.label})</strong>
        `);
      },
    }); // routes not added to map by default — toggle via layer control

    // 0b. Zone polygons — colored by accident count
    const zoneLayer = L.geoJSON(zones, {
      style: (feature) => {
        const stats = zoneStats[feature.properties.school] || { count: 0 };
        return {
          color: zoneBorderColor(stats.count),
          weight: 2,
          fillColor: zoneColor(stats.count),
          fillOpacity: 0.35,
        };
      },
      onEachFeature: (feature, layer) => {
        const name = feature.properties.school;
        const stats = zoneStats[name] || { count: 0, lastDate: null };
        const school = schoolMap[name] || {};
        const formatter = new Intl.NumberFormat('nl-NL');

        let lastDateStr = '';
        if (stats.lastDate) {
          try {
            lastDateStr = dateFormatter.format(new Date(stats.lastDate + 'T00:00:00'));
          } catch { lastDateStr = stats.lastDate; }
        }

        const speedInfo = school.maxSpeed
          ? `Max. snelheid: <strong>${school.maxSpeed} km/u</strong>`
          : '';

        layer.bindPopup(`
          <strong>${name}</strong><br>
          ${school.studentCount ? `${formatter.format(school.studentCount)} leerlingen<br>` : ''}
          Ongelukken: <strong>${stats.count}</strong><br>
          ${lastDateStr ? `Laatste: ${lastDateStr}<br>` : ''}
          ${speedInfo}
        `);

        // Click zone → zoom in
        layer.on('click', () => {
          map.fitBounds(layer.getBounds(), { padding: [50, 50], maxZoom: 17 });
        });
      },
    }).addTo(map);

    // Find most recent firstSeen date to highlight newest accidents
    const allFirstSeen = accidents.features
      .map(f => f.properties.firstSeen)
      .filter(Boolean)
      .sort()
      .reverse();
    const latestFirstSeen = allFirstSeen[0] || null;

    // --- Aggregate accidents by location (starId) ---
    // Multiple year-records at the same coordinates become one marker
    // with a STAR-style bar chart popup showing the timeline.
    const byStarId = {};
    for (const f of accidents.features) {
      const id = f.properties.starId;
      if (!byStarId[id]) byStarId[id] = { coords: f.geometry.coordinates, records: [] };
      byStarId[id].records.push(f.properties);
    }

    const severityRank = { dodelijk: 3, letsel: 2, materieel: 1 };
    const locationFeatures = Object.values(byStarId).map(loc => {
      loc.records.sort((a, b) => (a.year || 0) - (b.year || 0));
      const worst = loc.records.reduce((w, r) =>
        (severityRank[r.severity] || 0) > (severityRank[w] || 0) ? r.severity : w, 'materieel');
      const latestFS = loc.records.reduce((latest, r) =>
        r.firstSeen && (!latest || r.firstSeen > latest) ? r.firstSeen : latest, null);

      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: loc.coords },
        properties: {
          worstSeverity: worst,
          hasFatal: worst === 'dodelijk',
          totalCount: loc.records.reduce((s, r) => s + (r.count || 1), 0),
          yearCount: loc.records.length,
          records: loc.records,
          firstSeen: latestFS,
          starId: loc.records[0].starId,
        },
      };
    });

    const accidentCluster = L.markerClusterGroup({
      maxClusterRadius: 40,
      disableClusteringAtZoom: 16,
      iconCreateFunction: (cluster) => {
        const count = cluster.getChildCount();
        let size = 'small';
        let diameter = 36;
        if (count > 50) { size = 'large'; diameter = 52; }
        else if (count > 20) { size = 'medium'; diameter = 44; }

        const markers = cluster.getAllChildMarkers();
        const hasFatal = markers.some(
          m => m.feature && m.feature.properties.hasFatal
        );
        const hasNew = latestFirstSeen && markers.some(
          m => m.feature && m.feature.properties.firstSeen === latestFirstSeen
        );
        const fatalClass = hasFatal ? ' marker-cluster--fatal' : '';
        const newClass = hasNew ? ' marker-cluster--new' : '';

        return L.divIcon({
          html: `<div><span>${count}</span></div>`,
          className: `marker-cluster marker-cluster-${size}${fatalClass}${newClass}`,
          iconSize: L.point(diameter, diameter),
        });
      },
    });

    const accidentLayer = L.geoJSON({ type: 'FeatureCollection', features: locationFeatures }, {
      pointToLayer: (feature, latlng) => {
        const props = feature.properties;
        const isNew = latestFirstSeen && props.firstSeen === latestFirstSeen;

        if (props.hasFatal) {
          // Fatal: dark-red circle with white X — unmissable
          const s = 24;
          const svg = `<svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}" xmlns="http://www.w3.org/2000/svg">` +
            `<circle cx="${s/2}" cy="${s/2}" r="${s/2-1}" fill="#212121" stroke="${isNew ? '#00E5FF' : '#fff'}" stroke-width="${isNew ? 3 : 2}"/>` +
            `<line x1="8" y1="8" x2="16" y2="16" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/>` +
            `<line x1="16" y1="8" x2="8" y2="16" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/>` +
            `</svg>`;
          return L.marker(latlng, {
            icon: L.divIcon({
              html: svg,
              className: 'accident-fatal' + (isNew ? ' accident-new' : ''),
              iconSize: [s, s],
              iconAnchor: [s / 2, s / 2],
              popupAnchor: [0, -s / 2],
            }),
            zIndexOffset: 1000,
          });
        }

        // Non-fatal: circle marker, slightly larger for multi-year locations
        const sev = props.worstSeverity || 'materieel';
        const base = SEVERITY_RADIUS[sev] || 5;
        const radius = props.yearCount > 1 ? base + 2 : base;

        return L.circleMarker(latlng, {
          radius: isNew ? radius + 2 : radius,
          fillColor: SEVERITY_COLORS[sev] || '#E57373',
          color: isNew ? '#00E5FF' : '#fff',
          weight: isNew ? 3 : 1,
          fillOpacity: isNew ? 1 : 0.8,
          className: isNew ? 'accident-new' : '',
        });
      },
      onEachFeature: (feature, layer) => {
        const props = feature.properties;
        const records = props.records;

        // STAR-style bar chart: continuous timeline 2021–2026
        const allYears = [2021, 2022, 2023, 2024, 2025, 2026];
        const recByYear = {};
        for (const r of records) recByYear[r.year] = r;

        const maxCount = Math.max(...records.map(r => r.count || 1), 1);
        const chartH = 60;

        const bars = allYears.map(yr => {
          const r = recByYear[yr];
          if (!r) {
            return `<div class="chart-bar"><div class="chart-bar__fill"></div><span class="chart-bar__label">${yr}</span></div>`;
          }
          const h = Math.max(4, ((r.count || 1) / maxCount) * chartH);
          const c = SEVERITY_COLORS[r.severity] || '#E57373';
          return `<div class="chart-bar"><div class="chart-bar__fill" style="height:${h}px;background:${c}"></div><span class="chart-bar__label">${yr}</span></div>`;
        }).join('');

        const title = props.hasFatal ? 'Dodelijk ongeval'
          : props.worstSeverity === 'letsel' ? 'Letselongeval' : 'Materiële schade';

        layer.bindPopup(`
          <div class="accident-chart">
            <strong>${title}</strong>
            <div class="accident-chart__bars" style="height:${chartH}px">${bars}</div>
            <div class="accident-chart__legend">
              <span><i style="background:#212121"></i> Dodelijk</span>
              <span><i style="background:#E53935"></i> Letsel</span>
              <span><i style="background:#FFA726"></i> Materieel</span>
            </div>
          </div>
        `);
      },
    });

    // 4. School markers (added before accidents so accidents render on top)
    // Lucide "Pencil" for basisscholen, "GraduationCap" for middelbaar (MIT license)
    const basisSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#1E293B" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/></svg>';
    const middelbaarSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#1E293B" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z"/><path d="M22 10v6"/><path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5"/></svg>';

    const basisIcon = L.divIcon({ html: basisSvg, className: 'school-marker', iconSize: [20, 20], iconAnchor: [10, 10], popupAnchor: [0, -10] });
    const middelbaarIcon = L.divIcon({ html: middelbaarSvg, className: 'school-marker', iconSize: [20, 20], iconAnchor: [10, 10], popupAnchor: [0, -10] });

    L.geoJSON(schools, {
      pointToLayer: (feature, latlng) => {
        const icon = feature.properties.type === 'middelbaar' ? middelbaarIcon : basisIcon;
        return L.marker(latlng, { icon, zIndexOffset: -1000 });
      },
      onEachFeature: (feature, layer) => {
        const props = feature.properties;
        const typeLabel = props.type === 'middelbaar' ? 'Middelbare school' : 'Basisschool';
        const formatter = new Intl.NumberFormat('nl-NL');
        layer.bindPopup(`
          <strong>${props.name}</strong><br>
          ${typeLabel}<br>
          ${props.studentCount ? `${formatter.format(props.studentCount)} leerlingen` : ''}
        `);
      },
    }).addTo(map);

    // 5. Accidents (on top of school markers)
    accidentCluster.addLayer(accidentLayer);
    map.addLayer(accidentCluster);

    // Layer control
    L.control.layers(null, {
      'Fietsroutes (CROW)': routeLayer,
      'Schoolgebieden (100m)': zoneLayer,
      'Ongelukken': accidentCluster,
    }, { collapsed: false }).addTo(map);

    // Hide loading
    loading.classList.add('map-container__loading--hidden');

  } catch (err) {
    console.error('Map data failed:', err);
    loading.textContent = 'Kaart kon niet geladen worden.';
  }
}

// --- Event listeners for cross-module communication ---

// Pan to school (triggered from ranking table click)
window.addEventListener('panToSchool', (e) => {
  if (!map) return;
  const { coordinates, name } = e.detail;
  // GeoJSON is [lon, lat], Leaflet is [lat, lon]
  map.setView([coordinates[1], coordinates[0]], 17);
});

// --- Init ---
document.addEventListener('DOMContentLoaded', initMap);
