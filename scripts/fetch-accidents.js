#!/usr/bin/env node

// fetch-accidents.js
// Fetches STAR traffic accident data for Alkmaar from the via.software
// PublicAccidents API (same source as star-verkeersongevallen.nl).
//
// Strategy:
// 1. Fetch vector tiles (MVT/protobuf) covering Alkmaar at zoom 14
// 2. Decode tiles to extract accident point locations with IDs
// 3. Fetch per-location year breakdown via detail API
// 4. Build GeoJSON with per-year accident features
//
// This gives us 2021-2026 data (much more current than BRON/RWS WFS).
// Date precision is year-level from the API, but new locations detected
// by daily diff get stamped with the exact date they first appeared.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, '..', 'data', 'accidents.geojson');

// STAR API (same as star-verkeersongevallen.nl)
const API_BASE = 'https://api.via.software/applications/PublicAccidents';
const COUNTRY = 'NLD';
const ORIGIN = 'https://www.star-verkeersongevallen.nl';

// Alkmaar bounding box
const BOUNDS = { minLon: 4.71, maxLon: 4.80, minLat: 52.61, maxLat: 52.66 };
const TILE_ZOOM = 14;

// Tile coordinate math
function lonToTileX(lon, z) { return Math.floor((lon + 180) / 360 * (1 << z)); }
function latToTileY(lat, z) {
  const r = lat * Math.PI / 180;
  return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * (1 << z));
}

// Fetch with retry
async function fetchWithRetry(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'Origin': ORIGIN, 'Referer': ORIGIN + '/' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
}

// Fetch overview data (date range, totals)
async function fetchOverview() {
  const res = await fetchWithRetry(`${API_BASE}/${COUNTRY}`);
  return res.json();
}

// Fetch and decode a vector tile
async function fetchTile(x, y, z) {
  const url = `${API_BASE}/${COUNTRY}/Tile/${z}/${x}/${y}`;
  const res = await fetchWithRetry(url);
  const buffer = await res.arrayBuffer();
  const tile = new VectorTile(new Pbf(new Uint8Array(buffer)));
  return tile;
}

// Fetch detail for a specific location
async function fetchDetail(id) {
  const res = await fetchWithRetry(`${API_BASE}/${COUNTRY}/${id}`);
  return res.json();
}

// Extract points from tile
function extractPoints(tile, x, y, z) {
  const points = [];
  const layer = tile.layers['point'];
  if (!layer) return points;

  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    const geojson = feature.toGeoJSON(x, y, z);
    const [lon, lat] = geojson.geometry.coordinates;

    // Filter to Alkmaar bounds
    if (lon >= BOUNDS.minLon && lon <= BOUNDS.maxLon &&
        lat >= BOUNDS.minLat && lat <= BOUNDS.maxLat) {
      points.push({
        id: feature.id,
        coordinates: [lon, lat],
        properties: feature.properties,
      });
    }
  }
  return points;
}

// Map severity from STAR properties
function getSeverity(props) {
  if (props.fatal_accidents > 0) return 'dodelijk';
  if (props.injured_accidents > 0) return 'letsel';
  return 'materieel';
}

// Total accidents at a location
function getTotalAccidents(props) {
  return (props.omd_accidents || 0) +
         (props.injured_accidents || 0) +
         (props.fatal_accidents || 0);
}

