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
- Playwright 基线（`verify-offline.ps1 -Port 17842`，本机 17841 被 Hyper-V 保留）：结果待本轮 acceptance 汇总时一并记录。
- 真实 DEM 源数据：6 幅 Copernicus GLO-30 COG 已下载并校验（EPSG:4326、30 m、float32，SHA256 记录于 `data_sources/copernicus-glo30/SHA256SUMS.txt`）。

## 4. 修复责任映射

| RCA 项 | 修复 lane | 验证 |
|---|---|---|
| P0-1/P0-3 数据部分、P1-7 scenes | 数据管线（dem_real + prepare_data real 模式） | validate_data real 模式 100% |
| P0-2 渲染部分、P0-4 前端部分、P0-5、P1-6、P1-8 | 前端（map.ts/controls.ts/index.html） | 12 张截图人眼检查 + E2E |
| P0-4 数据部分（coverage 扩张） | 数据管线 | 覆盖 bbox 检查 |
| 全量回归 + 离线包 | Orchestrator | verify-offline.ps1 + 打包哈希 |
