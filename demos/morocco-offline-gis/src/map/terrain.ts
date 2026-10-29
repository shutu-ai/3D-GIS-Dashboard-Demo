/** Terrain: 2D/3D toggle, pitch control, exaggeration. */

import type { Map as MLMap } from "maplibre-gl";
import { setExaggerationCached } from "./map";

export class TerrainControl {
  private map: MLMap;
  private is3d = true;
  private exaggeration = 1.2;

  constructor(map: MLMap, initialEx = 1.2) {
    this.map = map;
    this.exaggeration = initialEx;
    setExaggerationCached(initialEx);
    // MapApp.create() may return on either side of the style-load event on a
    // warm/local browser. `isStyleLoaded()` also waits for every tile manager,
    // so use the DEM source as the readiness gate and retry if MapLibre is
    // still parsing the style.
    this.applyWhenReady();
    window.addEventListener("gis:request-3d", () => {
      if (!this.is3d) this.set3d(true);
    });
  }

  private applyWhenReady() {
    if (this.map.getSource("dem")) {
      try {
        this.apply();
        return;
      } catch {
        // Style source exists, but the style's internal load flag may still
        // be settling. Retry on the next turn instead of failing boot.
      }
    }
    window.setTimeout(() => this.applyWhenReady(), 50);
  }

  private apply() {
    if (this.is3d) {
      this.map.setTerrain({ source: "dem", exaggeration: this.exaggeration });
    } else {
      this.map.setTerrain(null);
    }
    setExaggerationCached(this.exaggeration);
  }

  set3d(on: boolean) {
    this.is3d = on;
    if (!on) {
      this.map.easeTo({ pitch: 0, duration: 600 });
    } else {
      this.map.easeTo({ pitch: Math.max(this.map.getPitch(), 50), duration: 600 });
    }
    this.apply();
  }

  get3d() {
    return this.is3d;
  }

  setPitch(deg: number) {
    this.map.easeTo({ pitch: Math.min(Math.max(deg, 0), 70), duration: 250 });
  }

  setExaggeration(v: number) {
    this.exaggeration = v;
    this.apply();
  }

  getExaggeration() {
    return this.exaggeration;
  }
}
