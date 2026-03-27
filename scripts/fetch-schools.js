#!/usr/bin/env node

// fetch-schools.js
// Fetches all schools in gemeente Alkmaar from DUO open data,
// gets student counts, geocodes addresses via PDOK Locatieserver,
// and writes data/schools.geojson.
//
// Includes ALL vestigingen (locations) — a school with multiple
// buildings gets multiple entries, each with its own coordinates.

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT = join(__dirname, '..', 'data', 'schools.geojson');

const DUO_PO_ADDRESSES = 'https://duo.nl/open_onderwijsdata/images/02.-alle-schoolvestigingen-basisonderwijs.csv';
const DUO_VO_ADDRESSES = 'https://duo.nl/open_onderwijsdata/images/02.-alle-vestigingen-vo.csv';
const DUO_PO_STUDENTS = 'https://duo.nl/open_onderwijsdata/images/01.-leerlingen-po-soort-po-cluster-leeftijd-2025-2026.csv';
const DUO_VO_STUDENTS = 'https://duo.nl/open_onderwijsdata/images/01.-leerlingen-vo-per-vestiging-naar-onderwijstype-2025.csv';
const PDOK_SEARCH = 'https://api.pdok.nl/bzk/locatieserver/search/v3_1/free';

const GEMEENTE = 'ALKMAAR';

function parseCSV(text) {
  const lines = text.split('\n').filter(l => l.trim());
  const strip = s => s.replace(/^"+|"+$/g, '').trim();
  const header = lines[0].split(';').map(strip);
  return lines.slice(1).map(line => {
    const cols = line.split(';').map(strip);
    const row = {};
    header.forEach((h, i) => row[h] = cols[i] || '');
    return row;
  });
}

