# V1.2.0 RAN 覆盖可视化 — 现状 RCA 与小范围架构审查

> 任务：Offline 3D RAN Coverage Visualization（v1.2.0）G0 交付物
> 基线：v1.1.0（tag `v1.1.0`，发布提交 `e0e370c`，main merge `70ba084`）
> 分支：`feat/v1.2.0-offline-ran-coverage-visualization`
> 结论先行：v1.1.0 的 RAN 图层是**"开/关"式的最小叠加**——四个图层（扇区/RSRP 道路/站点/站名）没有视觉权重系统、没有选择状态、不与剖面分析联动，且默认样式对比度不足以穿透密集地形纹理。这不是渲染缺陷，而是 v1.1.0 范围内 RAN 只是"存在性验证"（诚实标识 + boot 竞态修复），v1.2.0 要把它升级为"业务表达层"。

---

## 1. 现状证据 → 根因定位（对应用户三张 v1.1.0 截图的六个观察）

### 观察 1：地形纹理与白色等高线占据主要视觉注意力
- **代码证据**（`src/map/map.ts` buildStyle）：
  - `contour-lines`（minor）：`rgba(235,215,170,0.5)`，宽 z8:0.7→z13:1.1（L348-357）
  - `contour-lines-major`：`rgba(240,220,175,0.85)`，宽 z8:1.2→z13:2.0（L359-369）
  - `hillshade`：exaggeration 0.35，高光 `#f5f2e8`（近白）（L331-345）
  - `hypso-tint`：raster-opacity 1.0（L321-330）
- **根因**：RAN 开启时底图亮度/纹理密度不变。站点符号（半径 5-8px、单色 #6ab0f3）与等高线+山体阴影的像素能量对比为 1:N（数百条线段 vs 9 个点）。
- **影响面**：ranSectors / ranRsrp / ranSites / ranSiteLabels 四层全部；v1.2.0 需要模式化底图减淡（GIS/RAN 双模式），而非逐层 setPaintProperty 散落修补。

### 观察 2：模拟站点只是小蓝点，站名小，不易找到基站
- **代码证据**：
  - `ran-sites`：circle-radius interpolate z9:5→z13:8，纯色 #6ab0f3，描边 #12324f（map.ts L603-614）
  - `ran-site-labels`：minzoom **11**、text-size **9.5**、anchor top、无 icon（map.ts L615-632）
- **根因**：① 无图标符号（circle 无方向语义，不表达"基站"）；② 站名标签在 z<11 完全不存在——而 9 个站分布跨度约 0.6° 经度，初始 fitBounds 视角 z≈8.5-9，观众第一眼**看不到任何站名**；③ 无选中放大/轮廓强调状态。
- **影响面**：ranSites、ranSiteLabels 两层 + RanOverlay Popup（交互入口）。v1.2.0 站点升级为"可选中、有方向含义的符号 + 更早出现/更大的标签"。

### 观察 3：扇区填充低对比，画面中难区分方向扇形
- **代码证据**：
  - `ran-sectors`：`fill-color #5aa0e0`，`fill-opacity 0.12`，outline `rgba(120,180,240,0.45)`（map.ts L576-582）
  - 扇形几何：`fanPolygon()` 24 步逼近，radius 4-6 km，azimuth/width 来自 geojson sectors 属性（ran-overlay.ts L35-47）
- **根因**：① fill-opacity 0.12 在 hypso 中低亮度底（山体阴影叠 加后）上几乎不可辨；② 所有扇区同色同透明度，无"选中站点扇区高亮 / 其余淡化"的分层权重；③ 扇形颜色 #5aa0e0 与站点 #6ab0f3、地名 #9ec3e8 同族，方向语义靠形状硬读。
- **影响面**：ranSectors 一层 + initSectorFans 注入的 properties（现仅带 `site`，无 per-sector 元数据可用于选中匹配——需在 v1.2.0 扩充扇区 feature 属性）。

### 观察 4：道路 RSRP 细彩色线被复杂底图淹没
- **代码证据**：
  - `ran-rsrp`：line-width z9:**3**→z13:**7**，无 casing/描边层（map.ts L583-602）
  - 竞争元素：`osm-roads` 主线 #d8986a（虚线）+ casing #1a1410（L415-432）、minor/major 等高线（见观察 1）、274 条 RSRP 道路段彼此相邻排布
