/** UI wiring: panels, buttons, legends, mode switching. */

import type { Map as MLMap } from "maplibre-gl";
import { LAYER_IDS, type AppMetadata } from "../config";
import { MapApp } from "../map/map";
import type { TerrainControl } from "../map/terrain";
import type { ContourControl } from "../map/contours";
import { computeProfile, drawProfileChart, type ProfileInput } from "../map/profile";
import { sampleElevation } from "../map/elevation-query";

export type Mode = "query" | "profile";

export class Controls {
  mode: Mode = "query";
  private profilePoints: Array<{ lng: number; lat: number }> = [];
  private lastProfileInput: ProfileInput | null = null;

  constructor(
    private map: MLMap,
    private app: MapApp,
    private meta: AppMetadata,
    private terrainCtl: TerrainControl,
    private contourCtl: ContourControl,
    private onRanToggle: (on: boolean) => void,
  ) {
    this.wireTopbar();
    this.wireViewGroup();
    this.wireScenes();
    this.wireLayers();
    this.wireAnalysis();
    this.buildLegends();
    this.wireMapClick();
  }

  // ------------------------------------------------------------------ topbar
  private wireTopbar() {
    document.getElementById("btn-fullscreen")?.addEventListener("click", () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen();
    });
    document.getElementById("btn-reset")?.addEventListener("click", () => this.app.resetView());
    document.getElementById("btn-copy-view")?.addEventListener("click", async (e) => {
      this.app.writeHash();
      const btn = e.target as HTMLButtonElement;
      try {
        await navigator.clipboard.writeText(location.href);
        btn.textContent = "已复制 ✓";
      } catch {
        btn.textContent = "链接在地址栏";
      }
      setTimeout(() => (btn.textContent = "复制视图链接"), 1600);
    });
    // panel collapse
    document.querySelectorAll<HTMLButtonElement>(".btn-collapse").forEach((b) => {
      b.addEventListener("click", () => {
        const el = document.getElementById(b.dataset.target!);
        el?.classList.toggle("collapsed");
        b.textContent = el?.classList.contains("collapsed") ? (el.id === "panel-left" ? "›" : "‹") : el!.id === "panel-left" ? "‹" : "›";
      });
    });
  }

  // -------------------------------------------------------------- view group
  private wireViewGroup() {
    const b2 = document.getElementById("btn-2d")!;
    const b3 = document.getElementById("btn-3d")!;
    b2.addEventListener("click", () => {
      this.terrainCtl.set3d(false);
      b2.classList.add("active");
      b3.classList.remove("active");
    });
    b3.addEventListener("click", () => {
      this.terrainCtl.set3d(true);
      b2.classList.remove("active");
      b3.classList.add("active");
    });
    const slider = document.getElementById("pitch-slider") as HTMLInputElement;
    const pv = document.getElementById("pitch-val")!;
    slider.addEventListener("input", () => {
      pv.textContent = `${slider.value}°`;
      this.terrainCtl.setPitch(+slider.value);
    });
    this.map.on("pitch", () => {
      const p = Math.round(this.map.getPitch());
      pv.textContent = `${p}°`;
      slider.value = String(p);
    });
    document.querySelectorAll<HTMLButtonElement>(".seg.ex").forEach((b) => {
      b.addEventListener("click", () => {
        document.querySelectorAll(".seg.ex").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        this.terrainCtl.setExaggeration(+b.dataset.ex!);
        this.app.writeHash();
      });
    });
  }

  // ------------------------------------------------------------------ scenes
  private wireScenes() {
    const host = document.getElementById("scenes")!;
    for (const s of this.meta.scenes) {
      const b = document.createElement("button");
      b.textContent = s.name;
      b.title = `Fly to ${s.name}`;
      b.addEventListener("click", () => this.app.flyToScene(s.name));
      host.appendChild(b);
    }
  }

  // ------------------------------------------------------------------ layers
  private wireLayers() {
    const setLayer = (ids: readonly string[], on: boolean) => {
      for (const id of ids) {
        if (this.map.getLayer(id)) this.map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
      }
    };
    document.getElementById("ly-hypso")?.addEventListener("change", (e) => {
      setLayer([LAYER_IDS.hypso], (e.target as HTMLInputElement).checked);
    });
    document.getElementById("ly-hillshade")?.addEventListener("change", (e) => {
      setLayer([LAYER_IDS.hillshade], (e.target as HTMLInputElement).checked);
    });
    document.getElementById("ly-contours")?.addEventListener("change", (e) => {
      this.contourCtl.setVisible((e.target as HTMLInputElement).checked);
    });
    document.getElementById("ly-osm")?.addEventListener("change", (e) => {
      const on = (e.target as HTMLInputElement).checked;
      setLayer(
        [
          LAYER_IDS.roads,
          LAYER_IDS.roadsCasing,
          LAYER_IDS.peaks,
          LAYER_IDS.peakLabels,
          LAYER_IDS.places,
          LAYER_IDS.placeLabels,
          "osm-passes",
          "osm-pass-labels",
        ],
        on,
      );
    });
    document.getElementById("ly-ran")?.addEventListener("change", (e) => {
      const on = (e.target as HTMLInputElement).checked;
      this.onRanToggle(on);
      document.getElementById("legend-ran")?.classList.toggle("hidden", !on);
    });
  }

  // ---------------------------------------------------------------- analysis
  private wireAnalysis() {
    const bq = document.getElementById("btn-mode-query")!;
    const bp = document.getElementById("btn-mode-profile")!;
    bq.addEventListener("click", () => this.setMode("query"));
    bp.addEventListener("click", () => this.setMode("profile"));
    document.getElementById("btn-clear-profile")?.addEventListener("click", () => {
      this.profilePoints = [];
      this.lastProfileInput = null;
      this.updateProfileSource();
      document.getElementById("profile-status")!.textContent = "依次点击地图选择 A、B 两点";
      document.getElementById("profile-stats")!.innerHTML = "";
      document.getElementById("los-result")!.innerHTML = "";
      const c = document.getElementById("profile-chart") as HTMLCanvasElement;
      c.getContext("2d")?.clearRect(0, 0, c.width, c.height);
    });
    const recompute = () => {
      if (this.lastProfileInput) void this.runProfile({ ...this.lastProfileInput });
    };
    document.getElementById("ant-a")?.addEventListener("change", recompute);
    document.getElementById("ant-b")?.addEventListener("change", recompute);
    document.getElementById("los-freq")?.addEventListener("change", recompute);
  }

  setMode(m: Mode) {
    this.mode = m;
    document.getElementById("btn-mode-query")?.classList.toggle("active", m === "query");
    document.getElementById("btn-mode-profile")?.classList.toggle("active", m === "profile");
    document.getElementById("query-card")?.classList.toggle("hidden", m !== "query");
    document.getElementById("profile-card")?.classList.toggle("hidden", m !== "profile");
    document.getElementById("app")?.classList.toggle("selecting", m === "profile");
  }

  // -------------------------------------------------------------- map clicks
  private wireMapClick() {
    this.map.on("click", async (e) => {
      const { lng, lat } = e.lngLat;
      if (this.mode === "query") {
        const out = document.getElementById("query-result")!;
        out.innerHTML = `<span class="k">采样中…</span>`;
        const r = await sampleElevation(lng, lat, this.meta.dem.zooms[0], this.meta.dem.zooms[1]);
        const src = `<div class="k">DEM: SIMULATED terrain · terrarium · ~30 m nominal · ${this.meta.dem.vertical_datum}</div>`;
        if (r.status === "ok") {
          out.innerHTML = `
            <div><span class="k">经纬度</span> ${lat.toFixed(5)}, ${lng.toFixed(5)}</div>
            <div><span class="k">DEM elevation</span> <span class="val">${r.elevation.toFixed(1)} m</span></div>
            <div><span class="k">采样</span> nearest-pixel（无插值）</div>
            ${src}`;
        } else if (r.status === "out-of-coverage") {
          out.innerHTML = `<div class="warn">Out of offline coverage</div><div class="k">该位置不在离线 DEM 覆盖范围内</div>`;
        } else {
          out.innerHTML = `<div class="warn">No DEM data</div>`;
        }
      } else {
        await this.addProfilePoint(lng, lat);
      }
    });
  }

  private async addProfilePoint(lng: number, lat: number) {
    if (this.profilePoints.length >= 2) {
      this.profilePoints = [];
    }
    this.profilePoints.push({ lng, lat });
    this.updateProfileSource();
    const status = document.getElementById("profile-status")!;
    if (this.profilePoints.length === 1) {
      status.textContent = "已选 A 点，请点击 B 点";
      const r = await sampleElevation(lng, lat);
      if (r.status === "ok") status.textContent += `（A: ${r.elevation.toFixed(0)} m）`;
    } else {
      status.textContent = "计算剖面中…";
      await this.runProfile();
    }
  }

  private async runProfile(override?: ProfileInput) {
    const [a, b] = this.profilePoints;
    if (!a || !b) return;
    const input: ProfileInput =
      override ?? {
        a: { ...a, antHeightM: +(document.getElementById("ant-a") as HTMLInputElement).value },
        b: { ...b, antHeightM: +(document.getElementById("ant-b") as HTMLInputElement).value },
        freqMHz: +(document.getElementById("los-freq") as HTMLSelectElement).value,
      };
    this.lastProfileInput = input;
    const result = await computeProfile(input, (f) => {
      document.getElementById("profile-status")!.textContent = `计算剖面中… ${(f * 100) | 0}%`;
    });
    document.getElementById("profile-status")!.textContent = `A → B 剖面完成`;
    const canvas = document.getElementById("profile-chart") as HTMLCanvasElement;
    drawProfileChart(canvas, result, input);

    const km = result.distanceM / 1000;
    const stats = document.getElementById("profile-stats")!;
    stats.innerHTML = `
      <div><span class="k">水平距离</span> <span class="val">${km.toFixed(2)} km</span></div>
      <div><span class="k">海拔范围</span> ${result.minElev?.toFixed(0) ?? "-"} ~ ${result.maxElev?.toFixed(0) ?? "-"} m</div>
      <div><span class="k">累计爬升/下降</span> +${result.ascentM} / -${result.descentM} m</div>
      ${result.outOfCoverage > 0 ? `<div class="warn">${result.outOfCoverage} 个采样点超出离线覆盖</div>` : ""}`;

    const los = document.getElementById("los-result")!;
    const clear = result.worstClearanceM;
    const fres = result.fresnelRadiusM;
    los.innerHTML = `
      <div>LOS: ${result.blocked ? `<span class="warn">受地形阻挡 (terrain-only)</span>` : `<span style="color:var(--ok)">视距通畅 (terrain-only approximation)</span>`}</div>
      <div><span class="k">最小净空</span> ${clear === null ? "-" : `${clear > 0 ? "+" : ""}${clear} m`}</div>
      <div><span class="k">1st Fresnel (中点)</span> ${fres === null ? "-" : `${fres} m @ ${input.freqMHz} MHz`}</div>
      <div class="k" style="margin-top:4px">几何视距近似，非 RSRP/覆盖预测</div>`;
  }

  private updateProfileSource() {
    const feats: Array<GeoJSON.Feature> = [];
    const [a, b] = this.profilePoints;
    if (a && b) {
      feats.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: [[a.lng, a.lat], [b.lng, b.lat]] },
        properties: { role: "line" },
      });
    }
    for (const p of this.profilePoints) {
      feats.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [p.lng, p.lat] },
        properties: { role: "point" },
      });
    }
    const src = this.map.getSource("profile") as maplibregl.GeoJSONSource | undefined;
    src?.setData({ type: "FeatureCollection", features: feats });
  }

  // ----------------------------------------------------------------- legends
  private buildLegends() {
    const bar = document.getElementById("legend-hypso")!;
    const legend = this.meta.hypso.legend;
    legend.forEach((s, i) => {
      const next = legend[i + 1]?.elev_m ?? s.elev_m + 100;
      const div = document.createElement("div");
      div.style.background = s.color;
      div.style.flex = String(next - s.elev_m);
      div.title = `${s.elev_m} m`;
      bar.appendChild(div);
    });
    const ticks = document.createElement("div");
    ticks.className = "legend-ticks";
    ticks.innerHTML = `<span>${legend[0]!.elev_m}</span><span>${legend[Math.floor(legend.length / 2)]!.elev_m}</span><span>${legend[legend.length - 1]!.elev_m}+</span>`;
    bar.after(ticks);

    const ran = document.getElementById("legend-ran")!;
    const stops: Array<[number, string]> = [
      [-140, "#c0392b"],
      [-120, "#e07840"],
      [-105, "#d8c34a"],
      [-90, "#7dbb5a"],
      [-75, "#3f9e6f"],
      [-60, "#2e8b8b"],
    ];
    ran.innerHTML = stops.map(([, c]) => `<div style="background:${c}"></div>`).join("");
    const t2 = document.createElement("div");
    t2.className = "legend-ticks";
    t2.innerHTML = `<span>-140 dBm</span><span>-100</span><span>-60 (SIMULATED RSRP)</span>`;
    ran.after(t2);
  }

  /** Contour interval indicator callback. */
  setContourInterval(m: number | null) {
    const el = document.getElementById("contour-interval")!;
    el.textContent = m ? `间隔 ${m} m` : "";
  }
}
