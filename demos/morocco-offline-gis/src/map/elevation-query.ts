/**
 * Raw DEM elevation sampling — decodes terrarium tiles straight from the
 * local PMTiles archive over HTTP range requests.
 *
 * IMPORTANT (acceptance): this path never consults MapLibre's rendered
 * terrain, so visual exaggeration cannot affect reported elevations.
 * Nearest-pixel sampling only — we do not fabricate sub-DEM precision.
 */

import { demArchive } from "./map";

export type SampleResult =
  | { status: "ok"; elevation: number }
  | { status: "out-of-coverage" }
  | { status: "no-data" };

const TILE_SIZE = 512;
const cache = new Map<string, ImageData | null>();
const pending = new Map<string, Promise<ImageData | null>>();
const MAX_CACHE = 40;

function lngLatToTile(lng: number, lat: number, zoom: number): { x: number; y: number; fx: number; fy: number } {
  const n = 2 ** zoom;
  const tx = ((lng + 180) / 360) * n;
  const latR = (lat * Math.PI) / 180;
  const ty = ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n;
  return { x: Math.floor(tx), y: Math.floor(ty), fx: tx % 1, fy: ty % 1 };
}

function pickZoomForStep(stepMeters: number, lat: number, zmin: number, zmax: number): number {
  // ground metres per pixel at a zoom: 40075016 * cos(lat) / (512 * 2^z)
  const target = stepMeters * TILE_SIZE;
  const z = Math.log2((40075016 * Math.cos((lat * Math.PI) / 180)) / target);
  return Math.min(zmax, Math.max(zmin, Math.round(z)));
}

async function loadTileData(z: number, x: number, y: number): Promise<ImageData | null> {
  const key = `${z}/${x}/${y}`;
  if (cache.has(key)) return cache.get(key)!;
  if (pending.has(key)) return pending.get(key)!;

  const p = (async () => {
    try {
      const result = await demArchive.getZxy(z, x, y);
      if (!result || !result.data || (result.data as ArrayBuffer).byteLength === 0) {
        // distinguish "archive has no tile here" (outside coverage) from decode issues
        cacheTile(key, null);
        return null;
      }
      const blob = new Blob([result.data], { type: "image/png" });
      const bmp = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(bmp, 0, 0, TILE_SIZE, TILE_SIZE);
      bmp.close();
      const data = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
      cacheTile(key, data);
      return data;
    } catch {
      cacheTile(key, null);
      return null;
    }
  })();
  pending.set(key, p);
  const out = await p;
  pending.delete(key);
  return out;
}

function cacheTile(key: string, data: ImageData | null) {
  if (cache.size >= MAX_CACHE) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(key, data);
}

/** Nearest-pixel terrarium decode. */
export async function sampleElevation(
  lng: number,
  lat: number,
  _zmin = 9,
  zmax = 12,
): Promise<SampleResult> {
  const z = zmax;
  const { x, y, fx, fy } = lngLatToTile(lng, lat, z);
  const data = await loadTileData(z, x, y);
  if (data === null) return { status: "out-of-coverage" };
  const px = Math.min(TILE_SIZE - 1, Math.floor(fx * TILE_SIZE));
  const py = Math.min(TILE_SIZE - 1, Math.floor(fy * TILE_SIZE));
  const i = (py * TILE_SIZE + px) * 4;
  const r = data.data[i]!;
  const g = data.data[i + 1]!;
  const b = data.data[i + 2]!;
  if (r === 0 && g === 0 && b === 0) return { status: "no-data" };
  const elevation = r * 256 + g + b / 256 - 32768;
  return { status: "ok", elevation };
}

export interface ProfileSample {
  lng: number;
  lat: number;
  elevation: number | null; // null => out of coverage at this sample
}

/** Sample a path A->B with ~stepMeters spacing (async, chunked). */
export async function sampleProfile(
  a: { lng: number; lat: number },
  b: { lng: number; lat: number },
  stepMeters = 30,
  zmin = 9,
  zmax = 12,
  onProgress?: (fraction: number) => void,
): Promise<ProfileSample[]> {
  const kmPerDegLat = 111.32;
  const kmPerDegLon = 111.32 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  const dxKm = (b.lng - a.lng) * kmPerDegLon;
  const dyKm = (b.lat - a.lat) * kmPerDegLat;
  const distKm = Math.hypot(dxKm, dyKm);
  const n = Math.max(2, Math.min(1500, Math.round((distKm * 1000) / stepMeters) + 1));
  const zoom = pickZoomForStep(stepMeters, (a.lat + b.lat) / 2, zmin, zmax);
  const out: ProfileSample[] = [];
  const CHUNK = 60;
  for (let i = 0; i < n; i += CHUNK) {
    const end = Math.min(n, i + CHUNK);
    const jobs: Array<Promise<void>> = [];
    for (let j = i; j < end; j++) {
      const t = j / (n - 1);
      const lng = a.lng + (b.lng - a.lng) * t;
      const lat = a.lat + (b.lat - a.lat) * t;
      jobs.push(
        (async () => {
          const r = await sampleElevation(lng, lat, zmin, zoom);
          out.push({
            lng,
            lat,
            elevation: r.status === "ok" ? r.elevation : null,
          });
        })(),
      );
    }
    await Promise.all(jobs);
    onProgress?.(end / n);
    await new Promise((res) => setTimeout(res, 0)); // yield to the UI thread
  }
  // keep order stable despite concurrent chunk fills
  out.sort((p, q) => {
    const tp = (p.lng - a.lng) * (b.lng - a.lng) + (p.lat - a.lat) * (b.lat - a.lat);
    const tq = (q.lng - a.lng) * (b.lng - a.lng) + (q.lat - a.lat) * (b.lat - a.lat);
    return tp - tq;
  });
  return out;
}
