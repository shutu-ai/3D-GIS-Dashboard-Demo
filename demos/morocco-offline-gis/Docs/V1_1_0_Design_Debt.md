# v1.1.0 设计债清单（G2 复核放行项）

来源：G2 视觉复核（@designer，12 张验收截图，2026-10-30）。以下问题**不阻塞发布**，记录为后续版本改进项。

| # | 项 | 影响范围 | 描述 | 建议方向 |
|---|---|---|---|---|
| D1 | 标记压标签 | 02/03 等场景多处（Setti Fatma、Tizi n'Tichka、Adrar n'Dern 最明显） | 站点圆点/路点标记压在标签文本中部（字形修复前该区域被双绘污染，修复后确认真实问题为标记压盖，非叠撞） | 标记与标签联动偏移（circle 层 y 偏移或 symbol-label 反向排布） |
| D2 | 768p 等高线网纹 | 768p-01/02 | 100 m 间隔等高线在低分辨率下偏密（字形修复后确认是真实等高线纹理而非伪影，观感可接受，程度较此前评估减轻） | 768p（或低 zoom）下等高线抽稀/减淡，或提高 minor 等高线 minzoom |
| D3 | 768p 标签视口截断 | 768p-02 上缘、768p-01 下缘 | "Tizi n'Tichka 2260 m" 被视口上缘裁切；768p-01 底部标签贴近页脚免责行 | 标签避让视口边缘（padding 内收） |
| D4 | 字形生成器缺自检 | `scripts/pipeline/glyphs.py`（v1.0.0 起带入，v1.1.0 修复） | 自产 SDF 字形生成器用 Chebyshev（L∞）分层侵蚀实现距离场，产出损坏图集，造成全平台标签"双绘/鬼影/消失"伪影（含 v1.0.0 的"叠字黑块"部分形态）；因缺位图级自检与参考实现比对，两轮验收期才定位（详见 `V1_1_0_Visual_RCA.md` §5） | 生成管线增加确定性自检：对样例字形断言 SDF 单调性/对称性，或与参考实现（fontnik 式 L2 EDT）输出做容差比对；任一失败即 fail prepare_data |
| D5 | 3D 俯仰视角标签淡显过度 | 03/04/06 等 3D 场景多处（Tizi n'Tichka、Adrar n'Dern、Jbel Toubkal） | 地名标签在俯仰视角下呈半透明低对比，压在密等高线底纹上辨识吃力——第三轮复核中最显眼的打磨项 | 调高 text-opacity 下限（或 symbol-fade 相关参数）与 halo 对比度；第三轮复核建议优先处理 |

## 复核确认达标项（无需处理）

- 地形自然度：山脊树枝状分叉、谷地走向、坡面破碎度符合真实 High Atlas 形态，无合成网格/直线山脊/重复纹理
- 色带：绿（低地）→ 棕褐（山地）→ 白（雪线级）逻辑成立，与图例一致；hillshade 适度
- UI 遮挡：固定侧栏不遮挡核心山体
- 徽章：12 张均见 "REAL TERRAIN · OFFLINE"；05 号两张均见黄色 "SIMULATED NETWORK DATA" 横幅 + 图例 "(SIMULATED RSRP)"
- 等高线（04）清晰可辨；剖面卡（06）完整（距离/海拔统计/LOS 阻挡）

## 附：复核历史

- 第一轮 G2 判定 FAIL（1 blocker）：05 号 RSRP 叠加区矩形亮斑 + 直线覆盖边界。
- 根因（探针实证）：**捕获时机问题**——第二次 flyScene 后 hypso 瓦片解码未完成即截图（软渲染 ~25 s），`map.areTilesLoaded()` 在软渲染下飞行后恒 false 不可用；产品渲染 t+70 s 完全正确。
- 修复：e2e capture 改用 Node 侧瓦片网络流量静默（`trackTileTraffic`）等待后截图；RAN 回归断言加强（toggle 前后 rendered-features 断言）。
- 同轮发现真实产品 bug：RAN 图层 boot 竞态导致**未开启时 RSRP/站址可见**（违反"模拟须带 SIMULATED 横幅"红线）→ `RanOverlay` 竞态安全 boot 修复（`getLayer` 门控重试 + `load` 双保险；style 级 `visibility:"none"` 会使 MapLibre v5 完全跳过 GeoJSON 源处理且不可恢复——探针实证，勿回退）。
- 第二轮复核基于新 12 张截图（本文件 minors 即两轮共有的放行项）。
- 第二轮 3 blocker（标签双绘 12/12、05 覆盖缺口、03 直线接缝）的最终定性：**自产 SDF 字形图集损坏**（Chebyshev 距离场），非 SwiftShader/驱动/MapLibre——早先"SwiftShader 环境缺陷"结论已证伪；05/03 与标签双绘同源，随字形修复（Euclidean EDT 重生成 `0-255.pbf`）消除，以第三轮截图复核为准。修复记录见 `V1_1_0_Visual_RCA.md` §5。
- 第三轮复核（2026-10-30 11:41-11:44 新 12 张）：**G2 PASS**——3 blocker 全部消除，本清单 D1-D3 按新证据改述/减轻，新增 D5（标签淡显），均不阻断。
