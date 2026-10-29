/** Simulated RAN overlay: sector fans, site popups, RSRP road, banner. */

import maplibregl, { type Map as MLMap } from "maplibre-gl";
import { LAYER_IDS } from "../config";

interface Sector {
  azimuth: number;
  width_deg: number;
  radius_m: number;
}

interface RanSourceData {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    geometry: { type: string; coordinates: unknown };
    properties: {
      id?: string;
      ele?: number;
      height_m?: number;
      bands?: string[];
      sectors?: Sector[];
      rsrp_dbm?: number;
    };
  }>;
}

const RAN_LAYERS = [
  LAYER_IDS.ranSectors,
  LAYER_IDS.ranRsrp,
  LAYER_IDS.ranSites,
  LAYER_IDS.ranSiteLabels,
] as const;

function fanPolygon(lng: number, lat: number, s: Sector): [number, number][] {
  const steps = 24;
  const kmPerDegLat = 111.32;
  const kmPerDegLon = 111.32 * Math.cos((lat * Math.PI) / 180);
  const pts: [number, number][] = [[lng, lat]];
  for (let i = 0; i <= steps; i++) {
    const az = ((s.azimuth - s.width_deg / 2 + (s.width_deg * i) / steps) * Math.PI) / 180;
    // azimuth 0 = north, clockwise
    const dKm = s.radius_m / 1000;
    pts.push([lng + (Math.sin(az) * dKm) / kmPerDegLon, lat + (Math.cos(az) * dKm) / kmPerDegLat]);
  }
  return pts;
}

export class RanOverlay {
  private map: MLMap;
  private visible = false;
  private banner: HTMLElement;

  constructor(map: MLMap) {
    this.map = map;
    this.banner = document.getElementById("ran-banner")!;
    map.on("load", () => {
      this.applyVisibility();
      this.attachPopups();
    });
  }

  private attachPopups() {
    const popup = new maplibregl.Popup({
      closeButton: false,
      maxWidth: "260px",
    });
    this.map.on("click", LAYER_IDS.ranSites, (e) => {
      const f = e.features?.[0];
      if (!f) return;
      const p = f.properties as {
        id: string;
        ele: number;
        height_m: number;
        bands: string[] | string;
        sectors: Sector[] | string;
      };
      const bands = Array.isArray(p.bands) ? p.bands.join(", ") : String(p.bands);
      const sectors = typeof p.sectors === "string" ? JSON.parse(p.sectors) : p.sectors;
      const sectorRows = (sectors as Sector[])
        .map(
          (s) =>
            `<tr><td>${Math.round(s.azimuth)}°</td><td>${Math.round(s.width_deg)}°</td><td>${(s.radius_m / 1000).toFixed(1)} km</td></tr>`,
        )
        .join("");
      const c = (f.geometry as unknown as { coordinates: [number, number] }).coordinates;
      popup
        .setLngLat(c)
        .setHTML(
          `<div style="font-weight:700;margin-bottom:4px">${p.id} <span style="color:#f0c96a;font-size:10px">SIMULATED</span></div>
           <table style="font-size:11px;line-height:1.5">
           <tr><td style="color:#8fa1b5">经纬度</td><td>${c[1].toFixed(5)}, ${c[0].toFixed(5)}</td></tr>
           <tr><td style="color:#8fa1b5">站址海拔</td><td>${p.ele} m</td></tr>
           <tr><td style="color:#8fa1b5">天线挂高</td><td>${p.height_m} m (模拟)</td></tr>
           <tr><td style="color:#8fa1b5">频段</td><td>${bands}</td></tr>
           </table>
           <div style="margin-top:4px;font-size:10px;color:#8fa1b5">扇区 (方位/角宽/半径)</div>
           <table style="font-size:11px">${sectorRows}</table>`,
        )
        .addTo(this.map);
    });
    this.map.on("mouseenter", LAYER_IDS.ranSites, () => {
      this.map.getCanvas().style.cursor = "pointer";
    });
    this.map.on("mouseleave", LAYER_IDS.ranSites, () => {
      this.map.getCanvas().style.cursor = "";
    });
  }

  /** Build sector fan polygons and inject them into the 'ran' GeoJSON source. */
  async initSectorFans() {
    const res = await fetch("/data/simulated-ran.geojson");
    if (!res.ok) return;
    const data = (await res.json()) as RanSourceData;
    const combined = {
      type: "FeatureCollection" as const,
      features: [
        ...data.features,
        ...data.features
          .filter((f) => f.geometry.type === "Point" && f.properties.sectors)
          .flatMap((f) => {
            const c = (f.geometry as { coordinates: [number, number] }).coordinates;
            const raw = f.properties.sectors!;
            const list = Array.isArray(raw) ? raw : (JSON.parse(String(raw)) as Sector[]);
            return list.map((s) => ({
              type: "Feature" as const,
              geometry: { type: "Polygon" as const, coordinates: [fanPolygon(c[0], c[1], s)] },
              properties: { site: f.properties.id ?? "?" },
            }));
          }),
      ],
    };
    const apply = () => {
      const src = this.map.getSource("ran") as maplibregl.GeoJSONSource | undefined;
      if (src) src.setData(combined as unknown as GeoJSON.FeatureCollection);
    };
    if (this.map.isStyleLoaded()) apply();
    else this.map.once("load", apply);
  }

  setVisible(on: boolean) {
    this.visible = on;
    this.applyVisibility();
  }

  private applyVisibility() {
    for (const id of RAN_LAYERS) {
      if (this.map.getLayer(id)) {
        this.map.setLayoutProperty(id, "visibility", this.visible ? "visible" : "none");
      }
    }
    this.banner.classList.toggle("hidden", !this.visible);
  }
}
