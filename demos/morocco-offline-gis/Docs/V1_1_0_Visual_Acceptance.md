# v1.1.0 视觉升级验收报告 — 真实 DEM + 自然三维 + 完全离线

产品：`demos/morocco-offline-gis`（Morocco High Atlas · Offline 3D GIS Lab）
基线：v1.0.0 ｜ 分支：`feat/v1.1.0-real-dem-visual-upgrade` ｜ 代码终版 commit：`66d385d`
验收日期：2026-10-30 ｜ 机器可读版：`Docs/V1_1_0_Acceptance.json`

---

## 1. 门禁总览

| 门禁 | 内容 | 结果 |
|---|---|---|
| G0 | v1.0.0 基线复测 + RCA | **PASS**（validate 43/43、Playwright 16/16、Range 206、v1 包 185,080,026 B；`V1_1_0_Visual_RCA.md`） |
| G1 | 真实 DEM 获取/合法/防回退 | **PASS**（validate 真实模式 **99/99**；解码误差 2.48 m；接缝 0.27/0.65 m；抗回退 0/7 失败） |
| G2 | 自然三维人眼复核 | **PASS**（第三轮 12/12 全 PASS：标签双绘/05 覆盖缺口/03 直线接缝全部消除——根因为自产 SDF 字形图集损坏，Euclidean EDT 修复；4 项 minors 不阻断，见 `V1_1_0_Design_Debt.md`） |
| G3 | 等高线/分层设色/标签一致性 | **PASS**（MVT 编码器规格 bug 修复——v1.0.0 等高线从未真正渲染；e2e 渲染断言守护；图例 15 档 == 真实 LUT） |
| G4 | 断网冷启动 / Range 206 / 外部请求 0 | **PASS**（`verify-offline.ps1 -Port 17842`：Range 206 PASS、**Playwright 24/24 (4.9 min, D3D11)**、外部请求 0、exit 0） |
| G5 | 文档/许可/截图/离线包 | **PENDING**（等 G2 结论；包已制好，哈希见 §5） |

## 2. 真实 DEM 数据（G1）

- 产品：**Copernicus DEM GLO-30**（30 m，EPSG:4326，EGM2008 垂直基准），6 幅 1° COG，AWS Open Data（合法开放数据）。
- 源哈希：`data_sources/copernicus-glo30/SHA256SUMS.txt`（6 条，随库提交）；原始 TIF 不入库（体积），可由 MANIFEST 记录的 URL 复原。
- 交付档案：`dem-terrarium.pmtiles` 208,401,064 B，SHA256 `0A348CA3863959023A7EE742FF69FD0AF444B9E8A5E9C9AD15939DC0C6D06C0B`，z7–12，9 级金字塔。
- 峰标注 reconcile（有序 claim-pass：互斥区 + DEM 阈值门控 + `target_ele` 最近标称吸附；`ele`=公开标称 / `dem_ele`=DEM 采样分离，附 `snap_offset_m`）：

| 名称 | ele | dem_ele | 差 | 吸附偏移 |
|---|---|---|---|---|
| Jbel Toubkal | 4167 | 4154 | −13 | 252 m |
| Jbel Ouanoukrim | 4089 | 4087 | −2 | 2510 m |
| Aksoual | 3910 | 3796 | −114 | 3313 m |
| Jbel Aguelzim（由讹名 "Iguelzoum 3600" 更名） | 3547 | 3547 | ±0 | 749 m |
| Adrar n'Dern | 3000 | 3102 | +102 | 1492 m |
| Tizi n'Tichka（垭口/路站，保留原地） | 2260 | 2062 | −198 | — |
| Tizi n'Tamatert | 2250 | 2250 | ±0 | 2476 m |

详录：`Docs/V1_1_0_Real_DEM_Pipeline.md`（§4 规则 / §5 QA 表 / §6 / §8）。

## 3. 离线验收运行（G4）与验收期修复

- Runner：`scripts/verify-offline.ps1 -Port 17842`（非 localhost 全部拦截 + 全新浏览器 profile + PMTiles Range 206 门禁）。
- 结果：**24/24 Playwright 通过（4.9 分钟，headless Chromium 以 ANGLE D3D11 真 GPU 渲染；SwiftShader 时代为 17.5-22 分钟）+ Range 206 PASS + 外部请求 0 + exit 0**，运行日期 2026-10-30（字形修复后终验收 11:37-11:42）。
- E2E 就绪驱动化（真实 DEM 瓦片 ~0.5 MB/个，软渲染冷启动地形高程可用需 ~40–50 s；固定 sleep 会与加载竞态）：
  - `waitTerrainReadyAt`：投影/点击前等待目标点地形解码（v5 raycast 在夸张网格上，预先投影会漂移数公里）。
  - 海拔查询断言用 `map.fire('click', {lngLat})` 确定性触发，跨 exaggeration **严格相等**。
  - **`trackTileTraffic`**：Node 侧瓦片网络流量静默作为截图就绪信号——`map.areTilesLoaded()` 在软渲染下飞行后恒 false（内部有永挂 pending 瓦片，探针实证），不可用。