- **根因**：① 3px 起步宽度 + 无深色描边 → 彩色线段直接叠在同亮度底图上无分离度；② RSRP 颜色 stops（-140..-60，controls.ts L318-325 与 map.ts L590-600 一致）中段色（#d8c34a 黄、#7dbb5a 绿）与等高线 #f2e3bd/hypso 中海拔带色相冲突；③ 单层表达，无"弱覆盖强调"机制（数据里 -129 dBm 段与 -62 dBm 段视觉权重相同）。
- **影响面**：ranRsrp 一层；v1.2.0 加深色底描边 + 提宽 + 图例一致化；弱覆盖（如 < -110 dBm）可选强调由数据契约文档定。

### 观察 5：右侧 A–B 剖面图表小，未与站点/弱覆盖联动
- **代码证据**：
  - 剖面画布：`#profile-chart` width=360 height=170（index.html L87），面板内嵌约 360px 宽
  - 联动缺失的架构事实：`RanOverlay`（ran-overlay.ts）与 `Controls`（controls.ts）**互相不持有引用**——站点 Popup 点击只在 RanOverlay 内消费，`Controls.runProfile()` 只由地图点击 A/B 触发；道路要素无任何 click 处理器
  - `computeProfile(input)` 接口要求 A/B 各带 `antHeightM`（profile.ts L5-9）——站高数据 `height_m` 在 geojson 里有，但当前链路不使用
- **根因**：v1.1.0 的交互模型是"图层开关（ly-ran checkbox）+ 独立 A-B 剖面"，两者无共享状态。联动需要新的状态机（选站→选道路点→以站点为 A 端调 computeProfile），这是 v1.2.0 的核心新增，不是修补。
- **影响面**：RanOverlay（点击事件源）、Controls（profile 模式与渲染）、index.html（剖面卡放大能力）。复用红线：`computeProfile`/`drawProfileChart` 原样复用，不复制 LOS 算法。

### 观察 6：无线图层开启后缺少"哪个站、哪段路"的层次表达
- **代码证据**：`applyVisibility()` 是 RAN 图层唯一的运行时状态 API——遍历 4 层 setLayoutProperty visibility + banner 显隐（ran-overlay.ts L182-189）。图层 paint 参数全部为静态字面量。
- **根因**：不存在"选中/上下文"概念。GIS 与 RAN 模式无分离：RAN 开启后底图照旧全强度，RAN 图层之间也无主次。需要一个集中式的模式/选择状态管理（viewMode + selection），所有 RAN 图层 paint 变化由单一模块驱动。
- **影响面**：架构级新增（状态机），具体设计见 `V1_2_0_Interaction_and_Data_Contract.md`。

---

## 2. 数据诚实审查发现（G0 必须记录的三个事实）

### F1：`worstClearanceM` 注释公式与代码相反（注释 bug，v1.2.0 修正）
- `profile.ts` L19：`// min (terrain - LOS ray); negative => blocked`
- 实际代码 L62：`const clearance = ray - s.elevation;`（= **LOS ray − terrain**，正 = 射线高于地形，负 = 相交/阻挡）
- **结论字段正确**（negative => blocked 与代码一致），仅注释公式文字反了。修复：注释改为 `min (LOS ray - terrain); positive => ray above terrain; negative => blocked`。行为零变化。

### F2：Fresnel 曲线在图上呈现为"全路径包络"，但振幅只是中点半径（诚实性缺陷，v1.2.0 修正标注/画法）
- `fresnelRadiusM` 是 **中点** 1st Fresnel 半径（profile.ts L67-70，公式 F1=17.32·√(d1·d2/(f·D))）
- 但 `drawProfileChart` L162-176 用 `ray + f1·sin(πt)` 沿全路径画曲线——视觉上是完整包络，数学上只是"以中点半径为振幅的参考弧"。UI 文字有 "(中点)" 标注（controls.ts L275），图上无任何标注。
- v1.2.0 处理：图中该曲线必须标注 "0.6·F1 @ midpoint (reference)" 或改为仅中点标记；不得让它读作真实逐点 Fresnel 包络。**任务红线：Fresnel 仅 midpoint 参考，不得渲染成全路径包络。**

