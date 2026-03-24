// main.js — Hero counter, ranking table, knelpunten, social sharing

const DATA_BASE = './data';

// --- Day Counter ---
async function initCounter() {
  const hero = document.getElementById('hero');
  try {
    const res = await fetch(`${DATA_BASE}/accidents-filtered.geojson`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Only show hero if we have at least one cron-detected accident
    // (where firstSeen differs from the backfilled date field)
    const hasCronDetected = data.features.some(f =>
      f.properties.firstSeen && f.properties.date && f.properties.firstSeen !== f.properties.date
    );

    if (!hasCronDetected) {
      hero.style.display = 'none';
      return;
    }

    const dates = data.features
      .map(f => f.properties.firstSeen || f.properties.date)
      .filter(Boolean)
      .sort()
      .reverse();

    if (dates.length === 0) {
      hero.style.display = 'none';
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
    hero.style.display = 'none';
  }
}

// --- CROW Labels ---
const CROW_LABELS = {
  scheiding: 'Geen scheiding fiets/auto',
  breedte: 'Te smal fietspad',
  verharding: 'Slechte verharding',
  verlichting: 'Geen verlichting',
  snelheid: 'Hoge snelheid',
};

// Natural language suggestions per CROW issue
const CROW_SUGGESTIONS = {
  scheiding: 'een vrijliggend fietspad aanleggen',
  breedte: 'het fietspad verbreden',
  verharding: 'de verharding verbeteren',
  verlichting: 'straatverlichting plaatsen',
  snelheid: 'de maximumsnelheid verlagen',
};

// --- Shared data loading ---
let _routesData = null;
let _schoolsData = null;

async function loadRoutes() {
  if (_routesData) return _routesData;
  try {
    const res = await fetch(`${DATA_BASE}/school-routes.geojson`);
    if (res.ok) _routesData = await res.json();
  } catch (e) { /* non-blocking */ }
  return _routesData || { features: [] };
}

async function loadSchools() {
  if (_schoolsData) return _schoolsData;
  try {
    const res = await fetch(`${DATA_BASE}/schools.geojson`);
    if (res.ok) _schoolsData = await res.json();
  } catch (e) { /* non-blocking */ }
  return _schoolsData || { features: [] };
}

// Quick distance in degrees (~100m ≈ 0.001)
function quickDist(lon1, lat1, lon2, lat2) {
  const dLon = lon1 - lon2, dLat = lat1 - lat2;
  return Math.sqrt(dLon * dLon + dLat * dLat);
}

// Find the worst segment for each school, including segments within 100m of the school
function buildSchoolWorstSegments(routes, schools) {
  const PROXIMITY_DEG = 0.001; // ~100m
  const schoolWorst = {};

  // Build school coordinate lookup
  const schoolCoords = {};
  for (const s of schools.features) {
    schoolCoords[s.properties.name] = s.geometry.coordinates;
  }

  for (const f of routes.features) {
    const composite = f.properties.composite || 3;
    const streetName = f.properties.streetName;
    const scores = f.properties.scores || {};
    const accidentCount = f.properties.accidentCount || 0;
    const accidentScore = f.properties.accidentScore || 3;

    // Collect reasons
    const reasons = [];
    const issueKeys = [];
    for (const [key, val] of Object.entries(scores)) {
      if (val < 2) { reasons.push(CROW_LABELS[key] || key); issueKeys.push(key); }
    }
    if (accidentScore < 2) reasons.push(`${accidentCount} ongevallen`);

    const segData = { street: streetName, composite, reasons, issueKeys, accidentCount };

    // 1) Attribute via route's schools property
    const routeSchools = f.properties.schools || [];
    for (const name of routeSchools) {
      if (!schoolWorst[name] || composite < schoolWorst[name].composite) {
        schoolWorst[name] = segData;
      }
    }

    // 2) Also attribute to any school within 100m of the segment
    // Check segment coordinates against all school positions
    const segCoords = f.geometry.type === 'Polygon'
      ? f.geometry.coordinates[0]
      : f.geometry.coordinates;

    for (const [schoolName, [sLon, sLat]] of Object.entries(schoolCoords)) {
      for (const c of segCoords) {
        if (quickDist(c[0], c[1], sLon, sLat) < PROXIMITY_DEG) {
          if (!schoolWorst[schoolName] || composite < schoolWorst[schoolName].composite) {
            schoolWorst[schoolName] = segData;
          }
          break;
        }
      }
    }
  }

  return schoolWorst;
}

// --- Ranking Table ---
async function initRanking() {
  try {
    const [schools, routes] = await Promise.all([loadSchools(), loadRoutes()]);

    const [accidentsRes, zonesRes] = await Promise.all([
      fetch(`${DATA_BASE}/accidents-filtered.geojson`),
      fetch(`${DATA_BASE}/zones.geojson`),
    ]);

    if (!accidentsRes.ok || !zonesRes.ok) throw new Error('Failed to load data');

    const accidents = await accidentsRes.json();
    const zones = await zonesRes.json();

    const schoolWorst = buildSchoolWorstSegments(routes, schools);
    const rankings = buildRankings(schools, accidents, zones, schoolWorst);
    renderTable(rankings);
  } catch (err) {
    console.error('Ranking table failed:', err);
    document.getElementById('ranking-tbody').innerHTML =
      '<tr><td colspan="5" style="text-align:center;padding:2rem;color:#757575;">Data kon niet geladen worden.</td></tr>';
  }
}

function buildRankings(schools, accidents, zones, schoolWorst) {
  const rankings = [];

  for (const school of schools.features) {
    const schoolName = school.properties.name;
    const studentCount = school.properties.studentCount || 0;

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

    rankings.push({
      name: schoolName,
      studentCount,
      accidentCount,
      worstSegment: schoolWorst[schoolName] || null,
      coordinates: school.geometry.coordinates,
    });
  }

  // Sort by accident count descending
  rankings.sort((a, b) => b.accidentCount - a.accidentCount);
  return rankings;
}

const TOP_VISIBLE = 10;

function renderTable(rankings) {
  const tbody = document.getElementById('ranking-tbody');
  tbody.innerHTML = '';

  const formatter = new Intl.NumberFormat('nl-NL');

  rankings.forEach((school, i) => {
    const row = document.createElement('tr');

    if (i >= TOP_VISIBLE) {
      row.classList.add('ranking-table__row--hidden');
    }

    const riskClass = school.accidentCount >= 5 ? 'risk-high'
      : school.accidentCount >= 2 ? 'risk-medium'
      : '';

    row.setAttribute('tabindex', '0');
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', `Toon ${school.name} op kaart`);

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

  if (rankings.length > TOP_VISIBLE) {
    const btn = document.getElementById('show-all-schools');
    if (btn) {
      btn.style.display = '';
      btn.textContent = `Toon alle ${rankings.length} scholen`;
      btn.addEventListener('click', () => {
        document.querySelectorAll('.ranking-table__row--hidden').forEach(r => {
          r.classList.remove('ranking-table__row--hidden');
        });
        btn.style.display = 'none';
      });
    }
  }
}

// --- Knelpunten Section (natural language, top 5) ---
async function initKnelpunten() {
  try {
    const [routes, schools] = await Promise.all([loadRoutes(), loadSchools()]);

    // Aggregate worst score per street, collecting all issues and schools
    const streetData = new Map();

    for (const f of routes.features) {
      const name = f.properties.streetName;
      if (!name) continue;

      const composite = f.properties.composite || 3;
      const scores = f.properties.scores || {};
      const accidentCount = f.properties.accidentCount || 0;
      const accidentScore = f.properties.accidentScore || 3;
      const routeSchools = f.properties.schools || [];

      const issues = [];
      for (const [key, val] of Object.entries(scores)) {
        if (val < 2) issues.push(key);
      }
      const hasAccidentIssue = accidentScore < 2;

      const existing = streetData.get(name);
      if (!existing || composite < existing.composite) {
        streetData.set(name, {
          composite,
          accidentCount,
          schools: [...new Set(routeSchools)],
          issues,
          hasAccidentIssue,
        });
      } else {
        for (const s of routeSchools) {
          if (!existing.schools.includes(s)) existing.schools.push(s);
        }
        existing.accidentCount = Math.max(existing.accidentCount, accidentCount);
      }
    }

    const sorted = [...streetData.entries()]
      .sort((a, b) => a[1].composite - b[1].composite)
      .slice(0, 5);

    const container = document.getElementById('knelpunten-list');
    if (!container || sorted.length === 0) return;

    container.innerHTML = sorted.map(([street, data]) => {
      // Build natural language description of what needs to happen
      const suggestions = data.issues
        .map(key => CROW_SUGGESTIONS[key])
        .filter(Boolean);

      let description = '';

      if (data.hasAccidentIssue) {
        description += `Op de ${escapeHtml(street)} zijn ${data.accidentCount} verkeersongelukken geregistreerd sinds 2021. `;
      }

      if (suggestions.length > 0) {
        const lastSuggestion = suggestions.pop();
        const suggestionText = suggestions.length > 0
          ? suggestions.join(', ') + ' en ' + lastSuggestion
          : lastSuggestion;
        description += `Hier is het nodig om ${suggestionText}.`;
      } else if (data.hasAccidentIssue) {
        description += 'De oorzaak verdient nader onderzoek.';
      }

      const schoolList = data.schools.slice(0, 4).map(s => escapeHtml(s)).join(', ');
      const moreSchools = data.schools.length > 4 ? ` en ${data.schools.length - 4} andere` : '';

      const severityClass = data.composite < 1 ? 'knelpunt--critical' : data.composite < 2 ? 'knelpunt--danger' : 'knelpunt--warn';

      return `
        <div class="knelpunt ${severityClass}">
          <div class="knelpunt__content">
            <h3 class="knelpunt__street">${escapeHtml(street)}</h3>
            <p class="knelpunt__description">${description}</p>
            <p class="knelpunt__schools">Schoolroute voor: ${schoolList}${moreSchools}</p>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Knelpunten failed:', err);
  }
}

// --- Social Sharing ---
function initSharing() {
  const pageUrl = window.location.href;
  const shareText = 'Kinderen moeten veilig naar school kunnen fietsen. Bekijk de data over schoolroutes in Alkmaar.';

  const waBtn = document.getElementById('share-whatsapp');
  if (waBtn) {
    waBtn.href = `https://wa.me/?text=${encodeURIComponent(shareText + ' ' + pageUrl)}`;
    waBtn.target = '_blank';
    waBtn.rel = 'noopener noreferrer';
  }

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
  initKnelpunten();
  initSharing();
});
