#!/usr/bin/env node
// audit_geo_glyphs.mjs - offline glyph-range audit for the v1.2.1 geographic
// context label layers (no browser, no network, no new deps).
//
// WHY: the app bundles Noto Sans Regular glyph range 0-255 ONLY. Any label
// character outside U+0000-U+00FF makes MapLibre request a glyph range file
// that 404s offline. The label text expression in
// src/map/geographic-context.ts (NAME_FIELD) guards each name candidate with
// an `index-of` scan over UNSAFE_CODEPOINTS - the exact non-0-255 codepoints
// present in the shipped PMTiles snapshots. This audit re-derives that
// evidence from the source archives so a data refresh can be re-checked.
//
// WHAT IT AUDITS (exact rendered label set):
//   - sources: <archive>.pmtiles source-layers "places" (all features) and
//     "pois" (kind peak|saddle only) - the only layers with geo text-fields;
//   - candidate cascade mirrored from NAME_FIELD:
//     name:fr -> name:en -> raw `name` (only if it has cased letters);
//   - sweep = EVERY native zoom 0..maxzoom inside the metadata bbox. There is
//     NO subset assumption: generalized low-zoom variants (country/region
//     labels, renamed/simplified features) can exist ONLY at shallow zoom and
//     disappear at deep zoom, so each native zoom level is audited in full.
//     The same feature may be observed at several zooms; violation samples
//     and per-feature findings are deduplicated, tile/feature totals are
//     reported per zoom for transparency.
//
// CHECKS
//   1. unguarded cascade (candidates WITHOUT the index-of guard): enumerates
//      every >255 codepoint that could ever reach the renderer. PASS requires
//      this set to be a subset of the pinned UNSAFE_CODEPOINTS read live from
//      geographic-context.ts (drift detection in both directions).
//   2. guarded cascade (candidates WITH the pinned guard, i.e. what the style
//      actually renders): any remaining >255 codepoint is a hard FAIL (the
//      pinned list missed something that renders).
//   NOTE: a passing verdict certifies the PINNED SNAPSHOTS only - it is not a
//   claim of all-Unicode safety for future data; re-run after any data refresh.
//
// INPUTS (defaults, all local files)
//   public/data/metadata.json            bbox + maxzoom per archive
//   public/data/morocco-overview.pmtiles
//   public/data/high-atlas-context.pmtiles
//   src/map/geographic-context.ts        pinned UNSAFE_CODEPOINTS
//
// OUTPUT: one JSON object on stdout; exit 0 = PASS, 1 = FAIL, 2 = usage/env.
//
// Usage: node scripts/audit_geo_glyphs.mjs
//        node scripts/audit_geo_glyphs.mjs <archive.pmtiles> [<archive.pmtiles> ...]

import { PMTiles } from '../node_modules/pmtiles/dist/esm/index.js';
import { VectorTile } from '@mapbox/vector-tile';
import Protobuf from 'pbf';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const SRC_TS = path.join(ROOT, 'src', 'map', 'geographic-context.ts');
const METADATA = path.join(ROOT, 'public', 'data', 'metadata.json');

class NodeFileSource {
  constructor(p) { this.p = p; }
  getKey() { return this.p; }
  async getBytes(offset, length) {
    const fh = await fsp.open(this.p, 'r');
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, offset);
      return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytesRead) };
    } finally { await fh.close(); }
  }
}

const rad = (d) => (d * Math.PI) / 180;
const lonToX = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const latToY = (lat, z) => Math.floor(((1 - Math.log(Math.tan(Math.PI / 4 + rad(lat) / 2)) / Math.PI) / 2) * 2 ** z);

const hasCased = (s) => s.toLowerCase() !== s.toUpperCase();
const unsafeCps = (s, pinned) => {
  const out = new Set();
  for (const ch of s) { const cp = ch.codePointAt(0); if (cp > 255 && !pinned.has(cp)) out.add(cp); }
  return out;
};

/** Mirror of NAME_FIELD WITHOUT the index-of guard (first non-empty candidate). */
function unguardedChoice(props) {
  const fr = typeof props['name:fr'] === 'string' ? props['name:fr'] : null;
  const en = typeof props['name:en'] === 'string' ? props['name:en'] : null;
  const nm = typeof props['name'] === 'string' ? props['name'] : null;
  if (fr) return { text: fr, from: 'name:fr' };
  if (en) return { text: en, from: 'name:en' };
  if (nm && hasCased(nm)) return { text: nm, from: 'name(cased)' };
  return { text: '', from: 'none' };
}

/** Mirror of NAME_FIELD WITH the pinned guard (what the style renders). */
function guardedChoice(props, pinned) {
  const fr = typeof props['name:fr'] === 'string' ? props['name:fr'] : null;
  const en = typeof props['name:en'] === 'string' ? props['name:en'] : null;
  const nm = typeof props['name'] === 'string' ? props['name'] : null;
  const safe = (s) => ![...s].some((ch) => pinned.has(ch.codePointAt(0)));
  if (fr && safe(fr)) return { text: fr, from: 'name:fr' };
  if (en && safe(en)) return { text: en, from: 'name:en' };
  if (nm && hasCased(nm) && safe(nm)) return { text: nm, from: 'name(cased)' };
  return { text: '', from: 'skipped(no Latin-safe name)' };
}

function readPinnedList() {
  const src = fs.readFileSync(SRC_TS, 'utf8');
  const m = /const UNSAFE_CODEPOINTS = \[([\s\S]*?)\];/.exec(src);
  if (!m) throw new Error(`UNSAFE_CODEPOINTS not found in ${SRC_TS}`);
  // strip line comments before parsing: `// U+012B ī` must not contribute digits
  const body = m[1].replace(/\/\/[^\n]*/g, '');
  const nums = [...body.matchAll(/\d+/g)].map((x) => Number(x[0]));
  if (!nums.length) throw new Error(`no numbers parsed from UNSAFE_CODEPOINTS in ${SRC_TS}`);
  return new Set(nums);
}

