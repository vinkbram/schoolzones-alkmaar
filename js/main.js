// main.js — Hero counter, ranking table, social sharing

const DATA_BASE = './data';

// --- Day Counter ---
async function initCounter() {
  try {
    const res = await fetch(`${DATA_BASE}/accidents.geojson`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const dates = data.features
      .map(f => f.properties.date)
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

    const counter = document.getElementById('day-counter');
    counter.textContent = Math.max(0, diffDays).toString();
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
      fetch(`${DATA_BASE}/accidents.geojson`),
      fetch(`${DATA_BASE}/zones.geojson`),
    ]);

    if (!schoolsRes.ok || !accidentsRes.ok || !zonesRes.ok) {
      throw new Error('Failed to load data');
    }

    const schools = await schoolsRes.json();
    const accidents = await accidentsRes.json();
    const zones = await zonesRes.json();

    const rankings = buildRankings(schools, accidents, zones);
    renderTable(rankings);
  } catch (err) {
    console.error('Ranking table failed:', err);
    document.getElementById('ranking-tbody').innerHTML =
      '<tr><td colspan="5" style="text-align:center;padding:2rem;color:#757575;">Data kon niet geladen worden.</td></tr>';
  }
}

function buildRankings(schools, accidents, zones) {
  const rankings = [];

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

    // Risk score: accidents per 1000 students
    const riskScore = studentCount > 0
      ? Math.round((accidentCount / studentCount) * 1000 * 10) / 10
      : 0;

    rankings.push({
      name: schoolName,
      studentCount,
      accidentCount,
      riskScore,
      coordinates: school.geometry.coordinates,
    });
  }

  // Sort by risk score descending
  rankings.sort((a, b) => b.riskScore - a.riskScore);
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

    const riskClass = school.riskScore >= 5 ? 'risk-high'
      : school.riskScore >= 2 ? 'risk-medium'
      : '';

    row.setAttribute('tabindex', '0');
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', `Toon ${school.name} op kaart`);

    row.innerHTML = `
      <td>${i + 1}</td>
      <td>${escapeHtml(school.name)}</td>
      <td>${formatter.format(school.studentCount)}</td>
      <td>${school.accidentCount}</td>
      <td class="${riskClass}">${school.riskScore.toFixed(1)}</td>
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
  const shareText = 'Schoolwegen in Alkmaar zijn niet veilig. Bekijk de data en steun de oproep voor 30 km/u bij elke school.';

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

// --- Street card map links ---
function initStreetLinks() {
  document.querySelectorAll('.straat-card__map-link').forEach(btn => {
    btn.addEventListener('click', () => {
      const streetId = btn.dataset.street;
      document.getElementById('kaart').scrollIntoView({ behavior: 'smooth' });
      window.dispatchEvent(new CustomEvent('highlightStreet', {
        detail: { streetId }
      }));
    });
  });
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
  initStreetLinks();
});
