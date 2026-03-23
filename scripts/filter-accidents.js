#!/usr/bin/env node

// filter-accidents.js
// Filters accidents.geojson to only include accidents that fall within
// a school zone (500m around school entrance) — from zones.geojson.
//
// This keeps the dataset focused on school-relevant incidents and reduces
// the data shipped to the browser.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, '..', 'data');

function main() {
  console.log('Loading data...');
  const zones = JSON.parse(readFileSync(join(DATA, 'zones.geojson'), 'utf-8'));
  const accidents = JSON.parse(readFileSync(join(DATA, 'accidents.geojson'), 'utf-8'));

  console.log(`  Zones: ${zones.features.length}`);
  console.log(`  Accidents: ${accidents.features.length}`);

  // Simple point-in-polygon check using ray casting
  function pointInPolygon(point, polygon) {
    const [px, py] = point;
    const coords = polygon.geometry.type === 'Polygon'
      ? polygon.geometry.coordinates
      : polygon.geometry.coordinates; // MultiPolygon — check all rings

    if (polygon.geometry.type === 'MultiPolygon') {
      for (const poly of coords) {
        if (raycast(px, py, poly[0])) return true;
      }
      return false;
    }

    return raycast(px, py, coords[0]);
  }

  function raycast(px, py, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];
      if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  // Filter accidents to 500m school zones
  console.log('\nFiltering accidents to school zones (500m)...');
  const filtered = [];

  for (const accident of accidents.features) {
    const coords = accident.geometry.coordinates;

    for (const zone of zones.features) {
      if (pointInPolygon(coords, zone)) {
        accident.properties.area = 'schoolzone';
        filtered.push(accident);
        break;
      }
    }
  }

  console.log(`  In school zone (500m): ${filtered.length}`);
  console.log(`  Excluded: ${accidents.features.length - filtered.length}`);

  const output = {
    ...accidents,
    metadata: {
      ...accidents.metadata,
      featureCount: filtered.length,
      filterNote: `Filtered to accidents within 500m school zones (${filtered.length}). Original: ${accidents.features.length} accidents.`,
    },
    features: filtered,
  };

  writeFileSync(join(DATA, 'accidents-filtered.geojson'), JSON.stringify(output, null, 2), 'utf-8');
  console.log(`\nDone → accidents-filtered.geojson`);
}

main();
