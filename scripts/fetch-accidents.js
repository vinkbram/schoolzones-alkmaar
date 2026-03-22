#!/usr/bin/env node

// fetch-accidents.js
// Fetches STAR traffic accident data for Alkmaar from the open data API,
// filters to relevant date range, transforms to GeoJSON, writes data/accidents.geojson.
//
// TODO: Update API_URL once STAR endpoint is confirmed (see backlog item 2.1).
// Currently uses a placeholder — this script will fail gracefully until configured.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, '..', 'data', 'accidents.geojson');

// Alkmaar bounding box (approximate)
const ALKMAAR_BBOX = {
  minLon: 4.70,
  maxLon: 4.80,
  minLat: 52.61,
  maxLat: 52.66,
};

// Date range
const START_DATE = '2021-01-01';

// TODO: Replace with actual STAR/BRON API endpoint once confirmed
const API_URL = null; // Will be set after API research

async function fetchAccidents() {
  if (!API_URL) {
    console.error('ERROR: API_URL is not configured. Run backlog item 2.1 first.');
    console.error('Keeping existing accidents.geojson unchanged.');
    process.exit(0); // Exit 0 so the workflow doesn't fail — existing data stays
  }

  try {
    console.log(`Fetching accidents from ${API_URL}...`);

    const response = await fetch(API_URL);
    if (!response.ok) {
      throw new Error(`API returned HTTP ${response.status}`);
    }

    const rawData = await response.json();

    // Transform to GeoJSON
    // TODO: Adapt this transformation to the actual API response format
    const features = rawData
      .filter(record => {
        const lon = parseFloat(record.longitude);
        const lat = parseFloat(record.latitude);
        return (
          lon >= ALKMAAR_BBOX.minLon && lon <= ALKMAAR_BBOX.maxLon &&
          lat >= ALKMAAR_BBOX.minLat && lat <= ALKMAAR_BBOX.maxLat &&
          record.date >= START_DATE
        );
      })
      .map(record => ({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [parseFloat(record.longitude), parseFloat(record.latitude)],
        },
        properties: {
          date: record.date,
          severity: mapSeverity(record.severity),
          description: record.description || '',
        },
      }));

    const geojson = {
      type: 'FeatureCollection',
      metadata: {
        source: 'STAR/BRON via Rijkswaterstaat open data',
        lastUpdated: new Date().toISOString().split('T')[0],
        featureCount: features.length,
      },
      features,
    };

    writeFileSync(OUTPUT_PATH, JSON.stringify(geojson, null, 2), 'utf-8');
    console.log(`Written ${features.length} accidents to ${OUTPUT_PATH}`);

  } catch (err) {
    console.error(`FAILED to fetch accidents: ${err.message}`);
    console.error('Keeping existing accidents.geojson unchanged.');
    process.exit(1);
  }
}

function mapSeverity(raw) {
  // TODO: Map actual STAR severity codes to our schema
  const map = {
    'UMS': 'materieel',
    'LET': 'letsel',
    'DOD': 'dodelijk',
  };
  return map[raw] || 'materieel';
}

fetchAccidents();
