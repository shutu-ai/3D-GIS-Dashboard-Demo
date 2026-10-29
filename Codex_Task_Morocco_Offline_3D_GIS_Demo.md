# Codex 开发任务：摩洛哥高阿特拉斯山脉离线 3D GIS 地形能力 Demo

> **任务性质**：给 Codex 执行的完整开发提示词，目标是实际可交互的 GIS 功能演示，而不是固定时长影片。  
> **最高优先级**：所有运行时资源本地化，**完全断网、首次启动即可操作**。  
> **独立性**：本任务独立可验收，不依赖 60 秒演示项目；允许共享已经存在且真正离线的地图工具和数据。

## 一、角色与交付目标

你是 WebGIS/MapLibre、地形数据处理、前端交互和移动通信空间分析工程师。请先审阅当前项目中的离线 HTML 看板、PMTiles 地图架构、地名、基站与 50m/100m 网格数据等能力；最大限度复用，新增一个 **Morocco High Atlas — Offline 3D GIS Lab**。

这个 Demo 的主角是 GIS 技术本身，须真实展示：

1. **2D 与 3D 的可交互地形**：旋转、缩放、倾斜、重置视角，真实山体起伏。
2. **高程着色与 Hillshade**：海拔色带、山体阴影、可切换组合。
3. **等高线和海拔数字**：根据 Zoom 动态调整间距，线条上的高度标签必须与 DEM 一致。
4. **山峰、山口与点击海拔查询**：点击地图任何有 DEM 覆盖的位置显示经纬度、原始 DEM 高程、来源/精度说明。
5. **地形剖面与视距分析**：选择 A/B 点，画剖面曲线，标注高差、距离，并提供基于 DEM 的地形 LOS/Fresnel 初步分析；不得冒充精确射频传播预测。
6. **通信业务可视化扩展接口**：基站位置、扇区朝向、道路与模拟覆盖指标可开关，但整体不依赖真实运营商数据库。

目标是一个可以持续扩展进离线看板的 **可维护地形能力模块**，不是视觉噱头或重型 GIS 平台。

## 二、离线要求：绝对硬门禁

1. 完整演示包必须包含 **运行时全部文件**：MapLibre、PMTiles JS、样式 JSON、地图底图 PMTiles、DEM（PMTiles 或等效本地瓦片）、等高线来源、字体 glyphs、图标 sprites、Web Worker、所需 WASM 与 GeoJSON。
2. 禁止运行时访问 `topomap.org`、CDN、OSM 在线瓦片、地图 API、在线 DEM/地理编码/海拔查询 API，以及外部统计上报。UI 内所有点击、切换、查询均不能触发公网调用。
3. 允许通过随包提供的 localhost 静态服务器运行；应正确处理 PMTiles 的 **HTTP Range 请求**，不需要外部 Tile Server 或数据库。
4. 必须提供 Windows 11 一键启动入口和明确的部署目录，可复制至无互联网的目标 PC 从冷启动使用；不能依赖首次联网、浏览器预存瓦片、外部字体或开发机全局环境。
5. 开发期允许准备数据时联网获取合法公开数据；**最终分发的离线包必须自带完整目标区域数据**，不能首次打开再下载。
6. 缺失数据不能静默 fallback 到公网。若本地 DEM 范围不足，应显示明确的 `Out of offline coverage`，不能显示假的 3D 地形或错误海拔。
7. 若需要真实无线覆盖数据而仓库未提供，使用明确标注的 `SIMULATED / 演示数据`，且对外演示的地图始终明显区分真实 GIS 数据与模拟通信数据。

## 三、地理范围与 DEM 数据条件

- 地区：Morocco / High Atlas / Toubkal / Tizi n’Tichka。
- 建议初始范围：`BBOX [-8.2, 30.9, -7.1, 31.5]`；裁剪以覆盖真实景区、山口道路、镜头移动和必要缓冲为准。
- 建议中心与初始相机：根据目标数据自动计算，不要用硬编码造成启动画面指向无瓦片位置。
- 数据选型：优先 Copernicus DEM GLO-30 或法律许可兼容的同等级高程数据，保留 provenance、垂直基准和名义分辨率；底图优先本地 OSM 衍生的矢量 PMTiles；保留必要署名。
- DEM 编码：Mapbox Terrain-RGB 或 Terrarium 均可，但必须在读取时使用**匹配的 encoding、tileSize、zoom 范围与瓦片元数据**；不能假设所有 DEM PMTiles 都是 512px。
- 原始 GIS 分辨率与视觉展示独立：缩放到 50m 并不意味着 30m DEM 就能产生可信的 10m 等高线。明确展示“数据分辨率/估算值”，防止伪精确。
- 海拔可能采用不同垂直基准；界面标注 `DEM elevation (m)` 和数据来源，未经确认不要把所有读数宣称为测量级正高。

