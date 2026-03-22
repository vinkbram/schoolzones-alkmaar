// map.js — Leaflet map initialization, layers, popups

const DATA_BASE = './data';

// Alkmaar center coordinates
const ALKMAAR_CENTER = [52.6324, 4.7534];
const DEFAULT_ZOOM = 14;

// Layer styles
const ZONE_STYLE = {
  color: '#F57C00',
  weight: 2,
  fillColor: '#FFE0B2',
  fillOpacity: 0.35,
};

const STREET_STYLE = {
  color: '#D32F2F',
  weight: 5,
  opacity: 0.8,
};

const STREET_HIGHLIGHT_STYLE = {
  color: '#D32F2F',
  weight: 8,
  opacity: 1,
};

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
let streetLayers = {};

async function initMap() {
  const container = document.getElementById('map');
  const loading = document.getElementById('map-loading');

  if (!container) return;

  // Initialize map
  map = L.map('map', {
    center: ALKMAAR_CENTER,
    zoom: DEFAULT_ZOOM,
    scrollWheelZoom: true,
  });

  // OpenStreetMap tiles
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(map);

  try {
    // Fetch all data in parallel
    const [zonesRes, schoolsRes, accidentsRes, streetsRes] = await Promise.all([
      fetch(`${DATA_BASE}/zones.geojson`),
      fetch(`${DATA_BASE}/schools.geojson`),
      fetch(`${DATA_BASE}/accidents.geojson`),
      fetch(`${DATA_BASE}/priority-streets.geojson`),
    ]);

    const [zones, schools, accidents, streets] = await Promise.all([
      zonesRes.json(),
      schoolsRes.json(),
      accidentsRes.json(),
      streetsRes.json(),
    ]);

    // 1. Zone polygons (bottom layer)
    L.geoJSON(zones, {
      style: () => ZONE_STYLE,
      onEachFeature: (feature, layer) => {
        if (feature.properties.school) {
          layer.bindPopup(`<strong>Schoolzone</strong><br>${feature.properties.school}`);
        }
      },
    }).addTo(map);

    // 2. Priority streets
    L.geoJSON(streets, {
      style: () => STREET_STYLE,
      onEachFeature: (feature, layer) => {
        const props = feature.properties;
        const popup = `
          <strong>${props.name || 'Prioriteitsstraat'}</strong><br>
          Huidige limiet: ${props.currentLimit} km/u
          ${props.note ? `<br><em>${props.note}</em>` : ''}
        `;
        layer.bindPopup(popup);

        // Store reference by street ID for highlighting
        if (props.id) {
          streetLayers[props.id] = layer;
        }
      },
    }).addTo(map);

    // 3. Accident markers (clustered)
    const dateFormatter = new Intl.DateTimeFormat('nl-NL', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
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
        return L.divIcon({
          html: `<div><span>${count}</span></div>`,
          className: `marker-cluster marker-cluster-${size}`,
          iconSize: L.point(diameter, diameter),
        });
      },
    });

    const accidentLayer = L.geoJSON(accidents, {
      pointToLayer: (feature, latlng) => {
        const severity = feature.properties.severity || 'materieel';
        return L.circleMarker(latlng, {
          radius: SEVERITY_RADIUS[severity] || 5,
          fillColor: SEVERITY_COLORS[severity] || '#E57373',
          color: '#fff',
          weight: 1,
          fillOpacity: 0.8,
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
        if (props.date) {
          try {
            dateStr = dateFormatter.format(new Date(props.date + 'T00:00:00'));
          } catch {
            dateStr = props.date;
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
    const schoolIcon = L.divIcon({
      html: '🏫',
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

// Highlight street (triggered from street card click)
window.addEventListener('highlightStreet', (e) => {
  if (!map) return;
  const { streetId } = e.detail;
  const layer = streetLayers[streetId];

  if (layer) {
    // Reset all streets
    Object.values(streetLayers).forEach(l => l.setStyle(STREET_STYLE));
    // Highlight selected
    layer.setStyle(STREET_HIGHLIGHT_STYLE);
    layer.bringToFront();
    // Zoom to street
    map.fitBounds(layer.getBounds(), { padding: [50, 50] });
    layer.openPopup();
  }
});

// --- Init ---
document.addEventListener('DOMContentLoaded', initMap);
