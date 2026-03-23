#!/usr/bin/env node

// generate-school-routes.js
// Generates CROW-scored bike route corridors from wijk centroids to schools.
//
// Pipeline:
// 1. Load schools + wijken
// 2. Calculate bike routes via OSRM
// 3. Fetch OSM bike infrastructure (Overpass)
// 4. Fetch BGT fietspad widths (PDOK)
// 5. Score routes on CROW criteria
// 6. Merge overlapping segments, attribute to schools by usage share
// 7. Buffer into 25m corridor polygons
// 8. Write data/school-routes.geojson

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import buffer from '@turf/buffer';
import distance from '@turf/distance';
import length from '@turf/length';
import lineChunk from '@turf/line-chunk';
import nearestPointOnLine from '@turf/nearest-point-on-line';
import simplify from '@turf/simplify';
import { point, lineString, featureCollection } from '@turf/helpers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, '..', 'data');

const OVERPASS_API = 'https://overpass-api.de/api/interpreter';
const VALHALLA_API = 'https://valhalla1.openstreetmap.de/route';
const BGT_API = 'https://api.pdok.nl/lv/bgt/ogc/v1_0/collections/wegdeel/items';
const ALKMAAR_BBOX = [4.68, 52.55, 4.85, 52.70]; // [minLon, minLat, maxLon, maxLat]

const MAX_DISTANCE_KM = 2;       // Skip wijk-school pairs further than this
const ROUTE_BUFFER_M = 25;       // Corridor width (each side)
const SEGMENT_LENGTH_M = 100;    // Chunk routes into segments for scoring
const MIN_ROUTE_SHARE = 0.2;     // Segment must be on ≥20% of a school's routes to be attributed

// --- Helpers ---

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJSON(url, opts = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, opts);
      if (res.status === 429) {
        console.log(`  Rate limited, waiting ${10 * (attempt + 1)}s...`);
        await sleep(10000 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    } catch (err) {
      if (attempt === 2) throw err;
      await sleep(2000 * (attempt + 1));
    }
  }
}

// Round coordinates to ~1m precision for segment dedup
function coordKey(lon, lat) {
  return `${lon.toFixed(5)},${lat.toFixed(5)}`;
}

// --- Step 1: Load data ---

function loadData() {
  console.log('Loading schools and wijken...');
  const schools = JSON.parse(readFileSync(join(DATA, 'schools.geojson'), 'utf-8'));
  const wijken = JSON.parse(readFileSync(join(DATA, 'wijken.geojson'), 'utf-8'));
  const accidents = JSON.parse(readFileSync(join(DATA, 'accidents-filtered.geojson'), 'utf-8'));
  console.log(`  ${schools.features.length} schools, ${wijken.features.length} wijken, ${accidents.features.length} accidents`);
  return { schools, wijken, accidents };
}

// --- Step 2: Calculate bike routes via Valhalla ---