### F3：LOS 判定对 DEM 空洞的行为（现状：跳过，不误报；v1.2.0 联动场景需保持）
- `computeProfile` 对 `elevation === null` 的采样点直接跳过（profile.ts L58-65），不当作通畅也不当作阻挡；`outOfCoverage` 计数与 stats warn 已有（controls.ts L267）。
- 已有防竞态：`profileAEle` 守卫异步 A 高程回写（controls.ts L224-232）。
- v1.2.0 联动剖面必须继承：UNKNOWN（无数据）不得默认通畅；"LOS 阻挡 ≠ RSRP 差的原因"表述红线不变（terrain-only approximation 标注已存在于 los-result 与 UI）。

---

## 3. 小范围架构审查记录（改造涉及的模块契约）

### 3.1 模块职责现状

| 模块 | 现职责 | v1.2.0 触碰点 |
|---|---|---|
| `src/map/map.ts` | 样式构建 + 相机 + hash + 边界提示 | RAN 4 层样式升级（描边/宽度/符号）；**不改** DEM/hillshade/contour 源结构 |
| `src/map/ran-overlay.ts` | boot 门控、扇形注入、Popup、visibility | 模式/选择状态的图层执行器；扇区 feature 属性扩充 |
| `src/ui/controls.ts` | 面板接线、模式（query/profile）、剖面运行 | viewMode 状态机入口；站点→道路→剖面联动编排 |
| `src/map/profile.ts` | computeProfile + drawProfileChart | 仅 F1 注释修正 + F2 标注；**算法零改动** |
| `src/map/elevation-query.ts` | DEM 采样（raw，不受 exaggeration 影响） | 不改 |
| `src/config.ts` | LAYER_IDS + metadata 类型 | 新图层 ID（如 rsrp casing）+ 类型扩充 |
| `index.html` / `style.css` | 面板 DOM | 模式切换 UI、剖面放大、站点列表面板 |

### 3.2 必须保持的机制（回归红线，勿回退）

1. **RAN boot 门控**（ran-overlay.ts L55-86）：`getLayer(ranRsrp)` 单条件轮询 + `'load'` 双保险 → `bootOnce` → `applyVisibility()` 首次即隐藏。v1.1.0 竞态修复，**不得改回 once('load') 或 isStyleLoaded 门控**。e2e 有冷启动 RAN 不可见断言守护。
2. **扇形注入轮询**（L158-174）：`getSource('ran')` 轮询 100ms×300，勿改 `once('load')`（load 可能已发过）。
3. **隐藏策略**：图层保持 visible-in-style + 运行时 `setLayoutProperty('visibility','none')`。style 级 `visibility:"none"` 会永久破坏 MapLibre v5 GeoJSON 源处理（v1.1.0 探针实证），**不得**把样式默认改为 none。
4. **`fadeDuration: 0`**（map.ts L72）与 profileLine 在 RAN 层之下（map.ts L553 注释）的层序契约。
5. **三红线**：字形 EDT 修复不回退（glyphs 生成器不动）；SIMULATED banner 与图层显隐同源同步（applyVisibility 单点）；terrain-only LOS 表述不升级为 RSRP 预测话术。

### 3.3 数据契约现状（`public/data/simulated-ran.geojson`）

- 9 站点：`id / ele / height_m(25-40) / bands(900|1800) / sectors[{azimuth,width_deg,radius_m}]`，坐标 [-7.979..-7.36, 31.12..31.29]
- 274 条道路段：2 点 LineString，仅 `rsrp_dbm` 属性（**无路段 id**——v1.2.0 若需选中道路，需在数据管线补 id 或运行时生成稳定键）
- RSRP 极值：最弱 -129.2 dBm（北端 [-7.20, 31.42] 一带连续 -129..-127 段），最强 -59.4 dBm
- 弱覆盖演示候选：北端连续弱段（约 -7.20..-7.25, 31.40+）与中段孤立弱段（-114.9 / -111.4 等）
- **数据诚实**：该数据是模拟 RSRP（无传播模型，管线生成），v1.2.0 所有"弱覆盖"表述必须保持 SIMULATED 标识，联动剖面结论只说 terrain-only LOS，不说"RSRP 差是因为 X 遮挡"。

### 3.4 G0 基线验证结果

