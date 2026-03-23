#!/usr/bin/env node

// generate-zones.js
// Reads data/schools.geojson, creates 100m buffers around each entrance,
// writes data/zones.geojson.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import buffer from '@turf/buffer';
import { point, featureCollection } from '@turf/helpers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');

const schoolsPath = join(DATA_DIR, 'schools.geojson');
const outputPath = join(DATA_DIR, 'zones.geojson');

const schools = JSON.parse(readFileSync(schoolsPath, 'utf-8'));

const zoneFeatures = [];

for (const school of schools.features) {
  const entrances = school.properties.entrances || [school.geometry.coordinates];

  for (const entrance of entrances) {
    const pt = point(entrance);
    const buffered = buffer(pt, 500, { units: 'meters' });
    buffered.properties = {
      school: school.properties.name,
    };
    zoneFeatures.push(buffered);
  }
}

const output = featureCollection(zoneFeatures);
output.metadata = {
  generated: new Date().toISOString(),
  bufferMeters: 500,
  schoolCount: schools.features.length,
  zoneCount: zoneFeatures.length,
};

writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf-8');
console.log(`Generated ${zoneFeatures.length} zones for ${schools.features.length} schools → ${outputPath}`);
