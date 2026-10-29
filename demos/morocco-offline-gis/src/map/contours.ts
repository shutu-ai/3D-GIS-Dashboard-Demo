/** Contour layer visibility + zoom-dependent interval indicator. */

import type { Map as MLMap } from "maplibre-gl";
import { LAYER_IDS, type AppMetadata } from "../config";

const CONTOUR_LAYERS = [
  LAYER_IDS.contoursLine,
  LAYER_IDS.contoursMajor,
  LAYER_IDS.contoursLabel,
] as const;

export class ContourControl {
  private map: MLMap;
  private visible = true;
  private intervals: Array<{ zMax: number; meters: number }>;

  constructor(map: MLMap, meta: AppMetadata, private onIntervalChange: (m: number | null) => void) {
    this.map = map;
    // intervals_by_zoom keys like "6-8": 500, "9-11": 100, "12+": 50
    this.intervals = Object.entries(meta.contours.intervals_by_zoom).map(([k, v]) => {
      const zmax = k.endsWith("+") ? 24 : Number(k.split("-")[1]);
      return { zMax: zmax, meters: v };
    });
    map.on("zoom", () => this.updateIndicator());
    map.on("load", () => this.updateIndicator());
  }

  private currentInterval(): number | null {
    const z = this.map.getZoom();
    for (const iv of this.intervals) {
      if (z <= iv.zMax) return iv.meters;
    }
    return this.intervals[this.intervals.length - 1]?.meters ?? null;
  }

  private updateIndicator() {
    this.onIntervalChange(this.visible ? this.currentInterval() : null);
  }

  setVisible(on: boolean) {
    this.visible = on;
    for (const id of CONTOUR_LAYERS) {
      if (this.map.getLayer(id)) this.map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    }
    this.updateIndicator();
  }
}