// Short display name from official DUO name
function shortName(official) {
  return official
    .replace(/^Openbare Basisschool\s+/i, 'OBS ')
    .replace(/^Rooms\s+Katholieke?\s+Basisschool\s+/i, 'RK BS ')
    .replace(/^Rooms\s+katholieke?\s+Basisschool\s+/i, 'RK BS ')
    .replace(/^Interconfessionele\s+basisschool\s+/i, '')
    .replace(/^Kindcentrum\s+/i, 'KC ')
    .replace(/\s+Christelijke\s+Scholengemeenschap\s+voor\s+.*$/i, '')
    .replace(/,?\s*SGM\s+voor\s+.*$/i, '')
    .replace(/\s+Scholengemeenschap\s+voor\s+.*$/i, '')
    .replace(/\s+voor\s+vwo\s+havo\s+mavo\s+en\s+vbo$/i, '')
    .replace(/,?\s*school\s+voor\s+praktijkonderwijs$/i, ' (praktijkonderwijs)')
    .replace(/\s+Alkmaar$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function geocode(address) {
  const url = `${PDOK_SEARCH}?q=${encodeURIComponent(address)}&rows=1`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.response?.docs?.length > 0) {
    const doc = data.response.docs[0];
    const match = doc.centroide_ll?.match(/POINT\(([\d.]+)\s+([\d.]+)\)/);
    if (match) {
      return [parseFloat(match[1]), parseFloat(match[2])];
    }
  }
  return null;
}

async function main() {
  console.log('Fetching DUO data...');

  const [poAddrText, voAddrText, poStudText, voStudText] = await Promise.all([
    fetch(DUO_PO_ADDRESSES).then(r => r.text()),
    fetch(DUO_VO_ADDRESSES).then(r => r.text()),
    fetch(DUO_PO_STUDENTS).then(r => r.text()),
    fetch(DUO_VO_STUDENTS).then(r => r.text()),
  ]);

  const poAddresses = parseCSV(poAddrText).filter(r => r.GEMEENTENAAM === GEMEENTE);
  const voAddresses = parseCSV(voAddrText).filter(r => r.GEMEENTENAAM === GEMEENTE);
  const poStudents = parseCSV(poStudText);
  const voStudents = parseCSV(voStudText);

  console.log(`  PO schools: ${poAddresses.length}`);
  console.log(`  VO vestigingen: ${voAddresses.length}`);

  // Build student count lookup for PO (by INSTELLINGSCODE)
  // PO CSV has age columns, sum them per school
  const poStudentCounts = {};
  const ageColumns = ['LEEFTIJD_4', 'LEEFTIJD_5', 'LEEFTIJD_6', 'LEEFTIJD_7',
    'LEEFTIJD_8', 'LEEFTIJD_9', 'LEEFTIJD_10', 'LEEFTIJD_11', 'LEEFTIJD_12'];
  for (const row of poStudents) {
    const code = row.INSTELLINGSCODE;
    const soort = row.SOORT_PO;
    if (!code || soort !== 'Bo') continue; // Only count regular basisonderwijs
    let count = 0;
    for (const col of ageColumns) {
      const val = row[col];
      if (val && val !== '<5') count += parseInt(val) || 0;
      else if (val === '<5') count += 3; // Estimate
    }
    poStudentCounts[code] = (poStudentCounts[code] || 0) + count;
  }

  // Build student count lookup for VO
  // Student CSV uses short VEST code (e.g. "00"), address CSV uses full code (e.g. "01XF00")
  // Construct full key as INSTELLINGSCODE + VESTIGINGSCODE
  const voStudentCounts = {};
  const yearCols = [
    'LEER- OF VERBLIJFSJAAR 1 - MAN', 'LEER- OF VERBLIJFSJAAR 1 - VROUW',
    'LEER- OF VERBLIJFSJAAR 2 - MAN', 'LEER- OF VERBLIJFSJAAR 2 - VROUW',
    'LEER- OF VERBLIJFSJAAR 3 - MAN', 'LEER- OF VERBLIJFSJAAR 3 - VROUW',
    'LEER- OF VERBLIJFSJAAR 4 - MAN', 'LEER- OF VERBLIJFSJAAR 4 - VROUW',
    'LEER- OF VERBLIJFSJAAR 5 - MAN', 'LEER- OF VERBLIJFSJAAR 5 - VROUW',
    'LEER- OF VERBLIJFSJAAR 6 - MAN', 'LEER- OF VERBLIJFSJAAR 6 - VROUW',
  ];
  for (const row of voStudents) {
    const inst = row.INSTELLINGSCODE;
    const vest = row.VESTIGINGSCODE;
    if (!inst || !vest) continue;
    const fullCode = inst + vest; // e.g. "01XF" + "00" = "01XF00"
    let count = 0;
    for (const col of yearCols) {
      const val = row[col]?.trim();
      if (val && val !== '<5') count += parseInt(val) || 0;
      else if (val === '<5') count += 3;
    }
    voStudentCounts[fullCode] = (voStudentCounts[fullCode] || 0) + count;
  }

  // Collect all schools to geocode
  const schools = [];

  // PO: deduplicate vestigingen at same address
  const seenPOAddresses = new Set();
  for (const row of poAddresses) {
    const addrKey = `${row.STRAATNAAM} ${row['HUISNUMMER-TOEVOEGING']}`;
    if (seenPOAddresses.has(addrKey)) {
      console.log(`  Skipping duplicate PO vestiging: ${row.VESTIGINGSNAAM || row.INSTELLINGSNAAM} at ${addrKey}`);
      continue;
    }
    seenPOAddresses.add(addrKey);

    const vestigingsnaam = row.VESTIGINGSNAAM || row.INSTELLINGSNAAM;
    const address = `${row.STRAATNAAM} ${row['HUISNUMMER-TOEVOEGING']}, ${row.POSTCODE} ${row.PLAATSNAAM}`;
    schools.push({
      name: shortName(vestigingsnaam),
      officialName: vestigingsnaam,
      type: 'basisschool',
      address,
      studentCount: poStudentCounts[row.INSTELLINGSCODE] || 0,
      code: row.INSTELLINGSCODE,
      plaats: row.PLAATSNAAM,
    });
  }

  // VO: deduplicate vestigingen at same address
  const seenVOAddresses = new Set();
  for (const row of voAddresses) {
    const addrKey = `${row.STRAATNAAM} ${row['HUISNUMMER-TOEVOEGING']}`;
    if (seenVOAddresses.has(addrKey)) {
      console.log(`  Skipping duplicate VO vestiging: ${row.VESTIGINGSNAAM} at ${addrKey}`);
      continue;
    }
    seenVOAddresses.add(addrKey);

    const address = `${row.STRAATNAAM} ${row['HUISNUMMER-TOEVOEGING']}, ${row.POSTCODE} ${row.PLAATSNAAM}`;
    let displayName = shortName(row.VESTIGINGSNAAM);

    // Add vestiging label if it's a secondary location
    if (row.VESTIGINGSNAAM.includes('vestiging') || row.VESTIGINGSNAAM.includes('vest.')) {
      const vestMatch = row.VESTIGINGSNAAM.match(/vestiging\s+(.+)/i) || row.VESTIGINGSNAAM.match(/vest\.\s+(.+)/i);
      if (vestMatch) {
        displayName = vestMatch[1].trim();
      }
    }

    schools.push({
      name: displayName,
      officialName: row.VESTIGINGSNAAM,
      type: 'middelbaar',
      address,
      studentCount: voStudentCounts[row.VESTIGINGSCODE] || 0,
      code: row.VESTIGINGSCODE,
      plaats: row.PLAATSNAAM,
    });
  }

  // Disambiguate duplicate display names by appending street
  const nameCounts = {};
  for (const s of schools) nameCounts[s.name] = (nameCounts[s.name] || 0) + 1;
  for (const s of schools) {
    if (nameCounts[s.name] > 1) {
      const street = s.address.split(',')[0].replace(/\s+\d.*$/, '').trim();
      s.name = `${s.name} (${street})`;
    }
  }

  console.log(`\nTotal schools to geocode: ${schools.length}`);

  // Geocode all schools via PDOK
  console.log('Geocoding via PDOK...');
  const features = [];

  for (let i = 0; i < schools.length; i++) {
    const school = schools[i];
    const coords = await geocode(school.address);

    if (!coords) {
      console.warn(`  FAILED: ${school.name} — ${school.address}`);
      continue;
    }

    console.log(`  [${i + 1}/${schools.length}] ${school.name} — ${school.plaats} → [${coords[0].toFixed(4)}, ${coords[1].toFixed(4)}]`);

    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: coords },
      properties: {
        name: school.name,
        type: school.type,
        studentCount: school.studentCount,
        plaats: school.plaats,
        entrances: [coords],
      },
    });

    // Rate limit PDOK
    if (i % 10 === 9) await new Promise(r => setTimeout(r, 500));
  }

  const geojson = {
    type: 'FeatureCollection',
    metadata: {
      source: 'DUO open onderwijsdata + PDOK geocoding',
      lastUpdated: new Date().toISOString().split('T')[0],
      schoolCount: features.length,
    },
    features,
  };

  writeFileSync(OUTPUT, JSON.stringify(geojson, null, 2), 'utf-8');
  console.log(`\nDone: ${features.length} schools → ${OUTPUT}`);
}

main().catch(err => {
  console.error('FAILED:', err);
  process.exit(1);
});
