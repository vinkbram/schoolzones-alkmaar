#!/usr/bin/env node

// fetch-speed-limits.js
// Queries the Rijkswaterstaat WKD (Wegkenmerkendatabase) FeatureServer
// for speed limits on road segments within 500m of each school.
// Enriches schools.geojson with maxSpeed property.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, '..', 'data');

// Rijkswaterstaat WKD Maximum Snelheden FeatureServer
const WKD_URL = 'https://geo.rijkswaterstaat.nl/arcgis/rest/services/GDR/maximum_snelheden_wegen/FeatureServer/5/query';

// Buffer in meters around each school to search for roads
const BUFFER_M = 100;

async function querySpeedLimits(lon, lat) {
  // The FeatureServer expects geometry in WGS84 (wkid 4326)
  // We use a point + distance (in meters) for the spatial query
  const params = new URLSearchParams({
    geometry: `${lon},${lat}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    distance: BUFFER_M,
    units: 'esriSRUnit_Meter',
    outFields: 'maxshd,stt_naam,wegbehsrt',
    returnGeometry: 'false',
    f: 'json',
  });

  const url = `${WKD_URL}?${params}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const data = await res.json();

  if (data.error) {
    throw new Error(`ArcGIS error: ${JSON.stringify(data.error)}`);
  }

  return data.features || [];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('Loading schools...');
  const schools = JSON.parse(readFileSync(join(DATA, 'schools.geojson'), 'utf-8'));
  console.log(`  ${schools.features.length} schools\n`);

  let updated = 0;

  for (const school of schools.features) {
    const [lon, lat] = school.geometry.coordinates;
    const name = school.properties.name;

    try {
      const features = await querySpeedLimits(lon, lat);

      // Extract unique speed limits from nearby road segments
      // maxshd = maximum speed daytime (overdag), string field
      const speeds = features
        .map(f => parseInt(f.attributes.maxshd, 10))
        .filter(s => !isNaN(s) && s > 0);

      if (speeds.length > 0) {
        const maxSpeed = Math.max(...speeds);
        const minSpeed = Math.min(...speeds);
        const uniqueSpeeds = [...new Set(speeds)].sort((a, b) => a - b);

        school.properties.maxSpeed = maxSpeed;
        school.properties.minSpeed = minSpeed;
        school.properties.speedLimits = uniqueSpeeds;
        school.properties.roadSegments = features.length;

        const speedStr = uniqueSpeeds.map(s => `${s} km/u`).join(', ');
        console.log(`  ${name}: ${speedStr} (${features.length} segments)`);
        updated++;
      } else {
        console.log(`  ${name}: no speed data found`);
        school.properties.maxSpeed = null;
        school.properties.speedLimits = [];
        school.properties.roadSegments = 0;
      }
    } catch (err) {
      console.error(`  ${name}: ERROR - ${err.message}`);
      school.properties.maxSpeed = null;
      school.properties.speedLimits = [];
      school.properties.roadSegments = 0;
    }

    // Rate limit: small delay between requests
    await sleep(200);
  }

  console.log(`\nUpdated ${updated} / ${schools.features.length} schools with speed data`);

  writeFileSync(join(DATA, 'schools.geojson'), JSON.stringify(schools, null, 2), 'utf-8');
  console.log('Done → schools.geojson');
}

main();