| 项 | 结果 |
|---|---|
| `scripts/validate_data.py` | **99/99 PASS**（本分支，含 "ran layer labelled SIMULATED" 检查） |
| Playwright e2e 全量（基线记录，D3D11 headless） | 见 §5 回填 |
| v1.1.0 历史参考 | validate 99/99、e2e 24/24（≈4.9 min）、外部请求 0 |

---

## 4. v1.2.0 方向（每项 RCA 的对策概要；详细设计见 Interaction_and_Data_Contract 文档）

| # | RCA | 对策 | 边界 |
|---|---|---|---|
| 1 | 底图无模式化 | `viewMode: 'gis'\|'ran'` 集中状态机：RAN 模式下等高线减淡、hillshade 对比降低（paint 表达式/统一函数），GIS 模式原样恢复 | 不动 DEM/源定义 |
| 2 | 站点无符号语义 | 站点符号升级（描边强调 + 选中态放大），站名标签 minzoom 下调 + 字号上调 | 无外部图标资源，仍走 glyphs/SDF 体系 |
| 3 | 扇区不可辨 | 扇区 fill-opacity 提升分层：选中站高亮、其余淡化；扇区 feature 携带 site/sector 元数据支持匹配 | fanPolygon 几何逻辑不变 |
| 4 | RSRP 淹没 | 深色 casing 层 + 宽度上调；图例与 map stops 同源常量 | 色带 stops 不变（图例一致性） |
| 5 | 剖面无联动 | 选站→以站点为 A（antHeightM=height_m）→点道路点为 B→复用 computeProfile；剖面卡放大档；UNKNOWN 透传 | 不复制 LOS 算法，terrain-only 标注保留 |
| 6 | 无层次系统 | selection 状态（selectedSite / selectedRoad）驱动全部 RAN paint；applyVisibility 扩展为模式+选择双维 | boot 门控与 banner 逻辑原样保留 |
| F1/F2 | 注释/Fresnel 诚实性 | 注释修正 + 图上中点参考标注 | 零行为变化（F2 仅标注） |

## 5. G0 收口记录

- validate：**99/99 PASS**（分支 `feat/v1.2.0-offline-ran-coverage-visualization` @ `70ba084`）
- e2e 全量基线：**24 passed（4.7 min）**，`verify-offline.ps1 -Port 17842`，PMTILES_RANGE 206 PASS，E2E suite PASS，exit 0（对既有 `dist/` 运行，与 v1.1.0 内容一致；src 修改在其后开始，未污染基线）
- **G0 判定：PASS**（RCA 完成、架构审查完成、validate 99/99、e2e 24/24 基线确认）

---

## 6. G1 附录：实现期实证发现（G0 审查未覆盖、必须记录的经验）

### A1：`maplibre-gl.css` 从未引入（v1.1.0 遗留缺陷，G1 修复）
- **现象**：站点 Popup 在 DOM 中（`querySelector('.maplibregl-popup')` 命中、`transform` 已正确设为 `translate(… 876px, 622px)`），但 `getBoundingClientRect().y = 1601`（1080p 视口外不可见）。
- **根因**：popup 元素 `position: static`——MapLibre 自带样式表从未被引入。v1.1.0 的 popup 从未真正显示过（此前无人触发过站点点击验证），导航/比例尺控件也一直裸样式运行。
- **修复**：`main.ts` 首行 `import "maplibre-gl/dist/maplibre-gl.css"`（本地 node_modules 资源，零外部请求，离线红线不受影响）。
- **教训**：DOM 存在 ≠ 视觉正确。验收必须包含「popup 真实可见」断言（g1-smoke 已补 `.maplibregl-popup` toBeVisible + 内容断言）。

### A2：MapLibre 5 表达式约束比 Mapbox 严（三层样式被整包拒绝）
- **现象**：`paint.line-width` 写成 `["*", [interpolate zoom…], [match sel…]]` → 控制台 `layers[21]: "zoom" expression may only be used as input to a top-level "step" or "interpolate"`，且 **style 整体拒绝加载**（`getLayer('contour-lines')` 永远 false、boot 全挂，仅 console.error 无 UI 报错）。
- **两轮实证**：
  1. `*`/`match` 内嵌 zoom-interpolate → 拒绝（"top-level" 约束）；
  2. `case` 内两个分支各一个 zoom-interpolate → 仍拒绝（`"Only one zoom-based step or interpolate subexpression may be used in an expression"`——**每个 paint 属性只允许一个 zoom 插值，且必须顶层**）。
