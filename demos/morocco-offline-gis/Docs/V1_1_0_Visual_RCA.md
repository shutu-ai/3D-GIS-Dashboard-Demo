# v1.1.0 视觉问题根因分析（Visual RCA）

> 基线：`v1.0.0`（commit `378371599e02c227e677ff9d76426200e89014a8`，"feat: add offline Morocco High Atlas 3D GIS lab"）
> 工作分支：`feat/v1.1.0-real-dem-visual-upgrade`
> 审计日期：2026-10-29
> 证据来源：用户截图（仓库根目录 `2.png`、`首页.PNG`、`专业地图标注.jpg`、`真实三维地形.jpg`）、v1.0.0 源码逐行审计、基线测试实测。

## Phase 0 基线审计结果（G0）

| 检查 | 结果 | 证据 |
|---|---|---|
| `npm run typecheck` | PASS（0 错误） | tsc --noEmit 无输出 |
| `python scripts/validate_data.py`（v1.0.0 数据） | PASS 43/43（`simulated flag true`，DEM 采样误差 max 22.0 m vs 解析模型） | validate_data.py 输出 |
| Playwright E2E（v1.0.0 dist，离线服务器+Range 206） | 见 `Docs/Acceptance.md` v1.0.0 记录 16/16；本轮重跑结果追加于 §3 | verify-offline.ps1（注意：本机 Hyper-V 保留端口 17841，改用 17842 运行） |
| v1.0.0 发行包大小 | **185,080,026 bytes**（`releases/Morocco-High-Atlas-Offline-GIS-v1.zip`） | Get-Item Length 实测 |
| 地形性质 | **SIMULATED**（`metadata.json` `"simulated": true`；Perlin fBm 解析模型） | `scripts/pipeline/dem.py` |

**结论：v1.0.0 的"通过"仅覆盖模拟数据下的功能与离线完整性；地形不真实是设计使然，不是渲染 bug。** v1.1.0 必须替换数据源并同步调样式，不允许只改标签。

---

## 1. 逐项 RCA：证据 → 根因 → 代码位置 → 修复方案

### P0-1 界面标注 `SIMULATED TERRAIN`
- **证据**：截图顶栏黄色徽章 `SIMULATED TERRAIN`；页脚 `programmatic ally generated, not survey data`；`metadata.json` `"simulated": true`。
- **根因**：v1.0.0 全部产物由 `scripts/pipeline/dem.py` 的解析高程函数（ridged multifractal + fBm + 高斯锚点 + 道路切槽）程序化生成，属项目既定决策，非缺陷性退化。
- **代码位置**：`scripts/pipeline/dem.py`（模型）、`scripts/prepare_data.py:build_dem_tiles/build_contour_tiles/build_roads_peaks`（产物）、`index.html`（徽章文案）、`src/ui/controls.ts:190`（查询结果来源行硬编码 "SIMULATED terrain"）。
- **修复**：Phase 1 真实 DEM 管线（`--terrain-source real --dem-dir <dir>`，Copernicus DEM GLO-30）；前端徽章/来源行改为 metadata 驱动（`terrain.mode === "real"` 才显示 `REAL TERRAIN · OFFLINE`）；RAN 永远保持 `SIMULATED NETWORK DATA`。

### P0-2 山体呈高频尖锐灰白褶皱（"塑料皱纸"）
- **证据**：`2.png`（Toubkal 近景 pitch 68）——全画面均匀的高频锯齿纹理，亮部近白、暗部近黑。
- **根因**：三个因素叠加。
  1. **数据源**：`dem.py` `ridged()` 5 octaves + `fbm()` detail 叠加，噪声频率远高于真实山脉的构造尺度；真实地形有大尺度山体与平缓谷地，fBm 是"满屏等密度毛刺"。
  2. **采样路径**：`prepare_data.py:DEM_EVAL_SIZE=256` 先按 256px 采样再双线性放大到 512px，高频噪声被放大后边缘锐利。
  3. **hillshade 渲染**：`src/map/map.ts` `hillshade-exaggeration 0.45`、`shadow-color #0a1018`（近纯黑）、`highlight-color #ffffff`（纯白）→ 极端亮度反差把噪声纹理放大成"皱纸"。
