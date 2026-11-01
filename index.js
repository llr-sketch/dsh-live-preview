/**
 * dsh-live-preview — Host 入口。
 *
 * 一个左侧栏入口 + 主面板，用来在 DSH 窗口内实时查看“正在编写的应用”：
 *   - 网页：iframe 直接加载本地开发服务器 URL
 *   - Windows 原生窗口：实时捕获成 JPEG 帧（x64 / arm64 程序都适用，与架构无关）
 *   - 安卓真机 / 模拟器：adb 截屏成帧，并支持点击、滑动、按键、输入
 * 面板和 Agent 工具（live_preview）共用同一套服务，操作只实现一次。
 */
import os from 'node:os';
import { join } from 'node:path';
import { createPreviewService } from './host/service.js';
import { attachPreviewRoutes } from './host/server.js';

export const name = 'dsh-live-preview';
export const version = '0.2.4';

/** 工具与路由都需要的工具注册服务；webServer 在 apply 里按可用性注入。 */
export const inject = ['tools'];

const TOOL_NAME = 'live_preview';

const ACTIONS = [
  'status',
  'run',
  'stop',
  'web.url',
  'windows',
  'select_window',
  'activate_window',
  'desk_stop',
  'android_devices',
  'android_install',
  'android_start',
  'android_stop',
  'android_emulators',
  'android_emulator_install',
  'android_emulator_start',
  'android_emulator_stop',
  'android_emulator_status',
  'android_ffmpeg_install',
  'android_tap',
  'android_swipe',
  'android_key',
  'android_text',
  'android_restart_app',
  'import_app',
  'import_status',
  'app_versions',
  'app_version_choose',
  'app_version_mark',
  'app_version_delete',
  'app_version_open',
  'app_version_assign_session',
];

const ACTION_DOC = [
  'status: 查看当前运行/预览状态（默认动作）',
  'run: 启动一条命令并实时采集日志，自动从输出里探测本地 URL；参数 command(必填), cwd, kind("web"|"app"), url',
  'stop: 停止当前命令（整棵进程树）',
  'web.url: 直接设定网页预览地址；参数 url',
  'windows: 列出可见的 Windows 顶层窗口（hwnd/title/pid/rect）',
  'select_window: 选中一个窗口并在面板里实时串流画面；参数 hwnd',
  'activate_window: 把当前选中的窗口置前',
  'desk_stop: 停止桌面窗口串流',
  'android_devices: 列出 adb 设备（没装 adb 时先提示）',
  'android_install: 下载并安装 adb（platform-tools，约 8MB）',
  'android_start / android_stop: 开始/停止安卓画面镜像',
  'android_emulators: 列出本机 AVD 模拟器',
  'android_emulator_install: 一键安装安卓模拟器（Java + Android SDK + emulator + 系统镜像 + AVD，约 2GB，首次较久）',
  'android_emulator_start: 启动安卓模拟器并自动开始 30fps 高清串流；参数 avd（可选，默认 dsh_live_preview）',
  'android_emulator_stop: 停止安卓模拟器与镜像',
  'android_emulator_status: 查看模拟器安装进度、硬件加速状态、AVD 列表、串流 fps',
  'android_ffmpeg_install: 安装高清串流组件 ffmpeg（约 114MB）；装好后串流可到 30fps 以上',
  'android_tap: 点击设备；参数 x, y（设备像素）',
  'android_swipe: 在设备上滑动；参数 x1, y1, x2, y2, durationMs',
  'android_key: 按键；参数 key（back/home/enter/recents 等）',
  'android_text: 向设备输入文字；参数 text',
  'android_restart_app: 重启当前前台安卓应用（force-stop 后重新启动并重启镜像）；参数 packageName（可选）',
  'import_app: 导入并运行一个应用文件（自动识别系统：APK→安卓模拟器安装启动；exe→Windows 运行并捕获窗口；HTML/ZIP→网页预览）；参数 path（本机绝对路径）, name（可选显示名）',
  'import_status: 查看最近一次导入的识别结果/进度/错误',
  'app_versions: 列出所有历史应用版本与当前待选择的版本（旧/新）',
  'app_version_choose: 选择保留哪个版本（另一个版本 60 秒后关闭进程，文件保留）；参数 versionId',
  'app_version_mark: 标记/取消标记一个版本；参数 versionId, marked',
  'app_version_delete: 删除一个历史版本（文件一起删除）；参数 versionId',
  'app_version_open: 运行/切换到某个历史版本并开始预览（APK 会装回模拟器、exe 会重新启动、网页会切回该版本）；参数 versionId',
  'app_version_assign_session: 把旧版本归到指定对话（历史应用里「归到当前对话」用的就是它）；参数 versionIds（数组）或 versionId, sessionId',
].join('；');

