# dsh-live-preview（实时预览）

![ci](https://github.com/llr-sketch/dsh-live-preview/actions/workflows/ci.yml/badge.svg)

DSH 左侧栏插件：在 DSH 窗口内**实时运行并查看正在开发的应用**，边写边看、边给建议。

支持三类目标：

| 目标 | 做法 | 适用 |
|---|---|---|
| 网页 | 面板里用 iframe 直接加载本地 dev server URL，日志里自动探测地址 | Vite/Next/纯 HTML/PWA，桌面与移动 H5 共用 |
| Windows 桌面窗口 | 选择任意可见窗口，实时捕获成 JPEG 帧串流（PrintWindow/BitBlt） | Electron、WinUI、WPF、Qt、游戏；x64 与 arm64 程序都能看（捕获与架构无关） |
| 安卓 | 真机或模拟器，H.264 高清镜像（30–60fps），支持点击/滑动/按键/输入 | Capacitor/Cordova/RN/Flutter/原生安卓应用 |

**一键安装安卓模拟器**：面板里点一个按钮，自动完成 Java 运行时、Android SDK、emulator、系统镜像、AVD 创建与硬件加速检测，部署者无需手工装 SDK。国内网络自动走镜像（华为 OpenJDK / npmmirror ffmpeg / Google SDK CDN）。

面板同时显示命令进程的实时日志与错误，所以「启动 → 看画面 → 看日志 → 改代码」不再需要切窗口。

## 新手 5 分钟上手

**不用会命令行，也不用先装 Java / Android SDK**——这些由插件面板里的按钮自动下载完成。

1. 装好 DSH 并能正常和 AI 对话（能写代码、能运行命令即可）。
2. 安装本插件（见下面「安装」；把压缩包解压后让 DSH 的 AI 执行一条 `plugin_manager install_bundle` 即可）。
3. 刷新 DSH 页面 → 左侧栏点「**实时预览**」→ 点「导入应用文件」或「启动模拟器」。
4. 回到对话，对 AI 说：

   > 帮我做一个 20 秒倒计时网页，做好后用 `live_preview` 跑起来给我看。

   AI 会启动开发服务器 / 导入程序，右侧「实时预览」自动打开，画面和日志就在对话旁边。
5. 觉得哪里不对，直接指着画面说「按钮再大一点 / 颜色换成蓝色」，AI 改完刷新就能看到。

![安卓页默认布局：左边设置、右边实时画面](docs/panel-android.png)

> 插件自带指令：AI 在做、改、交付应用时会**主动调用** `live_preview` 把应用跑起来并弹出预览，不需要用户教它；模拟器每次重启还会自动恢复到干净的应用列表。

## 适合谁

- **零基础学 AI 编程**：不必理解 dev server、端口、SDK，按钮点一下就能看到自己的程序跑起来；
- **前端 / 桌面 / 安卓初学者**：改一行代码就能在 DSH 里看到效果，不用反复切窗口、截图、描述问题；
- **教学与演示**：左边对话、右边实时画面，讲一步看一步；
- **想让 AI 自己验证结果的用户**：插件会要求 AI 运行并检查自己的程序，而不是“写完就说完成了”。

## 安装（给自己或别人）

要求：DSH（桌面版 / Web 均可）、Windows 10/11 x64；要预览安卓模拟器时还需要 CPU 虚拟化（AEHD/WHPX）。

**方式 A：本地目录 / 压缩包（最简单，推荐私下分享）**

1. 把插件目录（含 `package.json`、`index.js`、`client.js`、`host/`、`cordis.patch.yml` 等）解压到任意位置，例如 `D:\dsh-live-preview`；
2. 在对方的 DSH 里让 Agent 执行（需要 danger-full-access 或批准）：

   ```
   plugin_manager install_bundle target = "D:\\dsh-live-preview"
   ```

3. 刷新 DSH 页面，左侧栏出现「实时预览」入口。

**方式 B：npm 包（发布后别人一条 spec 安装）**

```bash
# 首次发布前把 package.json 的 name 改成自己的 scope（如 @yourname/dsh-live-preview），避免重名
npm publish --access public
```

对方安装：`plugin_manager install_bundle target = "dsh-live-preview@0.2.4"`（scoped 包则用 `@yourname/dsh-live-preview@0.2.4`）。

**方式 C：GitHub Releases（普通用户最推荐）**

在仓库的 **Releases** 页面下载 `dsh-live-preview-<版本>.zip`，解压到任意目录，然后按方式 A 的 `plugin_manager install_bundle` 安装即可。

**方式 D：Git 仓库 / tarball**

把仓库地址或 `.tgz` 文件给对方，用 `plugin_manager install_bundle target = "<git 地址或 tarball 的绝对路径>"`。

> 插件包本身只有约 0.7MB，**不包含** adb、ffmpeg、JRE、Android SDK/AVD；这些是每个使用者首次在面板里点按钮时自动下载到自己的
> `%LOCALAPPDATA%\dsh-live-preview`（安卓模拟器约 2GB，总计约 5–6GB）。

## 使用

### 面板

左侧栏「实时预览」→ 顶部三个 Tab：

- **网页**：填 URL（或让第一次 `run` 从日志自动探测），点「载入」；iframe 实时预览。下方可直接填启动命令。
- **桌面窗口**：点「刷新窗口」→ 选中目标窗口 → 画面开始实时串流；可「置前」窗口或「停止」。
- **安卓**：
  1. 第一次使用点「**安装安卓模拟器（约 2GB）**」→ 分步进度：Java → cmdline-tools → SDK 组件 → AVD → 加速检测。约 3–8 分钟（取决于网络）。
  2. 装好后卡片显示「硬件加速: AEHD/WHPX」「高清串流组件已就绪」、AVD 下拉框与「**启动模拟器**」。启动速度：**冷启动约 20–30 秒**；之后模拟器**保持常驻**——插件重载、DSH 重启都会直接接管（约 1 秒），不会再冷启动。安卓页**默认显示设置卡片**（不自动进专注预览），要看大画面再点「专注预览」；右侧预览头部也有「启动模拟器 / 停止模拟器」按钮。
  3. 启动后自动开始高清镜像，画面右上角显示帧率（有硬件加速时 30–60 帧/秒）；直接点画面 = tap，按住拖动 = swipe，下方有 返回/主页/回车/停止镜像/**重启应用** 与文字输入。「重启应用」会识别当前前台应用，强制停止后重新启动并重启镜像；如果当前停在桌面，则重启插件最近启动过的那个应用。
  4. **性能/稳定性**：模拟器以**无窗口（-no-window）**方式运行，避免 Qt/OpenGL 图形崩溃弹窗，画面统一由插件展示；AVD 用稳定档 **2GB / 4 核 / GPU host**；插件卸载或 DSH 重启时**保留模拟器进程**（要关就点面板「停止模拟器」）；串流 6Mbps / 960px，降低占用；串流启动前会先唤醒屏幕并失败重试一次，避免快照/息屏后降级截图轮询。
  5. **每次重启恢复初始应用列表**：模拟器每次由插件启动（冷启动）后会自动卸载上次安装的第三方应用，回到干净的应用列表；系统设置（包括「语言 → 简体中文」）保留不动。想保留上次装的应用，设环境变量 `DSH_LIVE_PREVIEW_KEEP_APPS=1` 再启动 DSH。
  5. 没有硬件加速时（WHPX/AEHD 均未安装），点「安装加速驱动」会弹一次 UAC（管理员）安装 AEHD，装好后无需重启即可满帧。
  6. 接真机：连 USB 开 USB 调试 → 「刷新设备」→ 开始镜像，同样走 30fps 高清串流（需已安装 ffmpeg 组件）。
- **画面大小可自己调**（安卓页、桌面页通用思路）：
  - 预览条上的「**适应 / 100% / 200%**」切换缩放；100%/200% 时画面按设备原始像素显示，可滚动查看细节。
  - 「**专注预览**」隐藏所有设置卡片，画面铺满整个面板；「显示设置」恢复。开始镜像时会自动进入专注预览。
  - 预览条下方的**分隔条**可上下拖动调整预览区高度（键盘 ↑↓ 也可，双击恢复默认）。
  - 缩放档位、专注状态、预览高度都会记住（localStorage），刷新页面或重启 DSH 后保持。
- 若之前只装了 adb 没装 ffmpeg，卡片会提示「安装高清串流组件（约 110MB）」；没有 ffmpeg 时自动降级为截图轮询（约 2–5fps，不报错）。

### 导入应用文件（自动识别系统）

主面板顶部和右侧预览里都有「**导入应用文件**」按钮，通过系统文件选择器上传，插件自动判断该跑在哪：

| 文件 | 识别方式 | 运行方式 |
| --- | --- | --- |
| `.apk` | ZIP 内含 `AndroidManifest.xml` | 自动启动模拟器（如未运行）→ `adb install -r -g` → 启动 App → 自动切到安卓预览 |
| `.exe`（PE） | MZ/PE 头，读出 x64 / ARM64 / x86 | 直接启动，自动找到它的窗口并开始桌面串流（ARM64 程序在 x64 主机上会明确提示） |
| `.html` / `.zip` | 单页 HTML，或 ZIP 内最浅的 `index.html` | 解压后由插件在本机提供服务，主面板「网页」Tab 直接 iframe 预览 |
| `.msi` / 其它 | 仅识别，不执行 | 给出提示（MSI 请先安装，再导入安装目录的 exe） |

上传进度、识别结果、失败原因都会显示在导入区；Agent 也可以用工具直接导入宿主上的文件：

```json
{ "action": "import_app", "path": "C:\\path\\to\\app.apk" }
{ "action": "import_status" }
```

### 版本选择 + 历史应用

每次导入/交付同一个应用的新版本，插件都会把它记为一个版本（文件复制到数据目录，源文件保留）：

- **需要保留哪个版本？**：导入已有应用的新版本时，旧版本和新版本**同时保留运行**（Windows 是两个进程各自跑；网页是两份都在服务；安卓同一包名只能装一个，旧 APK 留在历史里）。面板/右侧预览顶部出现选择条，显示两个版本的名称与时间，点「保留旧版本 / 保留新版本」。
- 选择后 **60 秒**，未保留版本的**进程会被关闭**（Windows 结束进程、网页停止服务、安卓标记为未运行），但**应用包/文件仍保留在历史应用里**；选择后选择条会显示倒计时。
- **历史应用**按钮：主面板顶部和右侧预览顶部都有。**两个入口的范围不同**：
  - 主面板的「历史应用」按**对话分组**（每个对话一段，显示对话标题/时间与该对话下的版本，按最近使用时间倒序），可以看到所有对话的应用；
  - 右侧预览的「历史应用」**只显示当前对话**下的应用版本（没有则显示空提示），避免和其他对话混在一起。
  - 每一行显示 **类型 · 时间 · 存储占用大小**，每个应用在**同一对话内**最新的一条标有「最新」徽标；点击任意版本可直接运行它，也可 ★ 标记 / 删除。
  - 点击版本行后**历史窗口会自动关闭**；预览区里的旧画面立刻换成**加载动画**（按阶段显示：正在启动模拟器 → 正在安装 → 正在启动），直到新版本真正出画面（安卓等新帧、Windows 等新窗口，最长约 6–8 秒）才切回实时画面，不会一直露着上一个程序。
  - 如果点的是**安卓版本且模拟器没开**，会**自动拉起模拟器**再安装/启动该版本（冷启动约 30 秒，加载动画会一直显示阶段文案），不需要先手动启动模拟器。
- 版本会记住是哪个对话导入的（Agent 通过工具导入时取当前会话；界面导入时取右侧预览所在会话/最近会话），因此新对话里导入会形成新分组，不会串到别的对话。
- **迁移旧版本**：加会话功能之前导入的版本会显示在「未关联对话」组。主面板里该组头有「**全部归到当前对话**」，每行也有「**归到当前对话**」；右侧历史为空时同样提供「把这 N 个未关联版本归到当前对话」按钮。Agent 工具对应 `app_version_assign_session {versionIds, sessionId}`。
- Agent 工具也可操作：`app_versions`、`app_version_open {versionId}`、`app_version_choose {versionId}`、`app_version_mark {versionId, marked}`、`app_version_delete {versionId}`。

### 与会话同时显示（右侧边栏）

- 有画面在跑时（网页 / 桌面窗口 / 安卓镜像），插件会**自动在右侧边栏打开「实时预览」**，左边继续对话、右边实时看应用，边看边给意见。
- 也可以手动：右侧边栏打开 → 「+」/引导页选「实时预览」；主面板顶部已不再放「右侧同时看」按钮（改由右侧栏的「打开主面板」返回）。
- 右侧标签是轻量版：实时画面（安卓可点击/拖动，带 返回/主页/回车）、帧率、**启动模拟器 / 停止模拟器**、导入按钮；点「**打开主面板**」回到主面板（`layout.selectPanel` 在点击时现取，避免服务晚就绪导致按钮没反应）。
- 布局、标签都是 DSH 右侧栏的原生能力，刷新页面/重启 DSH 后仍保留。

### 启动的窗口不挡 DSH（自动最小化 / 移出屏幕）

通过 DSH 启动的窗口会被自动收起来，不再盖在 DSH 界面上：

- **安卓模拟器**：启动后自动**最小化**模拟器窗口和 qemu 控制台（命令提示符）；预览走 adb 镜像，不受影响。
- **导入的 Windows 应用**：窗口创建后自动**移到屏幕外**——注意不是真最小化，因为最小化后 `PrintWindow` 会黑屏、预览就没画面了；移到屏幕外既看不到窗口、预览又照常。
- 需要操作该 Windows 窗口时，在「桌面窗口」页点「**取回窗口**」（`desk.restore`）即可把它拿回屏幕并置前。
- 只处理「本次启动新出现的窗口」和「本次进程的窗口」，不会动你其它窗口；插件自己的 DSH 窗口永远排除在外。

底部日志面板实时滚动，可折叠、清空、自动跟随到底。

### Agent 工具 `live_preview`

写应用时模型可以直接调用，让面板同步显示：

```json
{ "action": "run", "command": "npm run dev", "cwd": "<你的项目目录>", "kind": "web" }
{ "action": "run", "command": "myapp.exe", "cwd": "<你的项目目录>\\\\build", "kind": "app" }
{ "action": "windows" }
{ "action": "select_window", "hwnd": 123456 }
{ "action": "android_emulator_install" }
{ "action": "android_emulator_start", "avd": "dsh_live_preview" }
{ "action": "android_emulator_status" }
{ "action": "android_emulator_stop" }
{ "action": "android_ffmpeg_install" }
{ "action": "android_devices" }
{ "action": "android_start" }
{ "action": "android_tap", "x": 540, "y": 960 }
{ "action": "status" }
```

动作全集：`status` `run` `stop` `web.url` `windows` `select_window` `activate_window`
`desk_stop` `android_devices` `android_install` `android_start` `android_stop`
`android_emulators` `android_emulator_install` `android_emulator_start`
`android_emulator_stop` `android_emulator_status` `android_ffmpeg_install`
`android_tap` `android_swipe` `android_key` `android_text`。

## 常见问题（新手先看这里）

- **需要先装 Node / Java / Android SDK 吗？** 不需要。Node 只在你自己的网页项目需要时才有；Java、Android SDK、模拟器、ffmpeg 都由插件面板里的按钮自动下载。
- **要下载多少、占多少磁盘？** 插件本身约 0.2MB；安卓模拟器整条约 2GB 下载、5–6GB 磁盘。只预览网页或 Windows 程序则不用装这些。
- **支持什么系统？** 网页和 Windows 窗口预览在 DSH 支持的桌面平台都能用；安卓模拟器需要 **Windows 10/11 x64 + CPU 虚拟化**（没开虚拟化会很慢，插件会提示）。
- **为什么 AI 会自己弹出预览？** 插件安装后会给所有会话加一条指令：做/改/交付应用时必须调用 `live_preview` 跑起来，所以不需要用户提醒。
- **模拟器里的应用怎么每次重启就没了？** 这是插件的行为：每次冷启动自动清掉上次安装的第三方应用，回到干净的应用列表，同时保留系统设置和简体中文语言；想保留应用可设环境变量 `DSH_LIVE_PREVIEW_KEEP_APPS=1`。
- **卡顿怎么办？** 面板里确认「硬件加速: AEHD/WHPX」已启用，并在「安装高清串流组件」后使用高清串流；模拟器以无窗口模式运行，不会挡住 DSH。
- **Google SDK 下载慢 / 失败？** Java、ffmpeg 已内置国内镜像；Android SDK 走 Google CDN，网络受限时需要代理后重试。
- **遇到问题去哪看？** 面板底部「日志」有每一步的报错；仍解决不了可以带日志内容提 issue。

## 实现

```
index.js            Host 入口：注册 live_preview 工具、装配服务与 web 路由
client.js           ModuleLoader 客户端：左侧栏图标 + 主面板页面
host/service.js     编排：run/logs/web/desk/android/emulator/stream 状态与动作（面板与工具共用）
host/server.js      /live-preview/api/* 路由 + /stream MJPEG 直播端点（挂在 DSH 自身 HTTP 服务上，同源）
host/runner.js      命令进程、日志采集、URL 自动探测、整树停止
host/windows.js     常驻 PowerShell 窗口捕获客户端（windows.ps1 做 P/Invoke）
host/android.js     adb 发现/下载、设备、截屏循环、输入注入
host/emulator.js    安卓模拟器一键安装（Java/SDK/镜像/AVD/加速）+ 启动/停止
host/ffmpeg.js      ffmpeg 定位与自动安装（npmmirror → BtbN → gyan，低速自动切源）
host/screenstream.js screenrecord H.264 → ffmpeg 解码 → MJPEG 帧源（30fps+，含帧率统计/自动轮换）
host/netutil.js     下载兜底（系统代理 + curl.exe，解决 Node fetch 连接超时）
host/util.js        日志环形缓冲、JSON 响应、进程树终止、窗口置前
```

- 无第三方运行时依赖，无构建步骤。
- 预览接口只接受本机回环请求；MJPEG 同时最多 6 路连接，无新帧时每秒补发最后一帧保活。
- Windows 画面串流约 6–10 fps（JPEG，最大宽 1600）；安卓走 30–60fps 高清串流。

## 已验证（本机实测）

- 一键安装：华为 OpenJDK 21（192MB）→ cmdline-tools（153MB）→ emulator + Android 15 系统镜像 + platforms（约 1.8GB）→ AVD `dsh_live_preview`（720×1600，2GB RAM）→ 加速检测；全程面板进度可见，耗时约 8 分钟（含一次 sdkmanager 重试）。
- 加速：AEHD 2.2 安装后 `emulator -accel-check` 报告 "AEHD (version 2.2) is installed and usable"，面板显示「硬件加速: AEHD」。
- 模拟器启动：冷启动 45 秒上线，插件自动选设备并开始高清串流；滚动 Settings 实测 **60 帧/秒**（连续 5 秒 350 帧），面板角标绿色「60 帧/秒」。
- 停止：面板「停止模拟器」→ 镜像停止、`adb emu kill`、进程退出。
- 合成 H.264 测试源（720×1600@30fps）经同一管线达 30.0fps（25–32），单帧约 37KB。

## 已知限制

- 模拟器安装需要约 5–6GB 磁盘与 2GB 左右下载；冷启动约 20–30 秒（之后模拟器常驻，插件重载/DSH 重启约 1 秒接管）。
- 没有 WHPX/AEHD 时模拟器会明显变慢（可能低于 30fps）；插件提供 AEHD 一键安装（会弹一次 UAC）。
- 部分 GPU 独占/DRM 的桌面窗口可能捕获为黑帧；最小化窗口会明确报错。
- 网页 dev server 若设置 `X-Frame-Options: DENY`，iframe 会被浏览器拒绝，可用「新窗口打开」兜底。
- 中文网络下 Google/GitHub 直连可能超时：ffmpeg/Java 已内置国内镜像，SDK 走 Google CDN（本机实测 20MB/s）；sdkmanager 失败会自动重试 3 次并透传系统代理。
- 导入的 MSI 只做识别不执行安装；ARM64 的 exe 在 x64 主机上会明确拒绝并提示。
- 导入 Windows 程序依赖"启动后新出现的窗口"来定位；如果是完全无窗口的后台程序，会提示 25 秒内没找到窗口。
- 导入的网页包按 ZIP/HTML 处理，不做构建（不会跑 npm）；需要构建的先构建出静态产物再打包。

## 版本

0.2.4 — 插件自带「AI 自动弹预览」提示：Host 通过 `systemPrompt.section` 注册全局指令（插件安装后对所有会话生效，不再需要项目里的 AGENTS.md），并强化 `live_preview` 工具描述里的“使用时机”；版本号同步到 package.json/index.js；修复右侧「启动/停止模拟器」按钮：停止后清除残留选中设备，面板会正确切回「启动模拟器」（此前会一直显示停止、再点无反应）；模拟器每次冷启动自动清理上次安装的第三方应用（保留系统设置与简体中文语言，可用 `DSH_LIVE_PREVIEW_KEEP_APPS=1` 关闭）。
0.2.3-dev（工作区） — 安卓页默认显示设置（不自动进专注预览）；右侧预览头部新增「启动模拟器 / 停止模拟器」；点击历史应用里的安卓版本时若模拟器没开会自动拉起（加载动画按“启模拟器 → 装包 → 启动”分阶段显示）；移除主面板「右侧同时看」按钮；模拟器改无窗口模式（避免图形崩溃）并常驻，插件重载秒接管。
0.2.2-dev（工作区） — 新增「应用版本」：导入同一应用的新版本时提示“需要保留哪个版本？”（双版本同跑，选择后 60 秒关闭未保留版本进程、文件保留）；新增「历史应用」面板（标记 / 删除版本）；Agent 工具 app_versions / app_version_choose / app_version_mark / app_version_delete。
0.2.1-dev（工作区） — 新增「导入应用文件」（APK / exe / HTML·ZIP 自动识别并运行）+ 右侧边栏「实时预览」与会话并排（画面启动时自动打开）；横屏游戏分辨率/点击映射修正；非本机窗口（子进程/商店应用）自动定位。
0.2.0 — 模拟器一键安装 + 30fps 高清串流（H.264/ffmpeg），真实模拟器实测 60fps。
0.1.0 — 首个可用版本：网页 / Windows 窗口 / 安卓 adb 三目标预览 + 日志 + Agent 工具。

---

如果这个插件帮到你，欢迎 Star、提 Issue，或分享给刚开始学 AI 编程的朋友。