- **修复**：换真实 GLO-30 DEM（天然平滑大尺度形态）；低 zoom 用面积均值金字塔降采样（dem_real 管线）；hillshade 调为 exaggeration ~0.35、NW 光照 315°、软阴影/暖高光（前端 lane）。

### P0-3 山体与大片平坦绿色区域过渡突兀
- **证据**：`首页.PNG` 默认视角——棕灰色褶皱山体与均匀绿色平地直接相接，无自然梯度。
- **根因**：
  1. 合成模型的宽锚点（`Haouz Plain` sigma 0.15、470 m）+ ridge mask smoothstep 形成大片**等高平原**，梯度被 `np.clip(380, 4230)` 压平。
  2. hypso 色带低端从 400 m 起且 400→600 m 两档纯绿色（`HYPSO_STOPS` 前两档 `#3f7f63/#5f9160`），平原整片同色。
  3. 真实区域海拔可低至 ~300 m，色带没有低端档位。
- **修复**：真实 DEM 后地形自然过渡；色带低端补 250/320 m 浅绿/土黄档、高端 3850-4167 软化为岩灰→浅白（避免大面积过曝纯白）；图例由 metadata 生成保持一致。

### P0-4 倾斜视角露出悬浮矩形地图硬边
- **证据**：`首页.PNG`——pitch 60 下地图呈悬空平板，四周直边悬于深色背景；`2.png` pitch 68 远景同样可见边界。
- **根因**：
  1. 数据覆盖 `GEN_BBOX=(-8.4,30.85,-6.95,31.55)` 仅 1.45°×0.7°，四个预设场景 zoom 10.8 + pitch 60-68 的可视足迹远超覆盖；
  2. `maplibregl.Map` 未设 `maxBounds`，自由飞行可移出数据域；
  3. reset 默认 pitch 60，初始视角即逼近覆盖边缘。
- **代码位置**：`src/map/map.ts`（`new maplibregl.Map({...})` 无 maxBounds；`fitBoundsView` pitch 60；`resetView` pitch 60）、`scripts/pipeline/dem.py:GEN_BBOX`。
- **修复**：覆盖扩至 `(-8.75,30.80,-6.45,31.65)`（camera-aware 缓冲）；前端设 `maxBounds`（coverage 内缩 ~0.05°）；场景/reset pitch 降至 48-50；越界提示 toast + Reset；不做假地形延伸。

### P0-5 峰名/地名/海拔数字叠字、部分深色乱字
- **证据**：`2.png` 中部与 `首页.PNG` 中部——多组山峰标签互相压盖成黑块；数字与地名重叠不可读。
- **根因**：`src/map/map.ts` 标注层：
  1. 峰/垭/地名全部同尺寸、同 `text-anchor: top`、`text-offset` 固定，**无 `symbol-sort-key`、无 `text-padding`**，MapLibre 碰撞器无优先级可依；
  2. 目标区 6 峰 + 2 垭 + 11 地名 + 9 RAN 站全部集中在 ~0.5°×0.3°，z10.8 下必然碰撞；
  3. 标签 2 行文本（名称\n海拔）+ halo 1.5 深色半透明，重叠后呈"黑色乱字"；
  4. 数据侧无 `rank` 字段，同名/邻近峰无去重。
- **修复**：数据侧加 `rank`（Toubkal=1 …）；前端峰/垭/地名列全部加 `symbol-sort-key` + `text-padding` ≥6 + 分级 minzoom（主峰 9、次峰 10.5、地名 10）+ 变长文本 `▲ 4167 m` 式主峰样式；禁止全局 `text-allow-overlap`；halo 收窄至 1.2。