## 四、界面组成与交互清单

### A. 三维主地图（P0）

- MapLibre GL JS，宽屏大地图为中心；支持 Orbit/旋转、Zoom、Tilt/Pitch、Fly-to、复位。
- `2D / 3D` 切换；3D 倾斜角可调（建议 0–70°，以引擎允许范围为准）。
- 地形视觉夸张倍数：`1.0 / 1.2 / 1.5`，默认 1.2；界面明确说明“仅视觉，不改变原始海拔数值”。
- 支持高程着色、hillshade、道路/地名、山峰海拔/山口标记等图层独立开关。
- 坐标与视角可以复制/保存到本地链接参数（不访问公网），便于复现实验场景。

### B. 真实等高线及海拔标注（P0）

- 等高线线条与数字沿线自动标注，显示单位 `m`，对文字使用可读的 halo。
- 默认按缩放级别选择等高线间隔：Zoom 5–8 为约 500m、9–11 为 100m、12–13 为 50m；更细间隔必须根据实际 DEM 的分辨率评估并可关闭。
- 主等高线更粗，数值标签避免密集重叠；字体、颜色、线宽与其他图层协调。
- 推荐优先考虑 **预生成离线矢量 contour PMTiles**（运行轻、稳定）或 **本地 DEM + maplibre-contour**（灵活、动态）；二选一，必须证明冷启动断网生效。若选后者，确保 worker、DEM URL、邻瓦片请求和解码器均是本地资源。
- 支持等高线图层的开关及间隔预设，不能切换后残留旧标签、旧缓存或数据源泄漏。

### C. 海拔查询与地形剖面（P0/P1）

- 单点点击：显示经纬度（小数度）、原始 DEM 高程（m）、DEM 来源；无数据返回 `No DEM data`。
- 两点剖面：用户选择 A 点/B 点，沿地表采样并绘制距离–海拔折线，显示水平距离、海拔变化、最大/最小值，地图上同步高亮剖面线。
- 采样精度由 DEM 实际分辨率决定，不能靠插值伪造更高精度；大段剖面需抽样与异步计算避免卡死 UI。
- **可选**地形视距：先仅做基于 DEM + 站/终点天线高度的几何 LOS，并标注“terrain-only approximation”；Fresnel 净空在频率参数明确后计算，不能将 LOS 与 RSRP/覆盖预测直接画等号。
- 3D `exaggeration` 不得影响海拔查询、剖面原始高程及 LOS 判断。不要直接将受地形夸张影响的渲染高程作为原始 DEM 高程。

### D. 地形与无线网络叠加（P1）

- 本地 GeoJSON 的站点、扇区或扇形（基于经纬度、方位角、角宽、演示半径）可单独开关。
- 支持基站悬浮/点击面板：站点 ID、经纬度、站址海拔、模拟天线挂高、频段、扇区方向等。
- 一条真实来源道路上的模拟 RSRP 颜色分段（建议标注 dBm），必须和地形高程色带使用独立图例。
- 可以选取一个点，查看“附近基站候选 + 地形剖面 + 弱覆盖风险提示”；不声称已建立工程级无线传播模型。
- 为未来 50m/100m 网格、MR、路测数据预留 GeoJSON/矢量瓦片数据接口，但本 Demo **不要求**连接 SmartCare 生产数据库，也不改动现有业务数据链路。

### E. 演示辅助面板（P0）

- 预置 Fly-to 场景：`Toubkal Peak`、`High Atlas Ridges`、`Tizi n’Tichka Pass`、`Mountain Road`。
- 海拔色标和图层控制面板可以折叠，不遮挡中央山谷和峰顶。
- 明确显示 `OFFLINE GIS DEMO`、数据来源、数据分辨率/垂直基准（若已知），模拟无线图层开启时显示 `SIMULATED NETWORK DATA`。
- 全屏和 Reset View；页面在 1920×1080 和 1366×768 下功能可用，视觉质量优先。