- **最终方案**：选中高亮不进 paint 表达式，改用「基础层 + filter 选中覆盖层」（`ranRsrpSel` / `ranSitesSel` / `ranSiteLabelsSel`，声明式静态定义，运行时只烘焙 `sel` 属性）。
- **教训**：MapLibre v5 下任何「表达式内分支 zoom」的写法都会整包炸 style；boot 失败只有 console.error，e2e 的 `waitStyleReady` 断言是唯一能第一时间抓到的守护。

### A3：circle 层无 geometry-type 过滤会把 Polygon/LineString 顶点画成珠串
- **现象**：选站后扇区轮廓出现一圈琥珀色圆点——`ran-sites-selected`（circle）的 filter 只判 `sel==selected`，扇区 Polygon 顶点与 boresight 轴线端点全被 circle 渲染。
- **修复**：所有 circle/symbol 选择覆盖层加 `[==, [geometry-type], Point]`；`ranRsrpSel` 加 `has rsrp_dbm`（防 sector-axis 混入）。

### A4：GeoJSON 源按瓦片裁剪 → 点击要素的坐标匹配不可靠
- **现象**：道路点击偶发无效——MapLibre 将 GeoJSON 源按矢量瓦片切片，`queryRenderedFeatures`/click 返回的要素几何是**裁剪后**的（首顶点可能被切掉），用「首顶点坐标匹配源数据」的身份判定失效。
- **修复**：数据构建时直接把选择空间索引烘焙进属性（`roadIdx = roadIdxs.indexOf(i)`），点击处理读属性、不做坐标比对。

### A5：e2e 外部请求计数误报 blob: URL
- **现象**：`EXTERNAL_REQUESTS=1`，但唯一 URL 是 `blob:http://127.0.0.1:17843/…`（MapLibre 内部 worker/blob 对象）。`new URL('blob:…').hostname` 为空字符串，被「非 127.0.0.1」判定误伤。
- **修复**：判定加 `protocol === 'blob:'` 白名单（内存对象非网络请求），并加 `page.route` 对真实外部域名 abort（「断言什么就强制什么」）。

### A6：v1.1.0 弱断言的补强（BASE_DAMPEN 归一化）
- v1.1.0 等高线的低对比实际写在**颜色 alpha**（`rgba(235,215,170,0.5)`），`line-opacity` 属性从未声明。状态机要恢复「显式值」就必须先归一化：ViewModeControl 构造时立即把 dampen 属性设为显式 GIS 值（line-opacity=1、text-opacity=1、hillshade-exaggeration=0.35），渲染结果与 v1.1.0 视觉等同，但此后 GIS↔RAN 的 paint 状态完全确定、可断言。
- RAN 图例刻度 div 未跟随色条隐藏（v1.1.0 泄漏 bug，GIS 模式可见 `-140 dBm…` 刻度）→ 刻度随 `legend-ran` 一同 hidden 联动，g1-smoke 01/05 截图复核确认。

### A7：G1 验证记录
- `tsc --noEmit` 0 error；`validate_data.py` 99/99；`package-dist.ps1` OK（232.9 MB，terrain real）。
- g1-smoke：**2/2 PASS**（desktop-1080p 21.1s / desktop-768p 15.1s），覆盖：GIS 默认 paint 断言、RAN 进入（banner/checkbox/图例/dampen 三值/hash `&m=ran`）、扇区 features>0、选站（卡片+popup 字段+渲染 sel=selected）、弱道路 -110.7 选中（模拟弱覆盖卡）、GIS 恢复（paint 恢复/无 sel 残留/hash 无 m=ran/外部请求 0）。
- 截图 5 场景 × 2 视口（`Docs/screenshots/v1.2.0-g1/`）人眼复核：01 GIS 默认（无刻度泄漏）、02 RAN 总览（横幅+彩带+图例）、03 选站（琥珀点+扇区高亮+他站淡化+popup）、04 弱覆盖卡、05 回 GIS 无残留。
- **G1 判定：PASS**。