### P1-6 等高线和高度数字不够清晰
- **证据**：`首页.PNG`/`2.png`——等高线细淡，沿线数字稀疏且小。
- **根因**：`map.ts` 主线宽 1.2→2.0 px、次线 0.7→1.1 px、主色 `rgba(235,215,170,0.5)` 半透明；标签仅 major、`symbol-spacing 260` 偏密但字号 10-13 偏小；zoom 分级（500/100/50 m）本身合理。
- **修复**：主线加宽至 ~2.5 px、提高不透明度、标签随 zoom 增密（z11.5 以下仅 major，≥11.5 允许 minor）、`text-padding` 防叠；密度分级保留并按真实 DEM 截图微调。

### P1-7 默认 pitch 60°–68° 过陡
- **证据**：`metadata.json` scenes pitch 60/62/65/68；`map.ts` resetView pitch 60。
- **修复**：scenes 调至 48-50；resetView 50；maxPitch 70 保留手动极限。

### P1-8 专业质感不足
- **证据**：对照 `专业地图标注.jpg`/`真实三维地形.jpg` 参考图——参考图有清晰主次等高线、三角峰标、自然色带。
- **根因**：上述 P0 项的叠加效应 + 道路 casing/山峰圆点样式简陋。
- **修复**：峰点改 ▲ 符号样式语义（文本 ▲ + 圆点底）、道路 casing 减重、图例/字体微调。

## 2. 不能退化的既有能力清单（回归范围）
2D/3D 切换、pitch/exaggeration 控件、四场景 Fly-to、URL hash 分享、海拔点击查询、A-B 剖面、LOS/Fresnel（terrain-only 提示）、模拟 RAN 叠加、PMTiles HTTP Range 206、PowerShell 离线服务器、16 项 Playwright 用例。

## 3. 本轮基线重跑记录（追加）

- 2026-10-29：typecheck PASS；validate_data 43/43 PASS（synthetic）。
- Playwright 基线重跑（`verify-offline.ps1 -Port 17842`，本机 17841 被 Hyper-V 保留）：**[PASS] PMTILES_RANGE (206, header 128 bytes)；16/16 passed (7.9m)；[PASS] E2E suite** ——与 v1.0.0 验收记录一致，基线可信。
- 真实 DEM 源数据：6 幅 Copernicus GLO-30 COG 已下载并校验（EPSG:4326、30 m、float32，SHA256 记录于 `data_sources/copernicus-glo30/SHA256SUMS.txt`）。

## 4. 修复责任映射

| RCA 项 | 修复 lane | 验证 |
|---|---|---|
| P0-1/P0-3 数据部分、P1-7 scenes | 数据管线（dem_real + prepare_data real 模式） | validate_data real 模式 100% |
| P0-2 渲染部分、P0-4 前端部分、P0-5、P1-6、P1-8 | 前端（map.ts/controls.ts/index.html） | 12 张截图人眼检查 + E2E |
| P0-4 数据部分（coverage 扩张） | 数据管线 | 覆盖 bbox 检查 |
| 全量回归 + 离线包 | Orchestrator | verify-offline.ps1 + 打包哈希 |

---

## 5. 验收期渲染伪影 RCA：自产 SDF 字形图集损坏（最终定性）

> 日期：2026-10-30。第一轮 blocker（05 号亮斑/直线边界）经探针证实为**捕获时机**（瓦片解码未完成即截图），捕获流程改为 `trackTileTraffic` 网络静默等待后消除。第二轮复核仍报 3 类 blocker；本轮给出最终定性——**并推翻本节早先"SwiftShader 环境缺陷"的结论**（原 5.3，已证伪，保留反转过程于 5.3）。

### 5.1 现象（第二轮 12/12 张）

1. **标签双绘**：每条 symbol 文本以 ~半字符水平错位叠印两份，均全不透明，稳定跨帧；01/02/03/04/06 各分辨率均现。
2. **05 号亮斑补丁 + 直线覆盖边界**（新形态）。
3. **03 号大范围直线地形接缝**（精细地形与平滑区域的笔直对角分界）。

