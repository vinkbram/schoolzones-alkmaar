#!/usr/bin/env node

// fetch-accidents.js
// Fetches STAR/BRON traffic accident data for Alkmaar from the Rijkswaterstaat
// WFS service, transforms to GeoJSON, writes data/accidents.geojson.
//
// Date tracking strategy:
// - Historical data (from WFS bulk): only has year-level precision → stored as "YYYY-01-01"
// - New accidents (detected by daily diff): stamped with today's date as "first seen" date.
//   This gives us day-level precision going forward for the hero counter.
// - The "firstSeen" property tracks when we first detected each accident.
//
// API: Rijkswaterstaat GDR WFS — no authentication required.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, '..', 'data', 'accidents.geojson');

// WFS endpoint
const WFS_BASE = 'https://geo.rijkswaterstaat.nl/services/ogc/gdr/verkeersongevallen_nederland/ows';

// Layers to fetch — add new yearly layers as RWS publishes them
const LAYERS = [
  'ongevallen_2022_2024',
  // 'ongevallen_2025', // uncomment when available
];

// Max features per request (WFS pagination)
const PAGE_SIZE = 1000;

// Severity mapping: WFS values → our schema
const SEVERITY_MAP = {
  'Uitsluitend materiele schade': 'materieel',
  'Letsel': 'letsel',
  'Dood': 'dodelijk',
};

async function fetchLayer(typeName) {
  const allFeatures = [];
  let startIndex = 0;
  let hasMore = true;

  while (hasMore) {
    const params = new URLSearchParams({
      service: 'WFS',
      version: '2.0.0',
      request: 'GetFeature',
      typeName,
      outputFormat: 'json',
      CQL_FILTER: "gemeente='Alkmaar'",
      srsName: 'EPSG:4326',
      count: PAGE_SIZE.toString(),
      startIndex: startIndex.toString(),
    });

    const url = `${WFS_BASE}?${params}`;
    console.log(`Fetching ${typeName} startIndex=${startIndex}...`);

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`WFS returned HTTP ${response.status} for ${typeName}`);
    }

    const data = await response.json();
    const features = data.features || [];
    allFeatures.push(...features);

    console.log(`  Got ${features.length} features (total: ${allFeatures.length})`);

    if (features.length < PAGE_SIZE) {
      hasMore = false;
    } else {
      startIndex += PAGE_SIZE;
    }
  }

  return allFeatures;
}

// Generate a stable unique key for deduplication (coords + year only — description can vary)
function featureKey(coords, year) {
  const lon = coords[0].toFixed(5);
  const lat = coords[1].toFixed(5);
  return `${lon}_${lat}_${year}`;
}

function transformFeature(wfsFeature, today) {
  const props = wfsFeature.properties;
  const geom = wfsFeature.geometry;

  if (!geom || !geom.coordinates) return null;

  const severityRaw = props.verkeersongeval_afloop || '';
  const severity = SEVERITY_MAP[severityRaw] || 'materieel';

  // Build description from available fields
  const parts = [];
  if (props.aard_ongeval) parts.push(props.aard_ongeval);
  if (props.partij_1_objecttype && props.partij_2_objecttype) {
    parts.push(`${props.partij_1_objecttype} vs. ${props.partij_2_objecttype}`);
  } else if (props.partij_1_objecttype) {
    parts.push(props.partij_1_objecttype);
  }

  return {
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: geom.coordinates,
    },
    properties: {
      date: `${props.jaar_ongeval}-01-01`, // Year-level only from WFS
      severity,
      year: props.jaar_ongeval,
      description: parts.join(' — '),
      streetName: props.straatnaam || '',
      speedLimit: props.maximum_snelheid || null,
      parties: props.aantal_partijen || null,
      firstSeen: today, // Will be overwritten with existing value if known
    },
  };
}

async function fetchAccidents() {
  const today = new Date().toISOString().split('T')[0];

  try {
    // Load existing data to preserve firstSeen dates
    const existingKeys = new Map(); // key → { date, firstSeen }
    if (existsSync(OUTPUT_PATH)) {
      const existing = JSON.parse(readFileSync(OUTPUT_PATH, 'utf-8'));
      for (const f of existing.features) {
        const key = featureKey(f.geometry.coordinates, f.properties.year);
        existingKeys.set(key, {
          date: f.properties.date,
          firstSeen: f.properties.firstSeen,
        });
      }
      console.log(`Loaded ${existingKeys.size} existing accidents for comparison.`);
    }

    // Fetch fresh data from WFS
    const allFeatures = [];
    for (const layer of LAYERS) {
      const raw = await fetchLayer(layer);
      const transformed = raw.map(f => transformFeature(f, today)).filter(Boolean);
      allFeatures.push(...transformed);
    }

    // Deduplicate and merge with existing dates
    const seen = new Set();
    const unique = [];
    let newCount = 0;

    for (const f of allFeatures) {
      const key = featureKey(
        f.geometry.coordinates,
        f.properties.year,
        f.properties.description,
      );

      if (seen.has(key)) continue;
      seen.add(key);

      const existing = existingKeys.get(key);
      if (existing) {
        // Preserve existing firstSeen and any day-level date we may have set
        f.properties.firstSeen = existing.firstSeen;
        if (existing.date && existing.date !== `${f.properties.year}-01-01`) {
          f.properties.date = existing.date;
        }
      } else {
        // New accident — stamp with today's date for day-level tracking
        f.properties.date = today;
        f.properties.firstSeen = today;
        newCount++;
      }

      unique.push(f);
    }

    // Sort by date descending (most recent first for hero counter)
    unique.sort((a, b) => b.properties.date.localeCompare(a.properties.date));

    const geojson = {
      type: 'FeatureCollection',
      metadata: {
        source: 'STAR/BRON via Rijkswaterstaat WFS (geo.rijkswaterstaat.nl)',
        lastUpdated: today,
        featureCount: unique.length,
        layers: LAYERS,
        note: 'Historical dates are year-level (YYYY-01-01). New accidents detected via daily diff get exact date.',
      },
      features: unique,
    };

    writeFileSync(OUTPUT_PATH, JSON.stringify(geojson, null, 2), 'utf-8');
    console.log(`\nDone: ${unique.length} accidents (${newCount} new) → ${OUTPUT_PATH}`);

  } catch (err) {
    console.error(`FAILED to fetch accidents: ${err.message}`);
    console.error('Keeping existing accidents.geojson unchanged.');
    process.exit(1);
  }
}

fetchAccidents();
