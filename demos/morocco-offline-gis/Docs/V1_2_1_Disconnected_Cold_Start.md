# v1.2.1 — 真断网冷启动检查步骤

状态：用户先前的断网冷启动确认（2026-10-31）仅绑定**历史候选 ZIP**
（SHA-256 前缀 `ec64df5c…`，原字节保留于仓库 `releases/history/
pre-admin-correction-ec64df5c7164/`），**不转移至本修正版归档**。
本修正版以"待复验"状态交付（RELEASE_READY=NO）：请对本归档
（SHA-256 见旁侧 `.sha256` 文件）按下述步骤重做物理断网 + 空缓存
冷启动人工复验，交回证据后再翻转发布就绪状态。自动化请求拦截
不等于物理断网；不能仅凭拦截测试通过就填写 `OFFLINE_COLD_START=PASS`。

## 在 Windows 11 上执行

1. 使用最终 ZIP 解压到新目录，核对旁边 SHA-256 文件；不要使用旧版本目录。
2. 关闭既有演示浏览器窗口及本地演示服务。
3. 拔掉以太网，关闭 Wi-Fi、蜂窝网络及提供外网的 VPN；保留系统回环网络。
4. 在新解压目录双击 `start-offline.bat`，记下实际绑定的本机端口。
5. 用全新浏览器 profile 打开该本机地址（开发者工具禁用缓存），检查：
   全国概览为 2D、High Atlas 真地形、行政区/道路/地点/水系/自然名称；
   进入 RAN 后有模拟横幅，站点→道路→DEM 剖面可用；再返回 GIS。
6. 保存两种视口的截图、Network 请求日志及 Console 日志。页面资源应只来自
   `127.0.0.1` 或 `localhost`，PMTiles Range 请求应为 `206`，无字形鬼影。
7. 记录 ZIP SHA-256、Windows/浏览器版本、视口、检查时间、实际断网方式及结果，
   然后恢复网络。将证据交回后再更新验收 JSON 与 G4/发布就绪状态。

如在开发机复验已安装的自动化测试，可在断网且本地服务已启动后运行（无需联网安装）：

```powershell
cd D:\dev-projects\3D-GIS\demos\morocco-offline-gis
$env:GIS_DEMO_URL = 'http://127.0.0.1:17841/' # 换成实际端口
npx --no-install playwright test --config=e2e/playwright.config.ts e2e/v121-geo.spec.ts --grep '^10 '
```

自动化测试仍会拦截外网；断网方式与时间必须另外记录，不能只凭测试通过就声称物理断网。