const tool = {
  name: TOOL_NAME,
  description: [
    '在 DSH 窗口内实时运行并查看正在开发的应用（左侧栏「实时预览」面板同步显示画面与日志）。',
    '使用时机：当用户要求你制作、修改、运行、验证或交付应用程序（网页 / Windows 程序 / 安卓 APK），或让你检查应用运行效果时，你必须主动调用本工具把应用真正跑起来，不要只写代码就交付；运行起来后 DSH 右侧「实时预览」会自动打开，用户无需手动找面板。',
    '支持三类目标：①网页（本地 dev server URL，面板用 iframe 实时显示）；②Windows 原生桌面窗口（按 hwnd 实时捕获画面，x64/arm64 程序均可）；③安卓真机/模拟器（adb 高清镜像 30fps+ + 点击/滑动/按键/输入）。',
    '还可以导入应用文件：import_app {path:"C:\\\\path\\\\app.apk"} 自动识别 APK / Windows exe / HTML/ZIP 网页包并安装运行；左侧栏「实时预览」右侧边栏版本可与对话同时显示。',
    '典型用法：写完代码后 live_preview {action:"run", command:"npm run dev", cwd:"<项目目录>"} 启动，再从返回的 webUrl 或面板确认画面；桌面程序先 run 启动 exe，再 windows 找到窗口、select_window 串流；安卓没有模拟器时先 android_emulator_install（约 2GB，自动装 Java/SDK/emulator/系统镜像/AVD），再 android_emulator_start 启动并自动 30fps 串流；接真机则 android_devices → android_start，然后用 android_tap 操作。',
    '动作：', ACTION_DOC,
  ].join('\n'),
  parameters: {
    type: 'object',
    additionalProperties: true,
    properties: {
      action: {
        type: 'string',
        enum: ACTIONS,
        description: '要执行的动作；只看状态时用 status。',
      },
      command: { type: 'string', description: 'run 时启动的命令行（例如 "npm run dev"、"python app.py"、"start myapp.exe"）。' },
      cwd: { type: 'string', description: '运行命令时的工作目录；默认用当前会话工作区目录。' },
      kind: { type: 'string', enum: ['web', 'app'], description: 'run 的目标类型：web 会自动把探测到的 URL 填入网页预览；app 适合桌面程序。' },
      url: { type: 'string', description: '可直接指定网页预览地址（http/https）。' },
      hwnd: { type: 'number', description: 'Windows 窗口句柄，来自 windows 动作的返回。' },
      serial: { type: 'string', description: '安卓设备序列号，来自 android_devices。' },
      x: { type: 'number', description: 'android_tap 的设备像素 X。' },
      y: { type: 'number', description: 'android_tap 的设备像素 Y。' },
      x1: { type: 'number', description: 'android_swipe 起点 X。' },
      y1: { type: 'number', description: 'android_swipe 起点 Y。' },
      x2: { type: 'number', description: 'android_swipe 终点 X。' },
      y2: { type: 'number', description: 'android_swipe 终点 Y。' },
      durationMs: { type: 'number', description: 'android_swipe 滑动时长（毫秒，默认 300）。' },
      text: { type: 'string', description: 'android_text 要输入的文字。' },
      key: { type: 'string', description: 'android_key 的按键名：back/home/enter/recents/power/volume_up/volume_down 等。' },
      avd: { type: 'string', description: 'AVD 名称（android_emulator_start 用；默认 dsh_live_preview）。' },
      sdkRoot: { type: 'string', description: '自定义 Android SDK 根目录（用于找 adb/emulator）。' },
      path: { type: 'string', description: 'import_app 要导入的应用文件绝对路径（.apk / .exe / .html / .zip）。' },
      name: { type: 'string', description: 'import_app 的可选显示名。' },
      versionId: { type: 'string', description: 'app_version_choose / app_version_mark / app_version_delete / app_version_open 的版本 id。' },
      versionIds: { type: 'array', items: { type: 'string' }, description: 'app_version_assign_session 要迁移的版本 id 列表（可配合 sessionId）。' },
      sessionId: { type: 'string', description: 'app_version_assign_session 目标对话 id（把旧版本归到这个对话）。' },
      marked: { type: 'boolean', description: 'app_version_mark 用：true 标记，false 取消标记。' },
    },
    required: ['action'],
  },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => {
      const lines = [];
      if (value && typeof value === 'object') {
        const hint = value.hint;
        if (hint) lines.push(String(hint));
        for (const [key, item] of Object.entries(value)) {
          if (key === 'hint' || key === 'ok') continue;
          if (item === undefined || item === null) continue;
          lines.push(`${key}: ${typeof item === 'string' ? item : JSON.stringify(item)}`);
        }
        if (lines.length === 0) lines.push(value.ok === false ? '失败' : '完成');
      } else {
        lines.push(String(value));
      }
      return [{ type: 'text', text: lines.join('\n') }];
    },
  },
  isConcurrencySafe: () => false,
  async execute(args, exec) {
    const cwd = exec?.agent?.session?.header?.cwd ?? undefined;
    const sessionId = exec?.agent?.session?.header?.id ?? exec?.agent?.session?.id ?? undefined;
    return service.toolAction(args ?? {}, { cwd, sessionId });
  },
};

