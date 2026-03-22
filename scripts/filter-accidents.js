#!/usr/bin/env node

// filter-accidents.js
// Filters accidents.geojson to only include accidents that fall within:
// 1. A school zone (100m around school entrance) — from zones.geojson
// 2. A school route area (500m around school) — generated here
//
// This keeps the dataset focused on school-relevant incidents and reduces
// the data shipped to the browser.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import buffer from '@turf/buffer';
import { point, featureCollection } from '@turf/helpers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, '..', 'data');

const ROUTE_RADIUS_KM = 0.5; // 500m school route buffer

function main() {
  console.log('Loading data...');
  const schools = JSON.parse(readFileSync(join(DATA, 'schools.geojson'), 'utf-8'));
  const zones = JSON.parse(readFileSync(join(DATA, 'zones.geojson'), 'utf-8'));
  const accidents = JSON.parse(readFileSync(join(DATA, 'accidents.geojson'), 'utf-8'));

  console.log(`  Schools: ${schools.features.length}`);
  console.log(`  Zones: ${zones.features.length}`);
  console.log(`  Accidents: ${accidents.features.length}`);

  // Generate 500m route buffers around each school
  console.log('\nGenerating 500m school route buffers...');
  const routeBuffers = [];
  for (const school of schools.features) {
    const coords = school.geometry.coordinates;
    const buf = buffer.default
      ? buffer.default(point(coords), ROUTE_RADIUS_KM, { units: 'kilometers' })
      : buffer(point(coords), ROUTE_RADIUS_KM, { units: 'kilometers' });
    buf.properties = { school: school.properties.name, type: 'schoolroute' };
    routeBuffers.push(buf);
  }

  // Write route buffers as a separate GeoJSON for map display
  const routesGeojson = featureCollection
    ? featureCollection(routeBuffers)
    : { type: 'FeatureCollection', features: routeBuffers };
  writeFileSync(join(DATA, 'routes.geojson'), JSON.stringify(routesGeojson, null, 2), 'utf-8');
  console.log(`  Generated ${routeBuffers.length} route buffers → routes.geojson`);

  // Combine all filter polygons (100m zones + 500m routes)
  const allPolygons = [...zones.features, ...routeBuffers];

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

  // Filter accidents
  console.log('\nFiltering accidents...');
  const filtered = [];
  let inZone = 0;
  let inRoute = 0;

  for (const accident of accidents.features) {
    const coords = accident.geometry.coordinates;

    // Check 100m zones first (faster, smaller set)
    let matched = false;
    for (const zone of zones.features) {
      if (pointInPolygon(coords, zone)) {
        accident.properties.area = 'schoolzone';
        matched = true;
        inZone++;
        break;
      }
    }

    // If not in zone, check 500m route buffers
    if (!matched) {
      for (const route of routeBuffers) {
        if (pointInPolygon(coords, route)) {
          accident.properties.area = 'schoolroute';
          matched = true;
          inRoute++;
          break;
        }
      }
    }

    if (matched) {
      filtered.push(accident);
    }
  }

  console.log(`  In school zone (100m): ${inZone}`);
  console.log(`  In school route (500m): ${inRoute}`);
  console.log(`  Total filtered: ${filtered.length} / ${accidents.features.length}`);
  console.log(`  Excluded: ${accidents.features.length - filtered.length}`);

  // Overwrite accidents.geojson with filtered data
  // Keep original metadata but update counts
  const output = {
    ...accidents,
    metadata: {
      ...accidents.metadata,
      featureCount: filtered.length,
      filterNote: `Filtered to accidents within 100m school zones (${inZone}) and 500m school routes (${inRoute}). Original: ${accidents.features.length} accidents.`,
    },
    features: filtered,
  };

  writeFileSync(join(DATA, 'accidents-filtered.geojson'), JSON.stringify(output, null, 2), 'utf-8');
  console.log(`\nDone → accidents-filtered.geojson`);
}

main();
