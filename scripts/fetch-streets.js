#!/usr/bin/env node

// Fetch real street geometries from OpenStreetMap Overpass API
// Queries each street individually to avoid timeout/size issues

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OVERPASS_API = 'https://overpass-api.de/api/interpreter';

// Alkmaar bounding box
const BBOX = '52.61,4.71,52.68,4.81';

const STREETS = [
  {
    id: 'bergerweg',
    names: ['Bergerweg', 'Geestersingel'],
    displayName: 'Bergerweg / Geestersingel',
    currentLimit: 50,
    note: 'Drukke doorgaande route langs meerdere scholen',
  },
  {
    id: 'terborchlaan',
    names: ['Terborchlaan', 'Aert de Gelderlaan'],
    displayName: 'Terborchlaan / Aert de Gelderlaan',
    currentLimit: 50,
    note: 'Brede weg met hoge rijsnelheden nabij basisscholen',
  },
  {
    id: 'schinkelwaard',
    names: ['Schinkelwaard'],
    displayName: 'Schinkelwaard',
    currentLimit: 50,
    note: 'Doorgaande weg door woonwijk met scholen',
  },
  {
    id: 'vondelstraat',
    names: ['Vondelstraat'],
    displayName: 'Vondelstraat',
    currentLimit: 30,
    note: '30 km/u maar 50 km/u inrichting — automobilisten rijden structureel te hard',
  },
  {
    id: 'westerweg',
    names: ['Westerweg'],
    displayName: 'Westerweg',
    currentLimit: 50,
    note: 'Al in uitvoering — positief voorbeeld',
  },
];

async function queryOverpass(streetNames, retries = 3) {
  // Only fetch highway ways (not footpaths, cycleways etc.)
  const nameFilters = streetNames
    .map(n => `way["highway"]["name"="${n}"](${BBOX});`)
    .join('\n  ');

  const query = `[out:json][timeout:30];(\n  ${nameFilters}\n);\nout geom;`;

  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch(OVERPASS_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(query),
    });

    if (res.status === 429) {
      const wait = 10000 * (attempt + 1);
      console.log(`  Rate limited, waiting ${wait / 1000}s...`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }

    if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
    return res.json();
  }
  throw new Error('Overpass rate limit exceeded after retries');
}

// Merge connected way segments into continuous lines
function mergeWays(elements) {
  if (elements.length === 0) return [];

  const segments = elements.map(e => e.geometry.map(p => [p.lon, p.lat]));

  // Build node-connectivity graph using exact coordinate matching
  // OSM ways share exact node coordinates at junctions
  const coordKey = (c) => `${c[0]},${c[1]}`;

  const lines = [...segments.map(s => [...s])]; // deep copy
  let changed = true;

  while (changed) {
    changed = false;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]) continue;
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j]) continue;

        const iStart = coordKey(lines[i][0]);
        const iEnd = coordKey(lines[i][lines[i].length - 1]);
        const jStart = coordKey(lines[j][0]);
        const jEnd = coordKey(lines[j][lines[j].length - 1]);

        if (iEnd === jStart) {
          lines[i] = [...lines[i], ...lines[j].slice(1)];
          lines[j] = null;
          changed = true;
        } else if (iEnd === jEnd) {
          lines[i] = [...lines[i], ...[...lines[j]].reverse().slice(1)];
          lines[j] = null;
          changed = true;
        } else if (iStart === jEnd) {
          lines[i] = [...lines[j], ...lines[i].slice(1)];
          lines[j] = null;
          changed = true;
        } else if (iStart === jStart) {
          lines[i] = [...[...lines[j]].reverse(), ...lines[i].slice(1)];
          lines[j] = null;
          changed = true;
        }
      }
    }
  }

  return lines.filter(Boolean);
}

async function main() {
  const features = [];

  for (const street of STREETS) {
    console.log(`Fetching: ${street.displayName} (${street.names.join(', ')})...`);

    try {
      const data = await queryOverpass(street.names);
      const ways = data.elements.filter(e => e.type === 'way');
      console.log(`  Found ${ways.length} way segments`);

      if (ways.length === 0) {
        console.warn(`  WARNING: No ways found for ${street.displayName}`);
        continue;
      }

      const lines = mergeWays(ways);
      console.log(`  Merged into ${lines.length} line(s)`);

      const geometry = lines.length === 1
        ? { type: 'LineString', coordinates: lines[0] }
        : { type: 'MultiLineString', coordinates: lines };

      features.push({
        type: 'Feature',
        geometry,
        properties: {
          id: street.id,
          name: street.displayName,
          currentLimit: street.currentLimit,
          note: street.note,
        },
      });

      // 5s between requests to avoid rate limiting
      await new Promise(r => setTimeout(r, 5000));
    } catch (err) {
      console.error(`  ERROR: ${err.message}`);
    }
  }

  const geojson = { type: 'FeatureCollection', features };
  const outPath = join(__dirname, '..', 'data', 'priority-streets.geojson');
  writeFileSync(outPath, JSON.stringify(geojson, null, 2), 'utf-8');
  console.log(`\nDone: ${features.length} streets → ${outPath}`);
}

main();