/** 插件级单例；apply 时创建，卸载时 dispose。 */
let service = null;

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config = {}) {
  const dataDir = resolveDataDir(config);
  service = createPreviewService({ dataDir, logger: ctx.logger });

  ctx.effect(() => () => {
    const current = service;
    service = null;
    return current?.dispose?.();
  }, 'dsh-live-preview: dispose');

  // Agent 工具：与面板共用同一套服务方法。
  ctx.effect(() => ctx.tools.register(tool), 'dsh-live-preview: tool');

  // 随插件分发的 Agent 提示：让所有会话的 AI 在做/交付应用后主动调用 live_preview。
  // 这样用户装完插件即生效，不需要在自己项目里放 AGENTS.md。
  try {
    ctx.inject(['systemPrompt'], (sctx) => {
      const systemPrompt = sctx.get?.('systemPrompt') ?? sctx.systemPrompt;
      if (!systemPrompt || typeof systemPrompt.section !== 'function') {
        ctx.logger?.warn?.('[dsh-live-preview] systemPrompt 不可用，自动预览提示未注册');
        return;
      }
      sctx.effect(
        () =>
          systemPrompt.section({
            name: 'dsh-live-preview:deliver-with-preview',
            order: 950,
            text: [
              '## 应用交付与实时预览（dsh-live-preview）',
              '当你在制作、修改、运行、验证或交付应用程序（网页、Windows 程序、安卓 APK）时：',
              '1. 交付前必须调用 `live_preview` 让应用真正跑起来：网页用 `{action:"run", command:"npm run dev", cwd:"<项目目录>"}`（或 `{action:"web.url", url:"..."}`）；Windows exe / 安卓 APK 用 `live_preview {action:"import_app", path:"<绝对路径>"}`。',
              '2. 启动后不要关闭预览：DSH 右侧「实时预览」会自动打开，把运行画面并排显示给用户。',
              '3. 需要对比/回退版本时用历史应用（`app_versions` / `app_version_open`），新版本导入后让用户选择保留哪个。',
              '4. 除非用户明确说不要运行，否则不要“只写代码不运行”地交付。',
              '5. 模拟器会常驻并自动接管：不要用命令行反复冷启动/强杀模拟器，启停一律走 `live_preview` 的安卓动作。',
            ].join('\n'),
          }),
        'dsh-live-preview: prompt section',
      );
    });
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-live-preview] 自动预览提示注册失败：${String(error?.message ?? error)}`);
  }

  // 面板接口：挂到 DSH 自己的 HTTP 服务上（同源，无需 CORS/端口）。
  try {
    ctx.inject(['webServer'], (sctx) => {
      const webServer = sctx.get?.('webServer') ?? sctx.webServer;
      if (!webServer || typeof webServer.register !== 'function') {
        ctx.logger?.warn?.('[dsh-live-preview] webServer 不可用，面板接口未注册');
        return;
      }
      sctx.effect(
        () => attachPreviewRoutes(webServer, service, { version }),
        'dsh-live-preview: routes',
      );
    });
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-live-preview] 路由注册失败：${String(error?.message ?? error)}`);
  }
}

/** 数据目录：优先 LOCALAPPDATA，其次用户主目录下的隐藏目录。 */
function resolveDataDir(config) {
  if (typeof config.dataDir === 'string' && config.dataDir.trim() !== '') return config.dataDir.trim();
  const base = process.env.LOCALAPPDATA || process.env.XDG_DATA_HOME || os.homedir();
  return join(base, 'dsh-live-preview');
}
