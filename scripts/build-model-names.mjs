// Builds resources/android-models.tsv.gz (model code → marketing name) from
// Google Play's public list of certified Android devices. Re-run now and
// then to pick up new models: node scripts/build-model-names.mjs
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const url = 'https://storage.googleapis.com/play_public/supported_devices.csv';
console.log(`Downloading ${url}`);
const res = await fetch(url);
if (!res.ok) throw new Error(`download failed: ${res.status}`);
const text = new TextDecoder('utf-16le').decode(await res.arrayBuffer()).replace(/^﻿/, '');

/** Minimal CSV line parser for the quoted 4-column format. */
function parse(line) {
  const out = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const names = new Map();
for (const line of text.split(/\r?\n/).slice(1)) {
  if (!line) continue;
  const [brand, marketing, , model] = parse(line).map((s) => s.trim());
  if (!model || !marketing || marketing.toUpperCase() === model.toUpperCase()) continue;
  const full = brand && !marketing.toLowerCase().startsWith(brand.toLowerCase()) ? `${brand} ${marketing}` : marketing;
  const key = model.toUpperCase();
  const prev = names.get(key);
  if (!prev || full.length < prev.length) names.set(key, full); // several variants: keep the plainest
}

const tsv = [...names].sort(([a], [b]) => a.localeCompare(b)).map(([m, n]) => `${m}\t${n}`).join('\n');
const gz = gzipSync(tsv, { level: 9 });
writeFileSync('resources/android-models.tsv.gz', gz);
console.log(`${names.size} models, ${tsv.length} bytes → ${gz.length} bytes gzipped`);