## 五、非目标与质量边界

- 不开发全功能无线规划平台（不做复杂 3GPP 射线追踪、校准传播模型、自动站址优化）。
- 不接入真实在线地图、地理编码、高程 API、外部账户或商业 SDK。
- 不把建筑物高度当成 DEM 地形高度；本 Demo 主要表现山地区域，不强制使用 3D Buildings。
- 不允许使用随机形状或 AI 图像替代可查询、可绘制等高线的真实 DEM。
- 不做精确射频预测结论；LOS、剖面只是辅助观察，需要额外 RF 工参/地物/传播模型才能得出工程结论。
- 不因极端安全设计、多层审批、账号/RBAC、微服务而牺牲简单的离线展示性能。

## 六、建议架构与目录

优先沿用当前仓库工具栈，如已有 Vue/Vite 或原生 HTML 都可以，选择最小可维护实现；MapLibre/PMTiles 是优先路径，不强制引入 Three.js 或 Cesium。

```text
demos/morocco-offline-gis/
  README.md
  DATA_SOURCES_AND_LICENSES.md
  src/
    main.ts
    map/map.ts
    map/terrain.ts
    map/contours.ts
    map/elevation-query.ts
    map/profile.ts
    map/ran-overlay.ts
    ui/controls.ts
  public/
    data/basemap.pmtiles
    data/terrain-dem.pmtiles
    data/contours.pmtiles          # 如选择预生成等高线
    data/roads-peaks.geojson
    data/simulated-ran.geojson
    assets/fonts/...
    assets/sprites/...
  scripts/
    prepare-data.*
    validate-data.*
    verify-offline.*
  start-offline.bat
  start-offline.ps1
  dist/                            # 独立可复制的完整离线发布包
  Docs/Acceptance.md
  Docs/Architecture.md
```

技术注意事项：

- PMTiles JS Protocol 应注册一次；本地服务器应支持 Range/206 响应；确保同源部署。
- 对 DEM/底图/等高线执行元数据验证，检查 TileJSON/source-layer/encoding/extent，不接受“打开网页没报错就算对”的实现。
- 若 `maplibre-contour` 无法直接读取所选 DEM PMTiles，明确采用本地等效瓦片端点、预生成矢量瓦片或兼容 adapter；必须实测，不假设可直接通用。
- GIS 图层和控件采用模块化配置，后续能嵌入已有业务看板，不把全局变量塞进单个庞大 HTML 中。
- 发布结果应可以在企业内网/离线笔记本通过 `127.0.0.1` 独立演示，不要求 Docker、PostGIS 或公网许可证。

## 七、执行阶段

### Phase 0 — 现有仓库与资源审计

1. 检查现有地图引擎及版本、PMTiles、字体、底图、图层和离线运行方式。
2. 查明是否有可复用的摩洛哥数据；不可拿马里/埃及 PMTiles 假装覆盖摩洛哥。
3. 明确最终交付架构，列明必须新增资源的容量、来源与许可。

### Phase 1 — 真实 GIS 数据加工与离线打包

1. 获取合法来源 DEM、底图、山口/道路/山峰；裁剪到选定区域并适当加缓冲。
2. 根据实际格式制作 terrain DEM PMTiles 或本地 DEM tiles，生成/准备等高线。
3. 将所有引用资源本地化，检查 glyph/sprite，去除绝对路径和远程 URL。
4. 做文件大小、瓦片覆盖范围、编码、数据空洞检查。

### Phase 2 — 核心 3D 与高程标注

1. 地形 2D/3D、hillshade、hypsometric tint、图层切换。
2. 等高线、主次线、沿线海拔数字、山峰海拔标识。
3. 单点高程查询，核对渲染值与原始 DEM 值在视觉夸张下仍分离。

### Phase 3 — GIS 分析与通信叠加

1. A/B 两点高程剖面、距离和高程统计；可选地形 LOS。
2. 站点、扇区、模拟道路 RSRP 热力线、业务信息面板。
3. Fly-to 预置地点、信息图例、控制面板、适配大屏。