async function fetchAccidents() {
  const today = new Date().toISOString().split('T')[0];

  try {
    // 1. Fetch overview to confirm data range
    console.log('Fetching STAR overview...');
    const overview = await fetchOverview();
    console.log(`  Data range: ${overview.StartDate} - ${overview.EndDate}`);

    // 2. Calculate tiles covering Alkmaar
    const x1 = lonToTileX(BOUNDS.minLon, TILE_ZOOM);
    const x2 = lonToTileX(BOUNDS.maxLon, TILE_ZOOM);
    const y1 = latToTileY(BOUNDS.maxLat, TILE_ZOOM); // Note: y is inverted
    const y2 = latToTileY(BOUNDS.minLat, TILE_ZOOM);
    const totalTiles = (x2 - x1 + 1) * (y2 - y1 + 1);
    console.log(`\nFetching ${totalTiles} tiles at zoom ${TILE_ZOOM}...`);

    // 3. Fetch all tiles and extract points
    const allPoints = new Map(); // id → point (dedup across tile edges)

    for (let x = x1; x <= x2; x++) {
      for (let y = y1; y <= y2; y++) {
        try {
          const tile = await fetchTile(x, y, TILE_ZOOM);
          const points = extractPoints(tile, x, y, TILE_ZOOM);
          for (const p of points) {
            if (!allPoints.has(p.id)) {
              allPoints.set(p.id, p);
            }
          }
        } catch (err) {
          console.warn(`  Tile ${x}/${y} failed: ${err.message}`);
        }
      }
    }

    console.log(`  Found ${allPoints.size} unique accident locations in Alkmaar`);

    // 4. Fetch detail for each location (year breakdown)
    console.log('\nFetching detail data for each location...');
    const features = [];
    let processed = 0;

    // Load existing data for date tracking
    const existingKeys = new Map();
    if (existsSync(OUTPUT_PATH)) {
      const existing = JSON.parse(readFileSync(OUTPUT_PATH, 'utf-8'));
      for (const f of existing.features) {
        const key = `${f.geometry.coordinates[0].toFixed(5)}_${f.geometry.coordinates[1].toFixed(5)}_${f.properties.year}`;
        existingKeys.set(key, {
          date: f.properties.date,
          firstSeen: f.properties.firstSeen,
        });
      }
      console.log(`  Loaded ${existingKeys.size} existing records for date tracking`);
    }

    // Batch detail requests (5 concurrent)
    const pointsArray = [...allPoints.values()];
    const BATCH_SIZE = 5;

    for (let i = 0; i < pointsArray.length; i += BATCH_SIZE) {
      const batch = pointsArray.slice(i, i + BATCH_SIZE);
      const details = await Promise.all(
        batch.map(p => fetchDetail(p.id).catch(err => {
          console.warn(`  Detail ${p.id} failed: ${err.message}`);
          return null;
        }))
      );

      for (let j = 0; j < batch.length; j++) {
        const point = batch[j];
        const detail = details[j];

        if (!detail || !detail.Data) {
          // No detail — use tile-level data as fallback
          const totalAcc = getTotalAccidents(point.properties);
          if (totalAcc > 0) {
            features.push({
              type: 'Feature',
              geometry: { type: 'Point', coordinates: point.coordinates },
              properties: {
                date: today,
                severity: getSeverity(point.properties),
                year: null,
                totalAccidents: totalAcc,
                description: '',
                firstSeen: today,
                starId: point.id,
              },
            });
          }
          continue;
        }

        // Create one feature per year that has accidents
        for (const series of detail.Data) {
          for (const yearData of series.Data) {
            if (yearData.y === 0) continue;

            const year = yearData.x || parseInt(yearData.title);
            const key = `${point.coordinates[0].toFixed(5)}_${point.coordinates[1].toFixed(5)}_${year}`;

            // Skip if we already created a feature for this location+year
            if (features.some(f =>
              f.properties.starId === point.id &&
              f.properties.year === year &&
              f.properties.starSeries === series.Title
            )) continue;

            let severity = 'materieel';
            if (series.Title === 'FATAL_ACCIDENTS') severity = 'dodelijk';
            else if (series.Title === 'INJURED_ACCIDENTS') severity = 'letsel';
            else if (series.Title === 'OMD_ACCIDENTS') severity = 'materieel';

            // Preserve existing date tracking
            const existing = existingKeys.get(key);
            const date = existing?.date || `${year}-01-01`;
            const firstSeen = existing?.firstSeen || today;

            features.push({
              type: 'Feature',
              geometry: { type: 'Point', coordinates: point.coordinates },
              properties: {
                date,
                severity,
                year,
                count: yearData.y,
                description: '',
                firstSeen,
                starId: point.id,
                starSeries: series.Title,
              },
            });
          }
        }
      }

      processed += batch.length;
      if (processed % 50 === 0 || processed === pointsArray.length) {
        console.log(`  Processed ${processed}/${pointsArray.length} locations (${features.length} features)`);
      }
    }

    // Deduplicate: keep one feature per location+year with highest severity
    const deduped = new Map();
    const severityRank = { dodelijk: 3, letsel: 2, materieel: 1 };

    for (const f of features) {
      const key = `${f.properties.starId}_${f.properties.year}`;
      const existing = deduped.get(key);
      if (!existing || (severityRank[f.properties.severity] || 0) > (severityRank[existing.properties.severity] || 0)) {
        // Merge counts from all series
        if (existing) {
          f.properties.count = (f.properties.count || 0) + (existing.properties.count || 0);
        }
        deduped.set(key, f);
      } else if (existing) {
        existing.properties.count = (existing.properties.count || 0) + (f.properties.count || 0);
      }
    }

    const uniqueFeatures = [...deduped.values()];

    // Sort by date descending
    uniqueFeatures.sort((a, b) => b.properties.date.localeCompare(a.properties.date));

    // Remove internal tracking fields for cleaner output
    for (const f of uniqueFeatures) {
      delete f.properties.starSeries;
    }

    const geojson = {
      type: 'FeatureCollection',
      metadata: {
        source: 'STAR via star-verkeersongevallen.nl (via.software API)',
        lastUpdated: today,
        dataRange: `${overview.StartDate} - ${overview.EndDate}`,
        featureCount: uniqueFeatures.length,
        locationCount: allPoints.size,
        note: 'Dates are year-level from STAR. New locations detected via daily diff get exact first-seen date.',
      },
      features: uniqueFeatures,
    };

    writeFileSync(OUTPUT_PATH, JSON.stringify(geojson, null, 2), 'utf-8');
    console.log(`\nDone: ${uniqueFeatures.length} accident records from ${allPoints.size} locations → ${OUTPUT_PATH}`);

  } catch (err) {
    console.error(`FAILED: ${err.message}`);
    console.error('Keeping existing accidents.geojson unchanged.');
    process.exit(1);
  }
}

// Clean up temp files
function cleanup() {
  try { require('fs').unlinkSync(join(__dirname, '..', 'tmp_tile.pbf')); } catch {}
}

fetchAccidents().then(cleanup);
