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
import difference from '@turf/difference';
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
  // Use ALL accidents (not filtered to school zones) for road segment scoring
  const accidents = JSON.parse(readFileSync(join(DATA, 'accidents.geojson'), 'utf-8'));
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
    if (routeIdx % 50 === 0) console.log(`  Scoring route ${routeIdx}/${routes.length}...`);

    try {
      const line = lineString(route.geometry.coordinates);
      const chunks = lineChunk(line, SEGMENT_LENGTH_M / 1000, { units: 'kilometers' });

      let chunkIdx = 0;
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

        // Count accidents within 25m of any point along the segment
        let accidentCount = 0;
        const threshold = 0.00025; // ~25m in degrees
        for (const a of accidentPts) {
          // Check against all coordinate pairs in the segment
          for (const c of coords) {
            if (quickDist(c[0], c[1], a.lon, a.lat) < threshold) {
              accidentCount++;
              break; // count each accident only once per segment
            }
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

        // CROW composite (infrastructure only — 5 criteria, no accidents)
        const crowValues = Object.values(scores);
        const crowScore = crowValues.reduce((a, b) => a + b, 0) / crowValues.length;

        // Accident score (separate) — continuous scale, more accidents = lower score
        // 0 accidents = 3, then decays: score = max(0, 3 - accidentCount * 0.3)
        // So: 1 acc=2.7, 2=2.4, 5=1.5, 10=0, 16=0
        const accidentScore = Math.max(0, Math.round((3 - accidentCount * 0.3) * 100) / 100);

        // Final composite: CROW weighted 70%, accidents 30%
        const composite = crowScore * 0.3 + accidentScore * 0.7;

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
          routeId: routeIdx,
          segmentIndex: chunkIdx,
          scores,
          crowScore: Math.round(crowScore * 100) / 100,
          accidentScore: Math.round(accidentScore * 100) / 100,
          composite: Math.round(composite * 100) / 100,
          label,
          accidentCount,
          streetName: osmProps.name || null,
          osmHighway: osmProps.highway || null,
          bgtWidth,
        });
        chunkIdx++;
      }
    } catch (err) {
      // Skip malformed routes
    }
    routeIdx++;
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

  const MAX_SCHOOL_DIST_KM = 0.75;
  const DEDUP_PRECISION = 4; // toFixed(4) ≈ 11m grid for overlap detection

  // Build school coordinate lookup
  const schoolCoords = {};
  for (const s of schools.features) {
    schoolCoords[s.properties.name] = s.geometry.coordinates;
  }

  // Count total routes per school (for route-share filter)
  const schoolRouteCounts = {};
  const routesBySchool = new Map();
  for (const seg of segments) {
    routesBySchool.set(`${seg.school}__${seg.wijk}`, true);
  }
  for (const [key] of routesBySchool) {
    const school = key.split('__')[0];
    schoolRouteCounts[school] = (schoolRouteCounts[school] || 0) + 1;
  }

  // Group spatially-overlapping segments by road position (~11m precision)
  const roadGroups = new Map();
  for (const seg of segments) {
    const coords = seg.geometry.coordinates;
    const mid = coords[Math.floor(coords.length / 2)];
    const key = `${mid[0].toFixed(DEDUP_PRECISION)},${mid[1].toFixed(DEDUP_PRECISION)}`;
    if (!roadGroups.has(key)) roadGroups.set(key, []);
    roadGroups.get(key).push(seg);
  }

  const mergedFeatures = [];
  let droppedDist = 0;

  for (const [, groupSegs] of roadGroups) {
    // Group by school within this road position
    const bySchool = new Map();
    for (const seg of groupSegs) {
      if (!bySchool.has(seg.school)) bySchool.set(seg.school, []);
      bySchool.get(seg.school).push(seg);
    }

    const qualifiedSchools = [];

    for (const [school, schoolSegs] of bySchool) {
      // Distance filter: segment must be within 750m of school
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

      // Route-share filter
      const totalRoutes = schoolRouteCounts[school] || 1;
      const uniqueWijken = new Set(schoolSegs.map(s => s.wijk));
      const routeShare = uniqueWijken.size / totalRoutes;
      if (routeShare < MIN_ROUTE_SHARE) continue;

      // Average scores across all segments from this school at this position
      const avgScores = {};
      const scoreKeys = Object.keys(schoolSegs[0].scores);
      for (const k of scoreKeys) {
        avgScores[k] = schoolSegs.reduce((sum, s) => sum + s.scores[k], 0) / schoolSegs.length;
        avgScores[k] = Math.round(avgScores[k] * 100) / 100;
      }

      const worstSeg = schoolSegs.reduce((w, s) => s.composite < w.composite ? s : w, schoolSegs[0]);
      const avgCrow = schoolSegs.reduce((sum, s) => sum + s.crowScore, 0) / schoolSegs.length;
      const avgAccident = schoolSegs.reduce((sum, s) => sum + s.accidentScore, 0) / schoolSegs.length;

      qualifiedSchools.push({
        school,
        wijken: [...uniqueWijken].sort(),
        scores: avgScores,
        crowScore: Math.round(avgCrow * 100) / 100,
        accidentScore: Math.round(avgAccident * 100) / 100,
        accidentCount: Math.max(...schoolSegs.map(s => s.accidentCount)),
        streetName: worstSeg.streetName,
        worstComposite: worstSeg.composite,
      });
    }

    if (qualifiedSchools.length === 0) continue;

    // Pick representative geometry — prefer the segment with the best route ordering
    // (earliest routeId, lowest segmentIndex) to preserve contiguity
    const repSeg = groupSegs.reduce((best, s) => {
      if (s.routeId < best.routeId) return s;
      if (s.routeId === best.routeId && s.segmentIndex < best.segmentIndex) return s;
      return best;
    }, groupSegs[0]);

    // Merge scores across all attributed schools
    const allScoreKeys = Object.keys(qualifiedSchools[0].scores);
    const mergedScores = {};
    for (const k of allScoreKeys) {
      mergedScores[k] = qualifiedSchools.reduce((sum, s) => sum + s.scores[k], 0) / qualifiedSchools.length;
      mergedScores[k] = Math.round(mergedScores[k] * 100) / 100;
    }

    const crowScore = qualifiedSchools.reduce((sum, s) => sum + s.crowScore, 0) / qualifiedSchools.length;
    const accidentScore = qualifiedSchools.reduce((sum, s) => sum + s.accidentScore, 0) / qualifiedSchools.length;
    const composite = crowScore * 0.3 + accidentScore * 0.7;
    let label;
    if (composite >= 2.5) label = 'veilig';
    else if (composite >= 2) label = 'aandacht';
    else label = 'onveilig';

    mergedFeatures.push({
      type: 'Feature',
      geometry: repSeg.geometry,
      properties: {
        schools: qualifiedSchools.map(s => s.school),
        wijken: [...new Set(qualifiedSchools.flatMap(s => s.wijken))].sort(),
        scores: mergedScores,
        crowScore: Math.round(crowScore * 100) / 100,
        accidentScore: Math.round(accidentScore * 100) / 100,
        composite: Math.round(composite * 100) / 100,
        label,
        accidentCount: Math.max(...qualifiedSchools.map(s => s.accidentCount)),
        streetName: qualifiedSchools.reduce((w, s) => s.worstComposite < w.worstComposite ? s : w, qualifiedSchools[0]).streetName,
        _routeId: repSeg.routeId,
        _segmentIndex: repSeg.segmentIndex,
      },
    });
  }

  // Sort by route order so adjacent segments stay together
  mergedFeatures.sort((a, b) => {
    if (a.properties._routeId !== b.properties._routeId) return a.properties._routeId - b.properties._routeId;
    return a.properties._segmentIndex - b.properties._segmentIndex;
  });

  console.log(`  ${mergedFeatures.length} merged features (from ${segments.length} raw segments)`);
  console.log(`  ${droppedDist} segments dropped (>750m from school)`);
  return mergedFeatures;
}

