/** Terrain: 2D/3D toggle, pitch control, exaggeration. */

import type { Map as MLMap } from "maplibre-gl";
import { setExaggerationCached } from "./map";

export class TerrainControl {
  private map: MLMap;
  private is3d = true;
  private exaggeration = 1.2;
  /**
   * v1.2.1 coverage-domain gate: real DEM tiles exist only inside the High
   * Atlas coverage. When unavailable (nationwide overview) terrain stays
   * OFF regardless of the toggle, and a 3D request fires "gis:terrain-denied"
   * so the UI can explain + offer the jump back (no fake elevation ever).
   */
  private available = true;

  constructor(map: MLMap, initialEx = 1.2, initiallyAvailable = true) {
    this.map = map;
    this.exaggeration = initialEx;
    this.available = initiallyAvailable;
    if (!initiallyAvailable) this.is3d = false; // overview boot: stay 2D
    setExaggerationCached(initialEx);
    // MapApp.create() may return on either side of the style-load event on a
    // warm/local browser. `isStyleLoaded()` also waits for every tile manager,
    // so use the DEM source as the readiness gate and retry if MapLibre is
    // still parsing the style.
    this.applyWhenReady();
    window.addEventListener("gis:request-3d", () => {
      if (!this.is3d) this.set3d(true);
    });
    window.addEventListener("gis:terrain-unavailable", () => this.setAvailable(false));
    window.addEventListener("gis:terrain-available", () => this.setAvailable(true));
  }

  setAvailable(on: boolean) {
    this.available = on;
    if (!on) {
      // drop the terrain mesh immediately: with pitch 0 the nationwide view
      // has no raised DEM rectangle at the coverage edge (task §5.3/§5.4)
      this.is3d = false;
      this.apply();
    }
  }

  get isTerrainAvailable() {
    return this.available;
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
    if (on && !this.available) {
      // honest denial: keep terrain off, surface the coverage explanation
      window.dispatchEvent(new CustomEvent("gis:terrain-denied"));
      return;
    }
    this.is3d = on;
    if (!on) {
      this.map.easeTo({ pitch: 0, duration: 600 });
    } else {
      // v1.1.0: 3D restore targets the calmer default pitch (50°) but never
      // flattens a steeper view the user chose deliberately
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