### 5.2 假说排除链（探针实证）

| 假说 | 实验 | 结果 |
|---|---|---|
| 数据重复 | `roads-peaks.geojson` 按名去重检查 | 16 要素无重复名 |
| 双层各画一次 | probe12：`queryRenderedFeatures` 按 layer 归组 | **查询只见一份**（且少于可见标签数）→ 渲染期伪影 |
| fade 中间态 | probe13：连续截图 churn 检测 + 归零实验 | churn ~10-15s 自稳；`fadeDuration: 0`（Map 构造器）+ `raster-fade-duration: 0` 后**双绘仍在** |
| 图层来源 | probe14/15：Toubkal 场景逐层隐藏像素归因 | 双绘发生在**单一图层内部**（隐藏 `osm-peak-labels-top` 后其标签整体消失，余下层各自双绘） |
| terrain/pitch/avoid-edges | probe16：`setTerrain(null)`、pitch 0、`symbol-avoid-edges: true` 矩阵 | 全部无效 |
| maplibre 版本回归 | 最小复现页（纯 MapLibre + 3 点 GeoJSON，无 PMTiles/无地形/无产品代码）：5.23.0 / 5.24.0 / 6.16.0 | **三版本全部双绘** → 非版本回归 |
| 渲染后端差异 | `--use-angle=d3d11`（Intel 真机 GPU）下全量验收重拍 | **双绘依旧** → 非 SwiftShader 专属（第一轮定性在此证伪） |
| glyph placement（left/top/w/h） | 以 maplibre `quads.ts` 公式 `(left-4, -top-4)` 代入自家 metrics 解析落点 | 墨迹落点正确（≤1px 偏差）→ placement 无罪 |
| **自产 SDF 字形损坏** | 换官方参考字形（demotiles / openfreemap `0-255.pbf`，76,580 B）重拍 halo/nohalo 矩阵 | **halo/nohalo 全部干净单份** → 根因即字形数据（此前该行被误排除，见 5.3） |

> 注：排除链早先版本中"自产 SDF 字形损坏"一行被标注为"排除"，理由是 `dump_glyph.py` 解析位图"呈条纹状"且"用户真实 GPU 参考图正常"。两点皆有误：① 解析脚本按未含 3px 边框的尺寸读位图、且未做 zigzag 解码，"条纹"是解析错误的产物；② "用户 GPU 正常"判断先于用户提交 `chrome://gpu` 与 `3.png`——`3.png` 恰是同一伪影在用户硬件加速浏览器上的表现。

### 5.3 定性反转过程（记录两轮结论及证伪链）

**第一轮（已证伪）**："SwiftShader 软件渲染符号绘制缺陷"。依据是 D3D11 最小复现"干净"——后经对比度增强复检，该判断是低对比度下的漏检。

**决定性事实链（最终定性依据）**：