// --- Step 7: Buffer into corridor polygons, clip overlaps ---

function getBBox(feature) {
  const coords = feature.geometry.type === 'Polygon'
    ? feature.geometry.coordinates[0]
    : feature.geometry.type === 'MultiPolygon'
      ? feature.geometry.coordinates.flat(1).flat()
      : feature.geometry.coordinates;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const pts = feature.geometry.type === 'MultiPolygon'
    ? feature.geometry.coordinates.flatMap(p => p[0])
    : coords;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

function bboxOverlaps(a, b) {
  const [ax1, ay1, ax2, ay2] = getBBox(a);
  const [bx1, by1, bx2, by2] = getBBox(b);
  return ax1 <= bx2 && ax2 >= bx1 && ay1 <= by2 && ay2 >= by1;
}

function buildCorridors(features) {
  console.log('\nBuffering into corridor polygons...');

  // Sort by composite ascending — worst-scoring segments get priority (never clipped away)
  const sorted = [...features].sort((a, b) =>
    a.properties.composite - b.properties.composite
  );

  const corridors = [];

  for (const f of sorted) {
    try {
      let buffered = buffer(f, ROUTE_BUFFER_M / 1000, { units: 'kilometers' });
      if (!buffered) continue;

      // Clip against previously emitted corridors to remove overlap
      for (const prev of corridors) {
        if (!bboxOverlaps(buffered, prev)) continue;
        try {
          const clipped = difference(featureCollection([buffered, prev]));
          if (clipped) {
            buffered = clipped;
          } else {
            buffered = null; // completely contained by a prior segment
            break;
          }
        } catch { /* if clipping fails, keep unclipped */ }
      }

      if (!buffered) continue;

      // For MultiPolygons from clipping, drop tiny slivers (< 50m²)
      if (buffered.geometry.type === 'MultiPolygon') {
        const kept = buffered.geometry.coordinates.filter(poly => {
          // Quick area estimate from coordinate span
          const ring = poly[0];
          let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
          for (const [x, y] of ring) {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
          const spanM = (maxX - minX) * 111000 * Math.cos(minY * Math.PI / 180) *
                        (maxY - minY) * 111000;
          return spanM > 50; // keep parts > ~50 m²
        });
        if (kept.length === 0) continue;
        if (kept.length === 1) {
          buffered.geometry = { type: 'Polygon', coordinates: kept[0] };
        } else {
          buffered.geometry.coordinates = kept;
        }
      }

      const simplified = simplify(buffered, { tolerance: 0.00008, highQuality: true });
      simplified.properties = { ...f.properties };
      delete simplified.properties._routeId;
      delete simplified.properties._segmentIndex;

      corridors.push(simplified);
    } catch {
      // Skip malformed
    }
  }

  console.log(`  ${corridors.length} corridor polygons (non-overlapping)`);
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
        criteria: ['scheiding', 'breedte', 'verharding', 'verlichting', 'snelheid'],
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
