#!/usr/bin/env node

// fetch-wijken.js
// Fetches the 8 Alkmaar wijk (neighborhood) boundaries from CBS/PDOK WFS,
// calculates centroids, and writes data/wijken.geojson.

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import centerOfMass from '@turf/center-of-mass';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, '..', 'data');

// The 8 Alkmaar wijken (CBS codes with WK prefix)
const WIJK_CODES = [
  'WK036101', 'WK036102', 'WK036103', 'WK036104',
  'WK036105', 'WK036106', 'WK036107', 'WK036108',
];

const WFS_BASE = 'https://service.pdok.nl/cbs/wijkenbuurten/2024/wfs/v1_0';

async function fetchWijken() {
  console.log('Fetching Alkmaar wijk boundaries from CBS/PDOK...');

  // WFS CQL_FILTER doesn't work on this endpoint; use XML filter instead
  const xmlFilter = '<Filter><PropertyIsEqualTo><PropertyName>gemeentenaam</PropertyName><Literal>Alkmaar</Literal></PropertyIsEqualTo></Filter>';

  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeName: 'wijkenbuurten:wijken',
    outputFormat: 'application/json',
    srsName: 'EPSG:4326',
    count: '50',
    filter: xmlFilter,
  });

  const url = `${WFS_BASE}?${params}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`WFS HTTP ${res.status}: ${await res.text()}`);

  const data = await res.json();
  console.log(`  Received ${data.features.length} Alkmaar features`);

  // Filter to our 8 wijken
  const filtered = data.features.filter(f => WIJK_CODES.includes(f.properties.wijkcode));
  console.log(`  Matched ${filtered.length} of ${WIJK_CODES.length} expected wijken`);

  // Build output with centroids
  const features = filtered.map(f => {
    const centroid = centerOfMass(f);
    const [lon, lat] = centroid.geometry.coordinates;

    return {
      type: 'Feature',
      geometry: f.geometry,
      properties: {
        wijkCode: f.properties.wijkcode,
        wijkNaam: f.properties.wijknaam,
        centroid: [lon, lat],
        aantalInwoners: f.properties.aantalInwoners,
      },
    };
  });

  for (const f of features) {
    console.log(`  ${f.properties.wijkNaam} (${f.properties.wijkCode}): centroid [${f.properties.centroid[0].toFixed(4)}, ${f.properties.centroid[1].toFixed(4)}], ${f.properties.aantalInwoners} inwoners`);
  }

  const output = {
    type: 'FeatureCollection',
    metadata: {
      generated: new Date().toISOString(),
      source: 'CBS Wijken en Buurten 2024 via PDOK WFS',
      wijkCount: features.length,
    },
    features,
  };

  const outPath = join(DATA, 'wijken.geojson');
  writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`\nDone → ${outPath}`);
}

fetchWijken().catch(err => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
