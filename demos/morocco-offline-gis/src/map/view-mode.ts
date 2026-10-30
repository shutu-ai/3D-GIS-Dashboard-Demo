/**
 * GIS / RAN Coverage view-mode state machine (v1.2.0).
 *
 * ONE place owns mode-driven map state:
 *  - RAN layer + banner visibility (delegated to RanOverlay, boot-race-safe)
 *  - base-map dampening for RAN readability (minor contours, hillshade,
 *    minor contour labels) — a single declarative table, applied/restored
 *    atomically; GIS mode restores v1.1.0 values byte-for-byte
 *  - URL hash `&m=ran` suffix (back-compatible: absent == 'gis'; unknown
 *    values degrade safely to 'gis')
 *  - selection cleanup when leaving RAN (no stale highlights / banners)
 *
 * Deliberately NOT here: per-frame paint tweaks scattered across callers.
 * Everything mode-driven goes through setMode().
 */

import type { Map as MLMap } from "maplibre-gl";
import { LAYER_IDS } from "../config";
import type { RanOverlay } from "./ran-overlay";

export type ViewMode = "gis" | "ran";

/** Module-level so map.ts can append it to the view hash without a cycle. */
let activeMode: ViewMode = "gis";

export function currentViewMode(): ViewMode {
  return activeMode;
}

/**
 * Parse the optional `&m=` suffix from the location hash.
 * v1.1.0 links (`#v=…` only) and unknown modes degrade to 'gis'.
 */
export function readHashMode(): ViewMode {
  const m = /[?&]m=(\w+)/.exec(location.hash);
  return m?.[1] === "ran" ? "ran" : "gis";
}

/**
 * Base-map dampening table for RAN Coverage View. Each entry:
 * [layerId, paintProperty, gisValue, ranValue].
 * GIS values equal v1.1.0 effective rendering (opacity properties are not
 * declared in the v1.1.0 style — their faint look lives in the color alpha —
 * so the restore value is the MapLibre default 1; normalizing them to
 * explicit 1 at boot is visually identical and makes the state machine
 * deterministic).
 */
const BASE_DAMPEN: Array<[string, string, unknown, unknown]> = [
  // minor contours: the dominant texture competing with RSRP roads (RCA §1)
  [LAYER_IDS.contoursLine, "line-opacity", 1, 0.16],
  // minor contour numbers: nearly invisible under RAN, majors stay full
  [LAYER_IDS.contoursLabelMinor, "text-opacity", 1, 0.22],
  // hillshade contrast: softer relief so blue/amber RAN marks pop (RCA §1);
  // hypsometric tint stays at 1.0 — v1.1.0 proved <1.0 bleeds seams
  [LAYER_IDS.hillshade, "hillshade-exaggeration", 0.35, 0.2],
];

export class ViewModeControl {
  private _mode: ViewMode = "gis";
  private dampenApplied = false;
  private pollTimer: number | null = null;

  constructor(
    private map: MLMap,
    private ran: RanOverlay,
    private onModeChange: (mode: ViewMode) => void,
  ) {
    // normalize the dampened properties to their explicit GIS values as soon
    // as the style registers, so getPaintProperty state is deterministic
    this.applyDampen(false);
  }

  get mode(): ViewMode {
    return this._mode;
  }

  /** Entry point for every mode switch (buttons, ly-ran checkbox, hash boot). */
  setMode(mode: ViewMode) {
    if (mode === this._mode) {
      // still notify so callers can re-sync their UI (e.g. boot from hash)
      this.onModeChange(mode);
      return;
    }
    this._mode = mode;
    activeMode = mode;
    if (mode === "ran") {
      // banner + RAN layers switch atomically inside RanOverlay; safe to call
      // pre-boot (applyVisibility is layered until getLayer() turns true)
      this.ran.setVisible(true);
      this.applyDampen(true);
    } else {
      // leaving RAN must leave nothing behind: selection, highlights, banner
      this.ran.clearSelection();
      this.ran.setVisible(false);
      this.applyDampen(false);
    }
    this.onModeChange(mode);
  }

  /**
   * Apply/restore the dampening table. Layer-set dependent, so poll like
   * RanOverlay does — isStyleLoaded() is NOT a reliable boot signal
   * (software-GL machines can starve it forever; see RCA §3.2).
   */
  private applyDampen(on: boolean) {
    this.dampenApplied = on;
    const apply = () => {
      if (this.dampenApplied !== on) return true; // superseded by newer call
      let ready = true;
      for (const [id, prop, gis, ran] of BASE_DAMPEN) {
        if (!this.map.getLayer(id)) {
          ready = false;
          continue;
        }
        this.map.setPaintProperty(id, prop, on ? ran : gis);
      }
      return ready;
    };
    if (apply()) return;
    if (this.pollTimer !== null) window.clearTimeout(this.pollTimer);
    let tries = 0;
    const retry = () => {
      if (apply() || ++tries > 300) return; // cap ~30 s
      this.pollTimer = window.setTimeout(retry, 100);
    };
    retry();
  }
}
