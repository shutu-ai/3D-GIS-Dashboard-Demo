/** A-B terrain profile: chart rendering, stats, terrain-only LOS + Fresnel. */

import { sampleProfile, type ProfileSample } from "./elevation-query";

export interface ProfileInput {
  a: { lng: number; lat: number; antHeightM: number };
  b: { lng: number; lat: number; antHeightM: number };
  freqMHz: number;
}

export interface ProfileResult {
  samples: ProfileSample[];
  distanceM: number;
  minElev: number | null;
  maxElev: number | null;
  ascentM: number;
  descentM: number;
  blocked: boolean;
  worstClearanceM: number | null; // min (terrain - LOS ray); negative => blocked
  fresnelRadiusM: number | null; // 1st Fresnel radius at midpoint
  outOfCoverage: number; // samples without DEM
}

const R_EARTH = 6371000;

function haversineM(a: { lng: number; lat: number }, b: { lng: number; lat: number }): number {
  const toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR;
  const dLng = (b.lng - a.lng) * toR;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(s));
}

export async function computeProfile(input: ProfileInput, onProgress?: (f: number) => void): Promise<ProfileResult> {
  const { a, b } = input;
  const samples = await sampleProfile(a, b, 30, 9, 12, onProgress);
  const distanceM = haversineM(a, b);
  const elevs = samples.map((s) => s.elevation);
  const valid = elevs.filter((e): e is number => e !== null);
  const minElev = valid.length ? Math.min(...valid) : null;
  const maxElev = valid.length ? Math.max(...valid) : null;

  let ascent = 0;
  let descent = 0;
  for (let i = 1; i < valid.length; i++) {
    const d = valid[i]! - valid[i - 1]!;
    if (d > 0) ascent += d;
    else descent -= d;
  }

  // LOS: ray from (0, a.elev + antA) to (D, b.elev + antB), terrain-only approximation
  const endA = (samples[0]?.elevation ?? 0) + a.antHeightM;
  const endB = (samples[samples.length - 1]?.elevation ?? 0) + b.antHeightM;
  let blocked = false;
  let worst: number | null = null;
  samples.forEach((s, i) => {
    if (s.elevation === null) return;
    const t = samples.length > 1 ? i / (samples.length - 1) : 0;
    const ray = endA + (endB - endA) * t;
    const clearance = ray - s.elevation;
    if (clearance <= 0) blocked = true;
    if (worst === null || clearance < worst) worst = clearance;
  });

  // 1st Fresnel radius at midpoint: F1 = 17.32 * sqrt(d1*d2/(f*D)) [m, km, GHz]
  const Dkm = distanceM / 1000;
  const fGHz = input.freqMHz / 1000;
  const fresnel = Dkm > 0 ? 17.32 * Math.sqrt((Dkm / 2 * (Dkm / 2)) / (fGHz * Dkm)) : null;

  return {
    samples,
    distanceM,
    minElev,
    maxElev,
    ascentM: Math.round(ascent),
    descentM: Math.round(descent),
    blocked,
    worstClearanceM: worst === null ? null : Math.round(worst),
    fresnelRadiusM: fresnel === null ? null : Math.round(fresnel),
    outOfCoverage: samples.length - valid.length,
  };
}

export function drawProfileChart(canvas: HTMLCanvasElement, r: ProfileResult, input: ProfileInput): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const valid = r.samples.filter((s) => s.elevation !== null) as Array<{ lng: number; lat: number; elevation: number }>;
  if (valid.length < 2) {
    ctx.fillStyle = "#e37662";
    ctx.font = "12px sans-serif";
    ctx.fillText("No DEM data along profile", 10, H / 2);
    return;
  }

  const pad = { l: 42, r: 8, t: 10, b: 18 };
  const endA = (r.samples[0]?.elevation ?? 0) + input.a.antHeightM;
  const endB = (r.samples[r.samples.length - 1]?.elevation ?? 0) + input.b.antHeightM;
  let lo = Math.min(...valid.map((s) => s.elevation), endA, endB);
  let hi = Math.max(...valid.map((s) => s.elevation), endA, endB);
  lo = Math.floor((lo - 60) / 100) * 100;
  hi = Math.ceil((hi + 60) / 100) * 100;

  const X = (i: number) => pad.l + (i / (r.samples.length - 1)) * (W - pad.l - pad.r);
  const Y = (e: number) => pad.t + (1 - (e - lo) / (hi - lo)) * (H - pad.t - pad.b);

  // grid + y labels
  ctx.strokeStyle = "rgba(140,160,190,0.15)";
  ctx.fillStyle = "#8fa1b5";
  ctx.font = "9px sans-serif";
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const e = lo + ((hi - lo) * i) / steps;
    const y = Y(e);
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(W - pad.r, y);
    ctx.stroke();
    ctx.fillText(`${Math.round(e)}`, 6, y + 3);
  }

  // terrain
  ctx.beginPath();
  let started = false;
  r.samples.forEach((s, i) => {
    if (s.elevation === null) {
      started = false;
      return;
    }
    const x = X(i);
    const y = Y(s.elevation);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = "#e0b464";
  ctx.lineWidth = 1.4;
  ctx.stroke();
  ctx.lineTo(X(r.samples.length - 1), H - pad.b);
  ctx.lineTo(X(0), H - pad.b);
  ctx.closePath();
  ctx.fillStyle = "rgba(224,180,100,0.18)";
  ctx.fill();

  // LOS ray
  ctx.beginPath();
  ctx.moveTo(X(0), Y(endA));
  ctx.lineTo(X(r.samples.length - 1), Y(endB));
  ctx.strokeStyle = r.blocked ? "#e37662" : "#7ec97e";
  ctx.lineWidth = 1.2;
  ctx.setLineDash([4, 3]);
  ctx.stroke();
  ctx.setLineDash([]);

  // 0.6 F1 envelope
  if (r.fresnelRadiusM !== null) {
    const f1 = 0.6 * r.fresnelRadiusM;
    ctx.beginPath();
    for (let i = 0; i < r.samples.length; i += 1) {
      const t = i / (r.samples.length - 1);
      const ray = endA + (endB - endA) * t;
      const x = X(i);
      const y = Y(ray + f1 * Math.sin(Math.PI * t));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "rgba(122,200,200,0.5)";
    ctx.lineWidth = 0.8;
    ctx.stroke();
  }

  // x labels (km)
  ctx.fillStyle = "#8fa1b5";
  ctx.fillText("0", pad.l, H - 5);
  ctx.fillText(`${(r.distanceM / 1000).toFixed(1)} km`, W - 58, H - 5);
}