async function auditArchive(file, bbox, maxzoom, pinned) {
  const p = new PMTiles(new NodeFileSource(file));
  const unguarded = new Map(); // cp -> { samples:Set, from:Set }
  const guardedViolationIndex = new Map(); // dedupe by layer+text+from
  let labeled = 0, skipped = 0;
  const perZoom = [];
  for (let z = 0; z <= maxzoom; z++) {
    const x0 = lonToX(bbox[0], z), x1 = lonToX(bbox[2], z);
    const y0 = latToY(bbox[3], z), y1 = latToY(bbox[1], z);
    let tiles = 0, features = 0;
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const r = await p.getZxy(z, x, y);
        if (!r || !r.data) continue;
        tiles++;
        const tile = new VectorTile(new Protobuf(r.data));
        for (const sourceLayer of ['places', 'pois']) {
          const layer = tile.layers[sourceLayer];
          if (!layer) continue;
          for (let i = 0; i < layer.length; i++) {
            const props = layer.feature(i).properties ?? {};
            if (sourceLayer === 'pois' && !['peak', 'saddle'].includes(props.kind)) continue;
            features++;
            // 1) superset enumeration: everything the cascade could reach
            const ug = unguardedChoice(props);
            if (ug.text) {
              labeled++;
              for (const cp of unsafeCps(ug.text, new Set())) {
                if (!unguarded.has(cp)) unguarded.set(cp, { samples: new Set(), from: new Set() });
                const e = unguarded.get(cp);
                e.from.add(ug.from);
                if (e.samples.size < 3) e.samples.add(ug.text);
              }
            }
            // 2) what actually renders with the pinned guard
            const g = guardedChoice(props, pinned);
            if (g.from.startsWith('skipped')) { skipped++; continue; }
            const leak = unsafeCps(g.text, new Set());
            if (leak.size > 0) {
              const key = `${sourceLayer}|${g.from}|${g.text}`;
              if (!guardedViolationIndex.has(key)) {
                guardedViolationIndex.set(key, { sourceLayer, name: g.text, from: g.from, codepoints: [...leak].map((cp) => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0')), zooms: new Set() });
              }
              guardedViolationIndex.get(key).zooms.add(z);
            }
          }
        }
      }
    }
    perZoom.push({ zoom: z, tilesChecked: tiles, featuresObserved: features });
  }
  const guardedViolations = [...guardedViolationIndex.values()].map((v) => ({ ...v, zooms: [...v.zooms] }));
  const tilesTotal = perZoom.reduce((s, e) => s + e.tilesChecked, 0);
  const featuresTotal = perZoom.reduce((s, e) => s + e.featuresObserved, 0);
  return {
    archive: path.basename(file),
    sweep: {
      zooms: `0-${maxzoom} (every native zoom)`,
      tilesCheckedTotal: tilesTotal,
      featuresObservedTotal: featuresTotal,
      note: 'featuresObserved counts one observation per zoom level a feature appears at; findings are deduplicated',
      labeledCandidates: labeled,
      guardSkipped: skipped,
      perZoom,
    },
    unguardedUnsafeCodepoints: [...unguarded.entries()].map(([cp, e]) => ({
      cp,
      hex: 'U+' + cp.toString(16).toUpperCase().padStart(4, '0'),
      glyphRange: `${Math.floor(cp / 256) * 256}-${Math.floor(cp / 256) * 256 + 255}`,
      reachedVia: [...e.from],
      samples: [...e.samples],
    })).sort((a, b) => a.cp - b.cp),
    guardedViolations,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const meta = JSON.parse(fs.readFileSync(METADATA, 'utf8'));
  const geoFiles = meta.geo_context?.files;
  if (!geoFiles) { console.error(`no geo_context.files in ${METADATA}`); process.exit(2); }
  const files = args.length
    ? args
    : Object.entries(geoFiles).map(([f]) => path.join(ROOT, 'public', 'data', f));
  let pinned;
  try { pinned = readPinnedList(); } catch (e) { console.error(e.message); process.exit(2); }

  const archives = [];
  for (const f of files) {
    const entry = Object.entries(geoFiles).find(([name]) => f.replaceAll('\\', '/').endsWith(name));
    if (!entry) { console.error(`no metadata entry for ${f}`); process.exit(2); }
    archives.push(await auditArchive(path.resolve(f), entry[1].bbox, entry[1].maxzoom, pinned));
  }

  const allUnguarded = new Set(archives.flatMap((a) => a.unguardedUnsafeCodepoints.map((u) => u.cp)));
  const beyondPinned = [...allUnguarded].filter((cp) => !pinned.has(cp));
  const violations = archives.flatMap((a) => a.guardedViolations);
  const verdict = beyondPinned.length === 0 && violations.length === 0 ? 'PASS' : 'FAIL';

  console.log(JSON.stringify({
    audit: 'geo-glyphs',
    verdict,
    pinnedCodepoints: [...pinned].sort((a, b) => a - b).map((cp) => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0')),
    beyondPinnedCount: beyondPinned.length,
    beyondPinned: beyondPinned.map((cp) => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0')),
    guardedRenderingViolations: violations,
    archives,
    scopeNote: 'Certifies the pinned snapshots only (places all kinds + pois kind peak|saddle, swept at EVERY native zoom 0..maxzoom within each metadata bbox — no lower-zoom subset assumption). Re-run after any data refresh; not a claim of all-Unicode safety.',
  }, null, 1));
  process.exit(verdict === 'PASS' ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
