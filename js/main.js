// main.js — Hero counter, ranking table, social sharing

const DATA_BASE = './data';

// --- Day Counter ---
async function initCounter() {
  try {
    const res = await fetch(`${DATA_BASE}/accidents-filtered.geojson`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const dates = data.features
      .map(f => f.properties.firstSeen || f.properties.date)
      .filter(Boolean)
      .sort()
      .reverse();

    if (dates.length === 0) {
      document.getElementById('day-counter').textContent = '?';
      return;
    }

    const mostRecent = new Date(dates[0] + 'T00:00:00');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffDays = Math.floor((today - mostRecent) / (1000 * 60 * 60 * 24));

    const days = Math.max(0, diffDays);
    const counter = document.getElementById('day-counter');
    counter.textContent = days.toString();
    const label = document.getElementById('day-counter-label');
    if (label) label.textContent = days === 1 ? 'dag' : 'dagen';
  } catch (err) {
    console.error('Counter failed:', err);
    document.getElementById('day-counter').textContent = '?';
  }
}

// --- Ranking Table ---
async function initRanking() {
  try {
    const [schoolsRes, accidentsRes, zonesRes] = await Promise.all([
      fetch(`${DATA_BASE}/schools.geojson`),
      fetch(`${DATA_BASE}/accidents-filtered.geojson`),
      fetch(`${DATA_BASE}/zones.geojson`),
    ]);

    if (!schoolsRes.ok || !accidentsRes.ok || !zonesRes.ok) {
      throw new Error('Failed to load data');
    }

    const schools = await schoolsRes.json();
    const accidents = await accidentsRes.json();
    const zones = await zonesRes.json();

    // Load route data for painpoints
    let routes = { features: [] };
    try {
      const routesRes = await fetch(`${DATA_BASE}/school-routes.geojson`);
      if (routesRes.ok) routes = await routesRes.json();
    } catch (e) { /* non-blocking */ }

    const rankings = buildRankings(schools, accidents, zones, routes);
    renderTable(rankings);
  } catch (err) {
    console.error('Ranking table failed:', err);
    document.getElementById('ranking-tbody').innerHTML =
      '<tr><td colspan="5" style="text-align:center;padding:2rem;color:#757575;">Data kon niet geladen worden.</td></tr>';
  }
}

const CROW_LABELS = {
  scheiding: 'Geen scheiding fiets/auto',
  breedte: 'Te smal fietspad',
  verharding: 'Slechte verharding',
  verlichting: 'Geen verlichting',
  snelheid: 'Hoge snelheid',
  conflicten: 'Ongevallen nabij route',
};

function buildRankings(schools, accidents, zones, routes) {
  const rankings = [];

  // Pre-compute worst segment per school from route data
  const schoolWorstSegment = {};
  for (const route of routes.features) {
    const routeSchools = route.properties.schools || [route.properties.school];
    const composite = route.properties.composite || 3;
    const streetName = route.properties.streetName;
    const scores = route.properties.scores || {};
    const accidentCount = route.properties.accidentCount || 0;
    const accidentScore = route.properties.accidentScore || 3;

    for (const name of routeSchools) {
      if (!schoolWorstSegment[name] || composite < schoolWorstSegment[name].composite) {
        // Collect reasons this segment is bad
        const reasons = [];
        for (const [key, val] of Object.entries(scores)) {
          if (val < 2) reasons.push(CROW_LABELS[key] || key);
        }
        if (accidentScore < 2) reasons.push(`${accidentCount} ongevallen`);

        schoolWorstSegment[name] = {
          street: streetName,
          composite,
          reasons,
          accidentCount,
        };
      }
    }
  }

  for (const school of schools.features) {
    const schoolName = school.properties.name;
    const studentCount = school.properties.studentCount || 0;

    // Find matching zone for this school
    const zone = zones.features.find(z => z.properties.school === schoolName);

    let accidentCount = 0;
    if (zone && typeof turf !== 'undefined') {
      for (const accident of accidents.features) {
        const point = turf.point(accident.geometry.coordinates);
        if (turf.booleanPointInPolygon(point, zone)) {
          accidentCount++;
        }
      }
    }

    const worst = schoolWorstSegment[schoolName] || null;

    rankings.push({
      name: schoolName,
      studentCount,
      accidentCount,
      worstSegment: worst,
      coordinates: school.geometry.coordinates,
    });
  }

  // Sort by worst segment score ascending (most dangerous first), then by accident count
  rankings.sort((a, b) => {
    const aScore = a.worstSegment ? a.worstSegment.composite : 3;
    const bScore = b.worstSegment ? b.worstSegment.composite : 3;
    if (aScore !== bScore) return aScore - bScore;
    return b.accidentCount - a.accidentCount;
  });
  return rankings;
}

function renderTable(rankings) {
  const tbody = document.getElementById('ranking-tbody');
  tbody.innerHTML = '';

  const formatter = new Intl.NumberFormat('nl-NL');

  rankings.forEach((school, i) => {
    const row = document.createElement('tr');
    const isTop5 = i < 5;

    if (isTop5) {
      row.classList.add('ranking-table__row--highlight');
    }

    const riskClass = school.accidentCount >= 5 ? 'risk-high'
      : school.accidentCount >= 2 ? 'risk-medium'
      : '';

    row.setAttribute('tabindex', '0');
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', `Toon ${school.name} op kaart`);

    // Worst segment display
    let painHtml = '<span class="speed-ok">Geen knelpunten</span>';
    if (school.worstSegment && school.worstSegment.reasons.length > 0) {
      const streetName = school.worstSegment.street
        ? `<strong class="painpoint-street">${escapeHtml(school.worstSegment.street)}</strong><br>`
        : '';
      const tags = school.worstSegment.reasons
        .slice(0, 3)
        .map(r => `<span class="painpoint">${r}</span>`)
        .join(' ');
      painHtml = streetName + tags;
    } else if (school.worstSegment && school.worstSegment.street) {
      painHtml = `<span class="speed-ok">${escapeHtml(school.worstSegment.street)}</span>`;
    }

    row.innerHTML = `
      <td>${i + 1}</td>
      <td>${escapeHtml(school.name)}</td>
      <td>${formatter.format(school.studentCount)}</td>
      <td class="${riskClass}">${school.accidentCount}</td>
      <td>${painHtml}</td>
    `;

    // Click/Enter to pan map to school
    const panToSchool = () => {
      const mapSection = document.getElementById('kaart');
      mapSection.scrollIntoView({ behavior: 'smooth' });
      window.dispatchEvent(new CustomEvent('panToSchool', {
        detail: { name: school.name, coordinates: school.coordinates }
      }));
    };

    row.addEventListener('click', panToSchool);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        panToSchool();
      }
    });

    tbody.appendChild(row);
  });
}

