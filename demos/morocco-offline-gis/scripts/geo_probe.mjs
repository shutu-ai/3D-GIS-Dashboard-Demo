#!/usr/bin/env node
// geo_probe.mjs - offline PMTiles/MVT probe for the v1.2.1 geographic context
// archives (Protomaps Basemap v4). Reads ONLY local files; no network.
//
// Usage:
//   node scripts/geo_probe.mjs <archive.pmtiles> <mode> [args...]
//
// Modes (each prints exactly one JSON object on stdout):
//   layers   <z/x/y>
//     -> { layers: { <sourceLayerName>: <featureCount> } }
//   features <z/x/y> <sourceLayer> <maxCount>
//     -> { features: [ {name, kind, kind_detail, disputed, elevation,
//                       min_zoom, population_rank, ref} ] }
//      (only keys that exist on each feature are included)
//   sweep    <z> <minLon> <minLat> <maxLon> <maxLat> <sourceLayer>
//     -> { tiles: {checked, hit},
//          kindCounts: { "kind=... |kind_detail=... |disputed=...": count },
//          disputedCount, samples: [...first 8 disputed feature props] }
//
// Exit codes: 0 ok, 2 usage error, 1 runtime error (message on stderr).

import { PMTiles } from '../node_modules/pmtiles/dist/esm/index.js';
import { VectorTile } from '@mapbox/vector-tile';
import Protobuf from 'pbf';
import fsp from 'node:fs/promises';

class NodeFileSource {
  constructor(path) { this.path = path; }
  getKey() { return this.path; }
  async getBytes(offset, length) {
    const fh = await fsp.open(this.path, 'r');
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, offset);
      return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytesRead) };
    } finally { await fh.close(); }
  }
}
// PMTiles.getZxy(z,x,y) returns ALREADY-DECOMPRESSED MVT bytes (or undefined).
// Parse with: new VectorTile(new Protobuf(data.data))

function usage(msg) {
  console.error(msg || 'usage: node geo_probe.mjs <archive.pmtiles> <layers|features|sweep> [args...]');
  process.exit(2);
}

function parseZxy(s) {
  const m = /^(\d+)\/(\d+)\/(\d+)$/.exec(s ?? '');
  if (!m) usage(`bad tile id "${s}" (expected z/x/y)`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

const lonToX = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const latToY = (lat, z) => {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(Math.PI / 4 + rad / 2)) / Math.PI) / 2) * 2 ** z);
};

async function getTile(p, z, x, y) {
  const r = await p.getZxy(z, x, y);
  if (!r || !r.data || r.data.length === 0) return null;
  return new VectorTile(new Protobuf(r.data));
}

const kv = (v) => (v === undefined || v === null ? '' : String(v));
const isTrue = (v) => v === true || v === 'true' || v === 1;

function collectFeatureProps(feature) {
  const keys = ['name', 'kind', 'kind_detail', 'disputed', 'elevation', 'min_zoom', 'population_rank', 'ref'];
  const out = {};
  const props = feature.properties ?? {};
  for (const k of keys) {
    if (props[k] !== undefined) out[k] = props[k]; // only include keys that exist
  }
  return out;
}

async function main() {
  const [archive, mode, ...rest] = process.argv.slice(2);
  if (!archive || !mode) usage();
  const p = new PMTiles(new NodeFileSource(archive));

  if (mode === 'layers') {
    if (rest.length !== 1) usage('usage: ... layers <z/x/y>');
    const [z, x, y] = parseZxy(rest[0]);
    const tile = await getTile(p, z, x, y);
    const layers = {};
    if (tile) {
      for (const [name, layer] of Object.entries(tile.layers)) {
        layers[name] = layer.length;
      }
    }
    console.log(JSON.stringify({ layers }));

  } else if (mode === 'features') {
    if (rest.length !== 3) usage('usage: ... features <z/x/y> <sourceLayer> <maxCount>');
    const [z, x, y] = parseZxy(rest[0]);
    const sourceLayer = rest[1];
    const maxCount = Number(rest[2]);
    if (!Number.isFinite(maxCount) || maxCount < 0) usage('maxCount must be a non-negative number');
    const tile = await getTile(p, z, x, y);
    const layer = tile?.layers?.[sourceLayer];
    const features = [];
    if (layer) {
      const n = Math.min(maxCount, layer.length);
      for (let i = 0; i < n; i++) {
        features.push(collectFeatureProps(layer.feature(i)));
      }
    }
    console.log(JSON.stringify({ features }));

  } else if (mode === 'sweep') {
    if (rest.length !== 6) usage('usage: ... sweep <z> <minLon> <minLat> <maxLon> <maxLat> <sourceLayer>');
    const z = Number(rest[0]);
    const minLon = Number(rest[1]);
    const minLat = Number(rest[2]);
    const maxLon = Number(rest[3]);
    const maxLat = Number(rest[4]);
    const sourceLayer = rest[5];
    if (![z, minLon, minLat, maxLon, maxLat].every(Number.isFinite)) usage('sweep args must be numeric');
    const n = 2 ** z;
    const xMin = clamp(lonToX(minLon, z), 0, n - 1);
    const xMax = clamp(lonToX(maxLon, z), 0, n - 1);
    const yMin = clamp(latToY(maxLat, z), 0, n - 1); // top of bbox first
    const yMax = clamp(latToY(minLat, z), 0, n - 1);

    let checked = 0;
    let hit = 0;
    const kindCounts = {};
    let disputedCount = 0;
    const samples = [];
    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) {
        checked++;
        let tile = null;
        try {
          tile = await getTile(p, z, x, y);
        } catch {
          tile = null;
        }
        if (!tile) continue;
        const layer = tile.layers[sourceLayer];
        if (!layer) continue;
        hit++;
        for (let i = 0; i < layer.length; i++) {
          const props = layer.feature(i).properties ?? {};
          const key = `kind=${kv(props.kind)} |kind_detail=${kv(props.kind_detail)} |disputed=${kv(props.disputed)}`;
          kindCounts[key] = (kindCounts[key] ?? 0) + 1;
          if (isTrue(props.disputed)) {
            disputedCount++;
            if (samples.length < 8) samples.push(props);
          }
        }
      }
    }
    console.log(JSON.stringify({ tiles: { checked, hit }, kindCounts, disputedCount, samples }));

  } else {
    usage(`unknown mode "${mode}" (expected layers|features|sweep)`);
  }
}

main().catch((e) => {
  console.error('PROBE FAILED:', e?.stack ?? e);
  process.exit(1);
});
