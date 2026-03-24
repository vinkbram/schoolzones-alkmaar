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
  materieel: '#E57373',
  letsel: '#D32F2F',
  dodelijk: '#B71C1C',
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

    const accidentCluster = L.markerClusterGroup({
      maxClusterRadius: 40,
      disableClusteringAtZoom: 16,
      iconCreateFunction: (cluster) => {
        const count = cluster.getChildCount();
        let size = 'small';
        let diameter = 36;
        if (count > 50) { size = 'large'; diameter = 52; }
        else if (count > 20) { size = 'medium'; diameter = 44; }

        // Check if cluster contains any new accidents
        const hasNew = latestFirstSeen && cluster.getAllChildMarkers().some(
          m => m.feature && m.feature.properties.firstSeen === latestFirstSeen
        );
        const newClass = hasNew ? ' marker-cluster--new' : '';

        return L.divIcon({
          html: `<div><span>${count}</span></div>`,
          className: `marker-cluster marker-cluster-${size}${newClass}`,
          iconSize: L.point(diameter, diameter),
        });
      },
    });

    const accidentLayer = L.geoJSON(accidents, {
      pointToLayer: (feature, latlng) => {
        const severity = feature.properties.severity || 'materieel';
        const isNew = latestFirstSeen && feature.properties.firstSeen === latestFirstSeen;
        return L.circleMarker(latlng, {
          radius: isNew ? 10 : (SEVERITY_RADIUS[severity] || 5),
          fillColor: SEVERITY_COLORS[severity] || '#E57373',
          color: isNew ? '#00E5FF' : '#fff',
          weight: isNew ? 3 : 1,
          fillOpacity: isNew ? 1 : 0.8,
          className: isNew ? 'accident-new' : '',
        });
      },
      onEachFeature: (feature, layer) => {
        const props = feature.properties;
        const severityLabel = {
          materieel: 'Materiële schade',
          letsel: 'Letselongeval',
          dodelijk: 'Dodelijk ongeval',
        };

        let dateStr = '';
        const displayDate = props.firstSeen || props.date;
        if (displayDate) {
          try {
            dateStr = dateFormatter.format(new Date(displayDate + 'T00:00:00'));
          } catch {
            dateStr = displayDate;
          }
        }

        const popup = `
          <strong>${severityLabel[props.severity] || 'Ongeluk'}</strong><br>
          ${dateStr ? `Datum: ${dateStr}<br>` : ''}
          ${props.description ? `<em>${props.description}</em>` : ''}
        `;
        layer.bindPopup(popup);
      },
    });

    accidentCluster.addLayer(accidentLayer);
    map.addLayer(accidentCluster);

    // 4. School markers (top layer)
    // Lucide "GraduationCap" icon (MIT license)
    const schoolSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#1E293B" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z"/><path d="M22 10v6"/><path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5"/></svg>';
    const schoolIcon = L.divIcon({
      html: schoolSvg,
      className: 'school-marker',
      iconSize: [28, 28],
      iconAnchor: [14, 14],
      popupAnchor: [0, -14],
    });

    L.geoJSON(schools, {
      pointToLayer: (feature, latlng) => L.marker(latlng, { icon: schoolIcon }),
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