1. `chrome://gpu`（用户本机 Chrome 155）：`WebGL: Hardware accelerated`，`GL_RENDERER = ANGLE (Intel, Direct3D11)`——与验收探针同 GPU 同后端，用户浏览器**同样重影**（`3.png`，与捕获伪影同型）→ 缺陷与渲染后端无关。
2. 修复 `playwright.config.ts` 重复 `use:` 键（launchOptions 曾被静默覆盖）后，测试内渲染器探针实证 `ANGLE (Intel, Direct3D11)` 生效，全量验收 4.9 分钟跑完（SwiftShader 时代 17.5-22 分钟）——**新截图仍双绘**。
3. **halo 矩阵**（最小复现页，D3D11）：`halo` 模式 = 红色填充单份 + 深色 halo 双份方括号鬼影；`nohalo`（`text-halo-width: 0`）= **填充文字完全消失**（连纯红填充都不出图）→ 可见"双份"中的鬼影来自 halo 通道对损坏距离场的阈值拾取，填充通道值贴近阈值故若有若无。
4. `canvasContextAttributes: { antialias: true }`、`desynchronized` 上下文变体：无变化 → 非 GL 上下文属性问题。
5. **换参考字形图集**（demotiles 与 openfreemap 两源字节一致，76,580 B）：同页 halo/nohalo **全部干净单份** → 字形数据为唯一变量。
6. **字节级 + 位图直视对比**（同字形编码，正确尺寸 `(w+6)×(h+6)` 解析）：
   - 参考：平滑 SDF（背景 0、字心亮核、环形渐变衰减）；
   - 自产：`\x01`/`\x80` 两极化大平台 + `\x8f`/`\x9f` 台阶——**Chebyshev（L∞）分层侵蚀距离场**；直视图上字干中灰、顶部两角大片灰色楔形伪影。
   - `[...]` 式方括号鬼影机制：L∞ 场在字形周边形成方形等值平台，被 SDF shader 阈值拾取即画出与笔画错位的方块伪影；nohalo 时文字消失机制：细笔画内部深度 ≤1-2px、场值贴近阈值，绘制与否取决于采样精度 → Intel D3D11 消失、SwiftShader 粗体双份。
7. metrics 约定核验（`quads.ts` verbatim + 字段级 wire 转储）：自产文件的 `left/top/w/h` 与参考文件数值形态不同（约定差异），但代入 maplibre 公式后墨迹落点正确——**placement 无罪，唯一致命缺陷是距离场算法**。

**最终定性**：`scripts/pipeline/glyphs.py` 的 `_clip_dist` 以 3×3 腐蚀/膨胀分层实现距离场，得到的是 **Chebyshev 距离**而非 SDF 所需的**欧几里得距离**——自产字形图集 `public/assets/glyphs/Noto Sans Regular/0-255.pbf` 全量损坏。该缺陷自 v1.0.0 字形管线引入即存在：v1.0.0 用户截图的"叠字黑块"（P0-5）中"半字符错位叠印"部分与之同源（P0-5 的标签碰撞压盖部分另由 rank/sort-key 修复，两因并存）。

### 5.4 修复

- `glyphs.py`：删除 `_dilate3/_erode3/_clip_dist`（Chebyshev 分层侵蚀），替换为 **Felzenszwalb–Huttenlocher 精确平方欧几里得距离变换**（纯 numpy 两趟一维抛物线包络，无新依赖）；`_sdf_bitmap` 输出有符号 L2 距离场（`128 + signed·127/SPREAD`，SPREAD=8）。
- 重新生成 `0-255.pbf`（417,016 B，fontstack 名与覆盖不变）；位图直视复核：平滑环形衰减、无平台、无楔形伪影。
- `validate_data.py` 全量 **99/99 PASS**（glyph 区块：名字/数量/ASCII 覆盖）。
- 产品级 D3D11 探针（端口 17860）：峰标签**干净单份**。
- placement/metrics 约定未改动（实证正确）；e2e `launchOptions` 的 D3D11 参数保留（真实 GPU 渲染更快且更贴近用户环境，但**不再是本缺陷的修复手段**——修复后在两种后端下均干净）。

### 5.5 残留与更正

- 03 直线接缝、05 亮斑此前被归为"SwiftShader 复合伪影"——同样需以字形修复后的第三轮截图重新定性（RAN 类 blocker 已随 `getLayer` 门控修复消除；剩余项以 designer 第三轮复核为准）。
- ~~向 maplibre 上游提 issue~~ 撤销：非 maplibre/驱动/浏览器缺陷。自产字形生成器的教训记入 `Docs/V1_1_0_Design_Debt.md`（缺独立参考实现比对与位图级自检，导致 v1.0.0 带病发布）。
- 用户侧验证提示：字形 pbf 可能被浏览器缓存，修复后需 Ctrl+Shift+R 强刷方可见效。