// --- Social Sharing ---
function initSharing() {
  const pageUrl = window.location.href;
  const shareText = 'Schoolgebieden in Alkmaar zijn niet veilig. Bekijk de data — nul ongelukken bij scholen in 2030.';

  // WhatsApp
  const waBtn = document.getElementById('share-whatsapp');
  if (waBtn) {
    waBtn.href = `https://wa.me/?text=${encodeURIComponent(shareText + ' ' + pageUrl)}`;
    waBtn.target = '_blank';
    waBtn.rel = 'noopener noreferrer';
  }

  // Copy link
  const copyBtn = document.getElementById('share-copy');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(pageUrl);
        copyBtn.textContent = 'Gekopieerd!';
        copyBtn.classList.add('btn--copy--success');
        setTimeout(() => {
          copyBtn.textContent = 'Kopieer link';
          copyBtn.classList.remove('btn--copy--success');
        }, 2000);
      } catch {
        // Fallback for older browsers
        const input = document.createElement('input');
        input.value = pageUrl;
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        document.body.removeChild(input);
        copyBtn.textContent = 'Gekopieerd!';
        setTimeout(() => { copyBtn.textContent = 'Kopieer link'; }, 2000);
      }
    });
  }
}

// --- Utility ---
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- Init ---
document.addEventListener('DOMContentLoaded', () => {
  initCounter();
  initRanking();
  initSharing();
});