// Decode Valhalla's encoded polyline (precision 6)
function decodePolyline(encoded) {
  const coords = [];
  let lat = 0, lon = 0, i = 0;
  while (i < encoded.length) {
    let shift = 0, result = 0, byte;
    do { byte = encoded.charCodeAt(i++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { byte = encoded.charCodeAt(i++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
    lon += (result & 1) ? ~(result >> 1) : (result >> 1);
    coords.push([lon / 1e6, lat / 1e6]);
  }
  return coords;
}

async function fetchRoutes(schools, wijken) {
  console.log('\nCalculating bike routes via Valhalla...');
  const routes = [];
  let skipped = 0;

  for (const school of schools.features) {
    const [sLon, sLat] = school.geometry.coordinates;
    const schoolName = school.properties.name;

    for (const wijk of wijken.features) {
      const [wLon, wLat] = wijk.properties.centroid;
      const wijkName = wijk.properties.wijkNaam;

      // Skip if too far (straight line)
      const dist = distance(point([wLon, wLat]), point([sLon, sLat]), { units: 'kilometers' });
      if (dist > MAX_DISTANCE_KM) {
        skipped++;
        continue;
      }

      try {
        const body = JSON.stringify({
          locations: [
            { lon: wLon, lat: wLat },
            { lon: sLon, lat: sLat },
          ],
          costing: 'bicycle',
          costing_options: { bicycle: { use_roads: 0.0 } },
        });

        const data = await fetchJSON(VALHALLA_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });

        if (!data.trip?.legs?.[0]) {
          console.warn(`  No route: ${wijkName} → ${schoolName}`);
          continue;
        }

        const leg = data.trip.legs[0];
        const coords = decodePolyline(leg.shape);

        routes.push({
          school: schoolName,
          wijk: wijkName,
          wijkCode: wijk.properties.wijkCode,
          distanceKm: Math.round(data.trip.summary.length * 100) / 100,
          durationMin: Math.round(data.trip.summary.time / 6) / 10,
          geometry: { type: 'LineString', coordinates: coords },
        });
      } catch (err) {
        console.warn(`  Route failed: ${wijkName} → ${schoolName}: ${err.message}`);
      }

      // Rate limit Valhalla
      await sleep(300);
    }
  }

  console.log(`  ${routes.length} routes calculated, ${skipped} pairs skipped (>${MAX_DISTANCE_KM}km)`);
  return routes;
}

// --- Step 3: Fetch OSM bike infrastructure ---

async function fetchOSMInfra() {
  console.log('\nFetching OSM bike infrastructure via Overpass...');

  const query = `[out:json][timeout:120];
(
  way["highway"](${ALKMAAR_BBOX[1]},${ALKMAAR_BBOX[0]},${ALKMAAR_BBOX[3]},${ALKMAAR_BBOX[2]});
);
out body geom;`;

  const data = await fetchJSON(OVERPASS_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(query),
  });

  const ways = data.elements.filter(e => e.type === 'way' && e.geometry);
  console.log(`  ${ways.length} highway ways in Alkmaar`);

  // Convert to GeoJSON features with relevant tags
  const features = ways.map(w => ({
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: w.geometry.map(p => [p.lon, p.lat]),
    },
    properties: {
      osmId: w.id,
      highway: w.tags?.highway,
      cycleway: w.tags?.cycleway || w.tags?.['cycleway:right'] || w.tags?.['cycleway:left'],
      bicycle: w.tags?.bicycle,
      width: parseFloat(w.tags?.['cycleway:width'] || w.tags?.width) || null,
      surface: w.tags?.surface,
      lit: w.tags?.lit,
      maxspeed: parseInt(w.tags?.maxspeed) || null,
      name: w.tags?.name,
    },
  }));

  return features;
}

// --- Step 4: Fetch BGT fietspad widths ---

async function fetchBGTWidths(routes) {
  console.log('\nFetching BGT fietspad widths from PDOK...');

  // Compute tight bbox from actual route geometries instead of full Alkmaar
  let minLon = 999, maxLon = -999, minLat = 999, maxLat = -999;
  for (const r of routes) {
    for (const [lon, lat] of r.geometry.coordinates) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  // Add small buffer
  minLon -= 0.005; maxLon += 0.005; minLat -= 0.005; maxLat += 0.005;
  console.log(`  Route bbox: [${minLon.toFixed(3)}, ${minLat.toFixed(3)}, ${maxLon.toFixed(3)}, ${maxLat.toFixed(3)}]`);

  const features = [];
  const tileSize = 0.03; // ~3km tiles

  // Use cursor-based pagination (BGT API doesn't support offset)
  let tileCount = 0;
  for (let lon = minLon; lon < maxLon; lon += tileSize) {
    for (let lat = minLat; lat < maxLat; lat += tileSize) {
      tileCount++;
      const bboxStr = `${lon.toFixed(3)},${lat.toFixed(3)},${Math.min(lon + tileSize, ALKMAAR_BBOX[2]).toFixed(3)},${Math.min(lat + tileSize, ALKMAAR_BBOX[3]).toFixed(3)}`;
      let nextUrl = BGT_API + '?f=json&limit=200&bbox=' + bboxStr + '&bbox-crs=http://www.opengis.net/def/crs/OGC/1.3/CRS84';
      let pages = 0;

      while (nextUrl && pages < 20) {
        pages++;
        try {
          const data = await fetchJSON(nextUrl);
          if (!data.features || data.features.length === 0) break;

          for (const f of data.features) {
            if (f.properties?.functie !== 'fietspad') continue;
            if (!f.geometry || f.geometry.type !== 'Polygon') continue;

            const coords = f.geometry.coordinates[0];
            if (coords.length < 4) continue;

            // Derive width from polygon: area / longest axis
            let maxDist = 0;
            const step = Math.max(1, Math.floor(coords.length / 10));
            for (let i = 0; i < coords.length; i += step) {
              for (let j = i + step; j < coords.length; j += step) {
                const d = distance(point(coords[i]), point(coords[j]), { units: 'meters' });
                if (d > maxDist) maxDist = d;
              }
            }

            const area = estimatePolygonArea(coords);
            const derivedWidth = maxDist > 1 ? area / maxDist : null;

            features.push({
              type: 'Feature',
              geometry: f.geometry,
              properties: {
                bgtId: f.id,
                derivedWidth: derivedWidth ? Math.round(derivedWidth * 100) / 100 : null,
              },
            });
          }

          // Follow cursor pagination
          const nextLink = data.links?.find(l => l.rel === 'next');
          nextUrl = nextLink ? nextLink.href : null;
          if (nextUrl) await sleep(300);
        } catch (err) {
          console.warn(`  BGT tile error at ${bboxStr}: ${err.message}`);
          break;
        }
      }
    }
  }

  console.log(`  ${features.length} fietspad polygons with derived widths`);
  return features;
}

// Estimate polygon area in m² from WGS84 coordinates
function estimatePolygonArea(coords) {
  // Shoelace formula with latitude correction
  const toRad = Math.PI / 180;
  const R = 6371000;
  let area = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const [lon1, lat1] = coords[i];
    const [lon2, lat2] = coords[i + 1];
    // Approximate planar coords in meters
    const x1 = lon1 * toRad * R * Math.cos(lat1 * toRad);
    const y1 = lat1 * toRad * R;
    const x2 = lon2 * toRad * R * Math.cos(lat2 * toRad);
    const y2 = lat2 * toRad * R;
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}

// --- Step 5: Score route segments on CROW criteria ---

function scoreSegments(routes, osmWays, bgtPaths, accidents) {
  console.log('\nScoring route segments on CROW criteria...');

  // Build spatial index: sample each OSM way every 20m for fast nearest lookup
  const osmIndex = [];
  for (const way of osmWays) {
    if (!way.geometry.coordinates || way.geometry.coordinates.length < 2) continue;
    const coords = way.geometry.coordinates;
    // Just store the way with its midpoint for coarse matching
    const mid = coords[Math.floor(coords.length / 2)];
    osmIndex.push({ lon: mid[0], lat: mid[1], way });
  }

  // BGT index similarly
  const bgtIndex = bgtPaths.map(f => {
    const coords = f.geometry.coordinates[0];
    const mid = coords[Math.floor(coords.length / 2)];
    return { lon: mid[0], lat: mid[1], feature: f };
  });

  // Accident points for density scoring
  const accidentPts = accidents.features.map(f => ({
    lon: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1],
  }));

  const scoredSegments = [];
  let routeIdx = 0;

  for (const route of routes) {
    routeIdx++;
    if (routeIdx % 50 === 0) console.log(`  Scoring route ${routeIdx}/${routes.length}...`);

    try {
      const line = lineString(route.geometry.coordinates);
      const chunks = lineChunk(line, SEGMENT_LENGTH_M / 1000, { units: 'kilometers' });

      for (const chunk of chunks.features) {
        const coords = chunk.geometry.coordinates;
        const mid = coords[Math.floor(coords.length / 2)];
        const [mLon, mLat] = mid;

        // Find nearest OSM way (within 30m)
        let nearestWay = null;
        let nearestDist = Infinity;
        for (const entry of osmIndex) {
          const d = quickDist(mLon, mLat, entry.lon, entry.lat);
          if (d < nearestDist) {
            nearestDist = d;
            nearestWay = entry.way;
          }
        }
        // Refine: check actual distance to line
        if (nearestWay && nearestDist < 0.001) { // ~100m rough filter
          const snapped = nearestPointOnLine(nearestWay, point(mid));
          nearestDist = snapped.properties.dist * 1000; // km to m
        }
        const osmProps = nearestDist < 30 && nearestWay ? nearestWay.properties : {};

        // Find nearest BGT fietspad width
        let bgtWidth = null;
        for (const entry of bgtIndex) {
          const d = quickDist(mLon, mLat, entry.lon, entry.lat);
          if (d < 0.0005) { // ~50m
            bgtWidth = entry.feature.properties.derivedWidth;
            break;
          }
        }

        // Count accidents within 25m
        let accidentCount = 0;
        for (const a of accidentPts) {
          if (quickDist(mLon, mLat, a.lon, a.lat) < 0.0003) { // ~30m
            accidentCount++;
          }
        }

        // --- CROW Scoring ---
        const scores = {};

        // 1. Separation from road
        const hw = osmProps.highway || '';
        const cw = osmProps.cycleway || '';
        const spd = osmProps.maxspeed || 30;
        if (hw === 'cycleway' || cw === 'track' || osmProps.bicycle === 'designated') {
          scores.scheiding = 3; // vrijliggend
        } else if (cw === 'lane') {
          scores.scheiding = spd <= 30 ? 2 : 1; // lane ok at 30, bad at 50+
        } else if (hw === 'residential' || hw === 'living_street') {
          scores.scheiding = spd <= 30 ? 2 : 1;
        } else {
          scores.scheiding = spd >= 50 ? 1 : 2; // no separation on fast road = red
        }

        // 2. Width (prefer BGT, fall back to OSM, default amber)
        const width = bgtWidth || osmProps.width;
        if (width === null || width === undefined) {
          scores.breedte = 2; // default amber
        } else if (width >= 2.30) {
          scores.breedte = 3;
        } else if (width >= 2.00) {
          scores.breedte = 2;
        } else {
          scores.breedte = 1;
        }

        // 3. Surface
        const surface = osmProps.surface || '';
        if (['asphalt', 'concrete'].includes(surface)) {
          scores.verharding = 3;
        } else if (['paved', 'paving_stones', 'sett'].includes(surface)) {
          scores.verharding = 2;
        } else if (['unpaved', 'gravel', 'dirt', 'sand', 'grass'].includes(surface)) {
          scores.verharding = 1;
        } else {
          scores.verharding = 2; // default amber
        }

        // 4. Lighting
        if (osmProps.lit === 'yes') {
          scores.verlichting = 3;
        } else if (osmProps.lit === 'no') {
          scores.verlichting = 1;
        } else {
          scores.verlichting = 2; // default amber
        }

        // 5. Speed context
        if (spd <= 30) {
          scores.snelheid = 3;
        } else if (spd <= 50 && (cw === 'track' || hw === 'cycleway')) {
          scores.snelheid = 2;
        } else if (spd >= 50) {
          scores.snelheid = 1;
        } else {
          scores.snelheid = 2;
        }

        // 6. Accident density
        if (accidentCount === 0) {
          scores.conflicten = 3;
        } else if (accidentCount <= 2) {
          scores.conflicten = 2;
        } else {
          scores.conflicten = 1;
        }

        // Composite score (average)
        const values = Object.values(scores);
        const composite = values.reduce((a, b) => a + b, 0) / values.length;

        // Label
        let label;
        if (composite >= 2.5) label = 'veilig';
        else if (composite >= 2) label = 'aandacht';
        else label = 'onveilig';

        scoredSegments.push({
          geometry: chunk.geometry,
          school: route.school,
          wijk: route.wijk,
          wijkCode: route.wijkCode,
          scores,
          composite: Math.round(composite * 100) / 100,
          label,
          accidentCount,
          streetName: osmProps.name || null,
          osmHighway: osmProps.highway || null,
          bgtWidth,
        });
      }
    } catch (err) {
      // Skip malformed routes
    }
  }

  console.log(`  ${scoredSegments.length} segments scored`);
  return scoredSegments;
}

// Quick euclidean distance in degrees (for spatial filtering, not accuracy)
function quickDist(lon1, lat1, lon2, lat2) {
  const dLon = lon1 - lon2;
  const dLat = lat1 - lat2;
  return Math.sqrt(dLon * dLon + dLat * dLat);
}

// --- Step 6: Merge overlapping segments and attribute to schools ---

function mergeAndAttribute(segments, schools) {
  console.log('\nMerging overlapping segments and attributing to schools...');

  const MAX_SCHOOL_DIST_KM = 0.75; // 750m — segments beyond this aren't attributed

  // Build school coordinate lookup
  const schoolCoords = {};
  for (const s of schools.features) {
    schoolCoords[s.properties.name] = s.geometry.coordinates;
  }

  // Group segments by spatial location (grid cell)
  const cellSize = 0.001; // ~100m grid
  const grid = new Map();

  for (const seg of segments) {
    const coords = seg.geometry.coordinates;
    const mid = coords[Math.floor(coords.length / 2)];
    const key = `${Math.round(mid[0] / cellSize)},${Math.round(mid[1] / cellSize)}`;

    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(seg);
  }

  const mergedFeatures = [];
  const schoolRouteCounts = {};

  // Count total routes per school
  const routesBySchool = new Map();
  for (const seg of segments) {
    const key = `${seg.school}__${seg.wijk}`;
    routesBySchool.set(key, true);
  }
  for (const [key] of routesBySchool) {
    const school = key.split('__')[0];
    schoolRouteCounts[school] = (schoolRouteCounts[school] || 0) + 1;
  }

  let droppedDist = 0;

  for (const [, cellSegments] of grid) {
    // Group by school
    const bySchool = new Map();
    for (const seg of cellSegments) {
      if (!bySchool.has(seg.school)) bySchool.set(seg.school, []);
      bySchool.get(seg.school).push(seg);
    }

    // Collect all schools this cell is attributed to (allows multi-school)
    const cellSchools = [];

    for (const [school, schoolSegs] of bySchool) {
      // Check distance from segment to school — must be within 750m
      const rep = schoolSegs[0];
      const mid = rep.geometry.coordinates[Math.floor(rep.geometry.coordinates.length / 2)];
      const sCoords = schoolCoords[school];
      if (sCoords) {
        const dist = distance(point(mid), point(sCoords), { units: 'kilometers' });
        if (dist > MAX_SCHOOL_DIST_KM) {
          droppedDist += schoolSegs.length;
          continue;
        }
      }

      const totalRoutes = schoolRouteCounts[school] || 1;
      const uniqueWijken = new Set(schoolSegs.map(s => s.wijk));
      const routeShare = uniqueWijken.size / totalRoutes;

      if (routeShare < MIN_ROUTE_SHARE) continue;

      // Average scores
      const avgScores = {};
      const scoreKeys = Object.keys(schoolSegs[0].scores);
      for (const k of scoreKeys) {
        avgScores[k] = schoolSegs.reduce((sum, s) => sum + s.scores[k], 0) / schoolSegs.length;
        avgScores[k] = Math.round(avgScores[k] * 100) / 100;
      }

      // Find worst segment's street name
      const worstSeg = schoolSegs.reduce((worst, s) => s.composite < worst.composite ? s : worst, schoolSegs[0]);

      cellSchools.push({
        school,
        wijken: [...uniqueWijken].sort(),
        routeShare: Math.round(routeShare * 100) / 100,
        scores: avgScores,
        accidentCount: Math.max(...schoolSegs.map(s => s.accidentCount)),
        streetName: worstSeg.streetName,
        worstComposite: worstSeg.composite,
      });
    }

    // Skip cells not attributed to any school
    if (cellSchools.length === 0) continue;

    // Use representative geometry from first school's segments
    const firstSchoolSegs = bySchool.get(cellSchools[0].school);
    const repGeom = firstSchoolSegs[0].geometry;

    // Merge scores across all attributed schools (weighted average)
    const allScoreKeys = Object.keys(cellSchools[0].scores);
    const mergedScores = {};
    for (const k of allScoreKeys) {
      mergedScores[k] = cellSchools.reduce((sum, s) => sum + s.scores[k], 0) / cellSchools.length;
      mergedScores[k] = Math.round(mergedScores[k] * 100) / 100;
    }

    const composite = Object.values(mergedScores).reduce((a, b) => a + b, 0) / allScoreKeys.length;
    let label;
    if (composite >= 2.5) label = 'veilig';
    else if (composite >= 2) label = 'aandacht';
    else label = 'onveilig';

    mergedFeatures.push({
      type: 'Feature',
      geometry: repGeom,
      properties: {
        schools: cellSchools.map(s => s.school),
        wijken: [...new Set(cellSchools.flatMap(s => s.wijken))].sort(),
        scores: mergedScores,
        composite: Math.round(composite * 100) / 100,
        label,
        accidentCount: Math.max(...cellSchools.map(s => s.accidentCount)),
        streetName: cellSchools.reduce((w, s) => s.worstComposite < w.worstComposite ? s : w, cellSchools[0]).streetName,
      },
    });
  }

  console.log(`  ${mergedFeatures.length} merged features (from ${segments.length} raw segments)`);
  console.log(`  ${droppedDist} segments dropped (>750m from school)`);
  return mergedFeatures;
}

// --- Step 7: Buffer into corridor polygons ---

function buildCorridors(features) {
  console.log('\nBuffering into corridor polygons...');

  const corridors = features.map(f => {
    try {
      const buffered = buffer(f, ROUTE_BUFFER_M / 1000, { units: 'kilometers' });
      if (!buffered) return null;

      // Simplify to reduce file size
      const simplified = simplify(buffered, { tolerance: 0.00005, highQuality: true });

      simplified.properties = f.properties;
      return simplified;
    } catch {
      return null;
    }
  }).filter(Boolean);

  console.log(`  ${corridors.length} corridor polygons`);
  return corridors;
}

// --- Main ---

async function main() {
  const { schools, wijken, accidents } = loadData();

  // Step 2: OSRM routes
  const routes = await fetchRoutes(schools, wijken);

  // Step 3: OSM infrastructure
  const osmWays = await fetchOSMInfra();

  // Step 4: BGT fietspad widths (scoped to route bbox)
  const bgtPaths = await fetchBGTWidths(routes);

  // Step 5: Score segments
  const segments = scoreSegments(routes, osmWays, bgtPaths, accidents);

  // Step 6: Merge and attribute (750m max from school, multi-school)
  const merged = mergeAndAttribute(segments, schools);

  // Step 7: Build corridors
  const corridors = buildCorridors(merged);

  // Write output
  const output = {
    type: 'FeatureCollection',
    metadata: {
      generated: new Date().toISOString(),
      routeCount: routes.length,
      segmentCount: segments.length,
      corridorCount: corridors.length,
      scoring: {
        criteria: ['scheiding', 'breedte', 'verharding', 'verlichting', 'snelheid', 'conflicten'],
        scale: '1=onveilig (rood), 2=aandacht (oranje), 3=veilig (groen)',
        thresholds: { veilig: '≥2.5', aandacht: '2.0-2.49', onveilig: '<2.0' },
      },
      sources: ['Valhalla (bike routing, use_roads=0)', 'OpenStreetMap (infrastructure)', 'BGT/PDOK (fietspad widths)', 'STAR (accidents)'],
    },
    features: corridors,
  };

  const outPath = join(DATA, 'school-routes.geojson');
  writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf-8');

  // Stats
  const labels = { veilig: 0, aandacht: 0, onveilig: 0 };
  for (const c of corridors) labels[c.properties.label]++;
  console.log(`\nScore distribution: veilig=${labels.veilig}, aandacht=${labels.aandacht}, onveilig=${labels.onveilig}`);
  console.log(`Done → ${outPath}`);
}

main().catch(err => {
  console.error('FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