### Phase 4 — 断网工程验收

1. 构建完整独立 `dist/` 包和一键启动脚本（依赖随包）。
2. 采用空浏览器 profile/清缓存和禁止外网请求进行测试。
3. 实测不同 zoom、pitch、地形夸张、等高线间隔、等高线图层切换、高程查询和剖面。
4. 使用 Playwright（或已有工具）完成截图与 E2E 回归，生成报告。

## 八、明确的验收标准

### OFFLINE（任何一项不通过都不能标记 READY）

- [ ] 完整离线包在首次启动、外网不可用的情况下打开并显示真实地形。
- [ ] 所有资源请求仅指向本机，外部域名请求次数 **0**（包含脚本、字体、地图、Worker、遥测）。
- [ ] 本地 PMTiles Range 测试通过，地形不同 zoom 均有可用瓦片。
- [ ] 清空浏览器缓存后无 CDN 请求或隐性热缓存依赖。
- [ ] 不要求现场联网安装包或登录商业服务。

### GIS

- [ ] 可旋转、倾斜、缩放并切换 2D/3D；地形具有真实高差。
- [ ] 高程着色及山体阴影能够独立启用/关闭；海拔色标有单位。
- [ ] Zoom 变化时等高线与海拔数字合理改变密度，不出现大量重叠/乱码。
- [ ] 点选山峰、山口或普通地表时能读取 DEM 高程（不是模拟随机值）。
- [ ] 设置 `exaggeration=1.0` 与 `1.5` 时，相同点的海拔查询数值应一致（仅视觉高度变化）。
- [ ] 选择两个点可查看地形剖面、距离和高差；数值与 DEM 采样一致，超范围清晰报错。
- [ ] 基站/RSRP 叠加可显示/隐藏并且明确为模拟无线数据。
- [ ] Fly-to 4 个场景坐标落在离线数据覆盖范围内。

### 质量与证据

- [ ] 1920×1080、1366×768 视觉检查通过；截图包含地形、等高线、高程查询、剖面、无线图层。
- [ ] 记录代表性机器的启动时间、交互帧率与内存表现；不硬编未经实测的性能数字。
- [ ] 关键自动化用例通过（至少冷启动、网络请求阻断、2D/3D、等高线、高程查询、剖面、模拟数据开关）。
- [ ] 报告数据来源、许可、版本、DEM 基准/精度说明及已知限制。

## 九、交付件和完成报告

请交付：

1. 完整可运行源码和独立离线发布目录。
2. Windows 一键启动脚本，以及极简服务器组件或可打包的本地服务程序（支持 Range）。
3. `README.md`：断网启动、控制说明、效果预览截图、常见问题。
4. `DATA_SOURCES_AND_LICENSES.md`：地图/DEM/OSM/字体/图标来源、署名与许可。
5. `Docs/Architecture.md`：数据格式与模块说明，后续如何嵌入现有离线看板。
6. `Docs/Acceptance.md`：真实测试结果、网络审计、截图路径、已知问题。

完成后按以下格式报告：

```text
IMPLEMENTATION=PASS|PARTIAL|BLOCKED
OFFLINE_RUNTIME=PASS|FAIL|NOT_VERIFIED
COLD_START=PASS|FAIL|NOT_VERIFIED
REAL_DEM_INCLUDED=YES|NO
EXTERNAL_REQUESTS=<count>
PMTILES_RANGE=PASS|FAIL|NOT_VERIFIED
TERRAIN_3D=PASS|FAIL|NOT_VERIFIED
CONTOURS_AND_LABELS=PASS|FAIL|NOT_VERIFIED
ELEVATION_QUERY=PASS|FAIL|NOT_VERIFIED
PROFILE=PASS|FAIL|NOT_VERIFIED
RAN_OVERLAY=PASS|FAIL|NOT_VERIFIED
E2E_TESTS=<passed>/<total>
PACKAGE_PATH=<relative/path>
KNOWN_GAPS=<none or list>
```

严格区分“写完代码”“功能实测通过”“断网冷启动通过”。没有真实离线数据或没有断网测试，不得写 `OVERALL READY`。优先实现可靠、清晰、可维护的最小 GIS 价值闭环，再添加可选效果。