- 验收期发现并修复的产品缺陷（均在最终 dist 内，随 24/24 验收）：
  1. **RAN 图层 boot 竞态**（红线级）：RAN 关闭时 RSRP 路段+站址仍可见（模拟层脱离 SIMULATED 横幅）。根因：`RanOverlay` 构造时 `load` 事件已错过，隐藏逻辑从未执行。修复：`getLayer` 门控重试 + `load` 事件双保险（`66d385d`）。⚠️ 探针实证：style 级 `visibility:"none"` 会使 MapLibre v5 完全跳过 GeoJSON 源处理且 setData/setLayoutProperty 均无法恢复——图层保持 visible-in-style，勿回退。
  2. **剖面 A 点海拔后缀被覆盖**：`profileAEle` 独立状态修复（`c6a930c`）。
- 已知软渲染特性（非缺陷，记录）：隐藏图层的 GeoJSON 源在 toggle 显示后需 ~10–20 s 补做瓦片处理（软件 GL）；真实 GPU 环境无此延迟。e2e 轮询已放宽至 45 s。

## 4. 截图（G2 证据）

`Docs/screenshots/v1.1.0/`，12 张 = 6 场景 × {1920×1080, 1366×768}，字形修复后终验收运行产出（2026-10-30 11:41-11:44，D3D11）：
01 Toubkal 3D ｜ 02 High Atlas 山脊 3D ｜ 03 Tizi n'Tichka 3D（RAN 关，**必须无任何模拟要素**）｜ 04 2D 总览+等高线 ｜ 05 模拟 RAN 叠加（必须显示 SIMULATED NETWORK DATA 横幅）｜ 06 剖面查询结果卡。

截图复核历史：
1. 第一轮 FAIL（05 号伪影）→ 证为捕获时机问题，修复捕获流程（trackTileTraffic）。
2. 第二轮 FAIL 3 blocker（标签双绘 12/12、05 覆盖缺口、03 直线接缝）→ 探针链定性为**自产 SDF 字形图集损坏**（生成器 Chebyshev 距离场；SwiftShader 环境缺陷定性已证伪——用户硬件加速 Chrome 与 Intel D3D11 同样复现），修复：`glyphs.py` 换精确欧几里得 EDT 重生成图集（`V1_1_0_Visual_RCA.md` §5）。
3. 第三轮（本轮）：字形修复后 12 张全新截图，designer 人眼复核 **PASS**——12/12 全 PASS + 18 处放大裁剪验证：标签全部干净单份（无半字符错位叠印/方括号鬼影）、05 RSRP 走廊连续无亮斑、03 直线接缝消失；整体质感无回归。4 项 minors 不阻断（D1 改述为标记压标签、D2 减轻、D3 保留、D5 新增：3D 俯仰视角标签淡显过度），见 `Docs/V1_1_0_Design_Debt.md`。

v1.0.0 截图历史保持原样未改动（新截图只写 v1.1.0 目录）。复核放行的 minors 见 `Docs/V1_1_0_Design_Debt.md`。

## 5. Windows 离线发行包（G5）

- 文件：`releases/Morocco-High-Atlas-Offline-GIS-v1.1.0.zip`（`dist\` 为根，同 v1 格式）
- 字节数：**241,937,813**（v1.0.0：185,080,026，Δ +56,857,787 — 真实 DEM 数据增量）
- SHA256：`F7707B03F98A1F80E01C83949E247B5760F9E83FF08BCED274B7EDB0771B03AB`
- 包内 bundle：`dist/assets/index-CCW3BZ-u.js`（= 24/24 全绿验收所运行的产物）；`VERSION.txt`：built 2026-10-30 06:39:13, commit c6a930c（数据管线提交；构建树同时包含 RAN 修复与 e2e 改动，已提交为 66d385d，与构建包内容一致）
- 使用：解压后运行 `start-offline.bat`（127.0.0.1:17841，端口占用时自动回退）

## 6. §11 最终执行报告（固定格式）

```text
BASELINE_TAG=v1.0.0
WORK_BRANCH=feat/v1.1.0-real-dem-visual-upgrade
HEAD=66d385d
REAL_DEM=YES
DEM_PRODUCT=Copernicus DEM GLO-30 (30 m, EPSG:4326, 6x1deg COG, AWS Open Data)
DEM_SOURCE_SHA256=data_sources/copernicus-glo30/SHA256SUMS.txt; shipped dem-terrarium.pmtiles=0A348CA3863959023A7EE742FF69FD0AF444B9E8A5E9C9AD15939DC0C6D06C0B
DEM_VERTICAL_DATUM=EGM2008
TERRAIN_RENDER=PASS
CONTOUR_LABELS=PASS
MAP_BOUNDARY_SCENES=PASS
ELEVATION_QUERY=PASS
PROFILE_LOS=PASS
SIMULATED_RAN=PASS
OFFLINE_COLD_START=PASS
EXTERNAL_REQUESTS=0
PMTILES_RANGE_206=PASS
DATA_VALIDATION=99/99
PLAYWRIGHT=24/24
SCREENSHOT_REVIEW=PENDING
DIST_SIZE_BYTES=241937813
RELEASE_READY=PENDING
BLOCKERS=none known (G2 round-2 review in flight)
```

> 发布权限说明：push tag / 创建 GitHub Release 均未执行，需用户明确授权。
