/**
 * dsh-live-preview — 编排层。
 *
 * 把三类“正在运行的应用”聚合成一份状态：
 *   web      网页预览（iframe，由客户端直接加载 URL）
 *   desk     Windows 原生窗口（host/windows.js 捕获成 JPEG 帧）
 *   android  安卓真机/模拟器（host/android.js 截屏 + 输入注入）
 * 再加上命令进程与日志。Agent 工具和 Web 面板都调用这里的同一组方法。
 */
import { RingLog, normalizeUrl, activateWindow, errorMessage, sleep } from './util.js';
import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { createRunner } from './runner.js';
import { createWindowsCapture } from './windows.js';
import { createAndroidBackend } from './android.js';
import { createEmulatorBackend } from './emulator.js';
import { createScreenStream } from './screenstream.js';
import { resolveFfmpeg, installFfmpeg, ffmpegVersion } from './ffmpeg.js';
import { detectAppFile, prepareWebApp, androidInstall as installAndroidApp, androidLaunch as launchAndroidApp, launchWindowsApp } from './importer.js';
import { createVersionStore } from './versions.js';

const DESK_FRAME_MAX_WIDTH = 1600;
const DESK_FRAME_QUALITY = 72;
const DESK_FRAME_MIN_INTERVAL = 80;

/**
 * @param {object} options
 * @param {string} options.dataDir 插件数据目录（platform-tools 等）
 * @param {object} [options.logger]
 */
export function createPreviewService({ dataDir, logger }) {
  const log = new RingLog(3000);
  const web = { url: null, autoDetected: false };
  const config = {
    cwd: process.cwd(),
    dataDir,
    sdkRoot: process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME || null,
  };

  // —— 导入应用文件 ——
  const importsDir = path.join(dataDir, 'imports');
  const importState = {
    importing: false,
    name: null,
    kind: null,
    format: null,
    arch: null,
    detail: null,
    progress: null,
    error: null,
    startedAt: null,
    finishedAt: null,
    result: null,
    history: [],
  };
  /** token → { dir, entry }：导入的网页包（由 /live-preview/app/* 提供静态文件）。 */
  const webApps = new Map();
  fsp.mkdir(importsDir, { recursive: true }).catch(() => {});

  // —— 应用版本：每次导入/交付记一条，供「历史应用」和“保留哪个版本”使用 ——
  const versionStore = createVersionStore({ dataDir, logger });
  void versionStore.ready().catch((error) => log.push('stderr', `[版本] 索引加载失败：${errorMessage(error)}`));
  const versionState = {
    /** { appKey, appName, oldVersion, newVersion, chosenId, chosenNew, decidedAt, closesAt } */
    choice: null,
    /** 60 秒后关闭未保留版本进程的定时器。 */
    timer: null,
    timerUnchosenId: null,
    /** 当前正在运行/预览的版本 id（安卓无法从进程反查版本时用它标记“运行中”）。 */
    activeVersionId: null,
    /** 正在切换/启动的版本：面板显示加载动画直到新程序就绪。 */
    opening: null,
  };

  const desk = {
    selectedHwnd: null,
    selectedTitle: null,
    streaming: false,
    error: null,
    lastFrameAt: 0,
    frames: [],
    lastBuf: null,
    lastBufAt: 0,
    capturing: false,
  };

  let windowsCapture = null;
  let disposed = false;

  const runner = createRunner({
    onLog: (stream, text) => {
      log.push(stream, text);
    },
    onUrl: (url) => {
      if (web.autoDetected && web.url === url) return;
      web.url = url;
      web.autoDetected = true;
      log.push('system', `[预览] 从日志里识别到地址：${url}`);
    },
    onChange: () => {},
  });

  const androidState = {
    streaming: false,
    error: null,
    lastFrameAt: 0,
    installing: false,
    installError: null,
    lastFrame: null,
    statusCache: null,
    statusAt: 0,
    serial: null,
    /** 最近一次由插件启动/重启的安卓应用包名（重启按钮的前台兜底）。 */
    lastAppPackage: null,
  };
  const lastAppFile = path.join(importsDir, 'last-app.json');
  fsp
    .readFile(lastAppFile, 'utf8')
    .then((text) => {
      const parsed = JSON.parse(text || '{}');
      if (parsed && typeof parsed.packageName === 'string' && parsed.packageName) {
        androidState.lastAppPackage = parsed.packageName;
      }
    })
    .catch(() => {});
  /** 记住“插件刚启动过的应用”，供前台是桌面时兜底。 */
  function rememberAndroidApp(packageName) {
    const pkg = String(packageName || '').trim();
    if (!pkg) return;
    androidState.lastAppPackage = pkg;
    fsp
      .writeFile(lastAppFile, JSON.stringify({ packageName: pkg, at: Date.now() }, null, 2), 'utf8')
      .catch(() => {});
  }
  const android = createAndroidBackend({
    dataDir,
    logger,
    getSdkRoot: () => config.sdkRoot,
  });

  // ── 模拟器 / ffmpeg / 30fps 串流 ─────────────────────────────────────────
  const ffmpegState = {
    path: null,
    version: null,
    installing: false,
    progress: null,
    lastError: null,
    resolving: null,
  };
  let emulatorProgressKey = '';
  const emulator = createEmulatorBackend({
    dataDir,
    logger,
    onLog: (entry, maybeText) => {
      const text = typeof entry === 'string'
        ? (maybeText ?? entry)
        : (entry?.message ?? entry?.text ?? entry?.detail ?? '');
      if (text) log.push('system', `[模拟器] ${text}`);
    },
    onProgress: (progress) => {
      if (!progress || typeof progress !== 'object') return;
      const step = progress.step ?? progress.phase ?? null;
      const detail = progress.detail ?? progress.text ?? '';
      if (!step && !detail) return;
      const percent = Number(progress.percent);
      const bucket = Number.isFinite(percent) ? Math.floor(percent / 10) * 10 : -1;
      const key = `${step}|${bucket}|${detail}`;
      if (key === emulatorProgressKey) return;
      emulatorProgressKey = key;
      const suffix = Number.isFinite(percent) ? ` ${percent}%` : '';
      log.push('system', `[模拟器] ${step ?? '安装'}${suffix}${detail ? ` · ${detail}` : ''}`);
    },
  });

  let stream = null;
  function getStream() {
    if (stream) return stream;
    stream = createScreenStream({
      dataDir,
      logger,
      ffmpegPath: () => ffmpegState.path,
      getAdbPath: () => androidState.statusCache?.adb?.path ?? null,
      getSerial: () => androidState.serial ?? androidState.statusCache?.device ?? null,
    });
    return stream;
  }

  /** 异步探测已安装的 ffmpeg（不阻塞插件启动）。 */
  function refreshFfmpeg() {
    if (ffmpegState.resolving) return ffmpegState.resolving;
    ffmpegState.resolving = (async () => {
      try {
        const found = await resolveFfmpeg(dataDir);
        if (!found) {
          ffmpegState.path = null;
          ffmpegState.version = null;
          return null;
        }
        if (ffmpegState.path !== found) {
          ffmpegState.path = found;
          ffmpegState.version = await ffmpegVersion(found);
          log.push('system', `[串流] 已找到 ffmpeg：${found}${ffmpegState.version ? `（${ffmpegState.version}）` : ''}`);
        }
        return found;
      } catch (error) {
        ffmpegState.lastError = errorMessage(error);
        return null;
      } finally {
        ffmpegState.resolving = null;
      }
    })();
    return ffmpegState.resolving;
  }
  refreshFfmpeg();

  // 启动后异步探测一次硬件加速（emulator -accel-check，约 1s），让面板直接显示真实状态。
  setTimeout(() => {
    emulator
      .checkAccel?.()
      .then(() => {
        androidState.statusCache = null;
      })
      .catch(() => {
        /* 没有模拟器时忽略 */
      });
  }, 1500).unref?.();

  if (config.sdkRoot) {
    try {
      android.setSdkRoot?.(config.sdkRoot);
    } catch {
      /* 记录在 android 自己的错误里即可 */
    }
  }

  log.push('system', `[预览] 插件已就绪（数据目录：${dataDir}）`);

  function getWindowsCapture() {
    if (!windowsCapture) windowsCapture = createWindowsCapture({ logger });
    return windowsCapture;
  }

  function setDeskError(error) {
    const message = errorMessage(error);
    if (desk.error !== message) log.push('system', `[桌面] ${message}`);
    desk.error = message;
  }

  function noteDeskFrame() {
    const now = Date.now();
    desk.lastFrameAt = now;
    desk.frames.push(now);
    if (desk.frames.length > 40) desk.frames.splice(0, desk.frames.length - 40);
  }

  function deskFps() {
    const cutoff = Date.now() - 1000;
    return desk.frames.filter((t) => t >= cutoff).length;
  }

  /** 桌面窗口：取一帧 JPEG，带缓存与并发合并，避免客户端轮询把 PowerShell 打爆。 */
  async function deskFrame() {
    if (!desk.streaming || !desk.selectedHwnd) return null;
    const now = Date.now();
    if (desk.lastBuf && now - desk.lastBufAt < DESK_FRAME_MIN_INTERVAL) return desk.lastBuf;
    if (desk.capturing) return desk.lastBuf;
    desk.capturing = true;
    try {
      const buf = await getWindowsCapture().capture(desk.selectedHwnd, {
        maxWidth: DESK_FRAME_MAX_WIDTH,
        quality: DESK_FRAME_QUALITY,
      });
      if (buf && buf.length > 0) {
        desk.lastBuf = buf;
        desk.lastBufAt = Date.now();
        noteDeskFrame();
        if (desk.error) {
          desk.error = null;
          log.push('system', '[桌面] 画面已恢复');
        }
        return buf;
      }
      setDeskError('窗口捕获返回空帧');
      return desk.lastBuf;
    } catch (error) {
      setDeskError(error);
      return desk.lastBuf;
    } finally {
      desk.capturing = false;
    }
  }

  // 旋转方向的短缓存：横屏游戏时把 720×1600 换成 1600×720，
  // 否则面板里的点击/滑动坐标会按竖屏换算，落点全错。
  const rotationCache = { at: 0, value: 0, key: '' };
  function detectRotation(adbPath, serial) {
    const key = `${adbPath}|${serial}`;
    const now = Date.now();
    if (rotationCache.key === key && now - rotationCache.at < 2000) return Promise.resolve(rotationCache.value);
    return new Promise((resolve) => {
      let out = '';
      let finished = false;
      const done = (value) => {
        if (finished) return;
        finished = true;
        rotationCache.key = key;
        rotationCache.at = Date.now();
        rotationCache.value = value;
        resolve(value);
      };
      try {
        const child = spawn(adbPath, ['-s', serial, 'shell', 'dumpsys', 'display'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        const timer = setTimeout(() => {
          try { child.kill(); } catch { /* ignore */ }
          done(rotationCache.value);
        }, 2500);
        child.stdout.on('data', (chunk) => { out += chunk; if (out.length > 60000) out = out.slice(-60000); });
        child.once('error', () => { clearTimeout(timer); done(rotationCache.value); });
        child.once('exit', () => {
          clearTimeout(timer);
          const match = /mCurrentOrientation=(\d)/.exec(out);
          done(match ? Number(match[1]) : rotationCache.value);
        });
      } catch {
        done(rotationCache.value);
      }
    });
  }

  async function androidStatus(force = false) {    const now = Date.now();
    const ttl = androidState.statusCache && androidState.statusCache.emulator?.installing ? 400 : 2500;
    if (!force && androidState.statusCache && now - androidState.statusAt < ttl) {
      return androidState.statusCache;
    }
    let status;
    try {
      status = await android.status();
    } catch (error) {
      androidState.error = errorMessage(error);
      status = { available: false, path: null, version: null, devices: [], device: null, resolution: null, emulator: { available: false, avds: [] } };
    }
    // 设备被停止/掉线后 adb 列表里已经没有了：不要继续把旧的选中设备当作在线。
    if (
      status.device &&
      status.deviceConnected === false &&
      (!Array.isArray(status.devices) || status.devices.length === 0)
    ) {
      status = { ...status, device: null, resolution: null };
      androidState.serial = null;
    }
    // 插件重载/接管已在运行的模拟器时没有“选择设备”这一步：只有一个设备就自动选上。
    if (!status.device && Array.isArray(status.devices) && status.devices.length === 1) {
      const onlySerial = status.devices[0] && status.devices[0].serial;
      if (onlySerial) {
        try {
          await selectDeviceWithRetry(onlySerial);
          androidState.serial = onlySerial;
          status = { ...status, device: onlySerial };
          log.push('system', `[安卓] 自动接管设备 ${onlySerial}`);
        } catch (error) {
          log.push('system', `[安卓] 自动选择设备 ${onlySerial} 失败：${errorMessage(error)}`);
        }
      }
    }
    let emulatorStatus;
    try {
      emulatorStatus = await emulator.status();
    } catch (error) {
      emulatorStatus = {
        installed: false,
        installing: false,
        progress: null,
        accel: { checked: false, usable: false, detail: errorMessage(error), mode: 'unknown' },
        avds: [],
        running: false,
        lastError: errorMessage(error),
      };
    }
    if (!emulatorStatus.avdRunning && status.device) {
      // 接管场景：插件重载后后端没有子进程句柄，但 adb 有在线模拟器，视为运行中。
      emulatorStatus = { ...emulatorStatus, avdRunning: true, serial: status.device };
    }
    // 以当前屏幕旋转方向修正分辨率（横屏游戏 = 宽高互换）。
    let resolution = status.resolution ?? null;
    // 接管已有设备时可能没走 select()，这里补一次拿分辨率（面板点击坐标依赖它）。
    if (!resolution && status.device && status.path) {
      try {
        const selected = await android.select(status.device);
        if (selected && selected.resolution) resolution = selected.resolution;
      } catch (error) {
        log.push('system', `[安卓] 获取分辨率失败：${errorMessage(error)}`);
      }
    }
    if (resolution && resolution.width && resolution.height && status.device && status.path) {
      try {
        const rotation = await detectRotation(status.path, status.device);
        if (rotation % 2 === 1) resolution = { width: resolution.height, height: resolution.width };
      } catch {
        /* 拿不到旋转就用原分辨率 */
      }
    }
    const streamStats = getStream().stats();
    const merged = {
      supported: true,
      adb: { available: !!status.available, path: status.path ?? null, version: status.version ?? null },
      installing: androidState.installing,
      installError: androidState.installError,
      devices: Array.isArray(status.devices) ? status.devices : [],
      device: status.device ?? null,
      serial: androidState.serial ?? status.device ?? null,
      streaming: androidState.streaming,
      resolution,
      error: androidState.error ?? status.error ?? null,
      lastFrameAt: streamStats.lastFrameAt || androidState.lastFrameAt || null,
      emulator: {
        ...emulatorStatus,
        installed: !!(emulatorStatus.sdkReady && emulatorStatus.emulatorPath),
        emulatorReady: !!emulatorStatus.emulatorPath,
        running: !!emulatorStatus.avdRunning,
        ffmpeg: {
          available: !!ffmpegState.path,
          path: ffmpegState.path,
          version: ffmpegState.version,
          installing: ffmpegState.installing,
          progress: ffmpegState.progress,
          error: ffmpegState.lastError,
        },
      },
      stream: {
        mode: streamStats.mode === 'h264' && streamStats.running ? 'h264' : (androidState.streaming ? 'screencap' : 'idle'),
        running: !!streamStats.running,
        fps: Number(streamStats.fps) || 0,
        frames: Number(streamStats.frames) || 0,
        lastFrameAt: streamStats.lastFrameAt || androidState.lastFrameAt || null,
        detail: streamStats.detail ?? null,
        errors: Number(streamStats.errors) || 0,
      },
    };
    androidState.statusCache = merged;
    androidState.statusAt = now;
    return merged;
  }

  /** 跑一条 adb 命令并收集输出（带超时）。 */
  function runAdbCapture(adbPath, args, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      let out = '';
      let err = '';
      let settled = false;
      const child = spawn(adbPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result);
      };
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        finish(new Error('adb 命令超时'));
      }, timeoutMs);
      child.stdout.on('data', (chunk) => {
        out += chunk;
      });
      child.stderr.on('data', (chunk) => {
        err += chunk;
      });
      child.once('error', (error) => finish(error));
      child.once('exit', (code) => finish(null, { code, out, err }));
    });
  }

  /** 当前前台应用包名（两种 dumpsys 兜底）。 */
  async function detectForegroundPackage(adbPath, serial) {
    try {
      const focus = await runAdbCapture(adbPath, ['-s', serial, 'shell', 'dumpsys', 'activity', 'activities'], 12000);
      const match = /topResumedActivity=ActivityRecord\{[^}]*?\s([A-Za-z0-9_.]+)\//.exec(focus.out || '');
      if (match) return match[1];
    } catch {
      /* ignore */
    }
    try {
      const win = await runAdbCapture(adbPath, ['-s', serial, 'shell', 'dumpsys', 'window'], 12000);
      const match = /mCurrentFocus=Window\{[^}]*?\s([A-Za-z0-9_.]+)\//.exec(win.out || '');
      if (match) return match[1];
    } catch {
      /* ignore */
    }
    return null;
  }

  /** 重启当前前台安卓应用：force-stop → 启动 → 重启镜像。 */
  async function androidRestartApp(packageName) {
    const status = await androidStatus(true);
    if (!status.device) throw new Error('没有在线的安卓设备');
    const adbPath = status.adb.path;
    const serial = status.device;
    const foreground = packageName ? String(packageName) : await detectForegroundPackage(adbPath, serial);
    // 前台是桌面/系统界面时不能重启它：用“插件最近启动过的应用”兜底。
    let pkg = foreground && !/launcher|systemui|permissioncontroller|settings/i.test(foreground) ? foreground : null;
    if (!pkg) pkg = androidState.lastAppPackage || null;
    if (!pkg && importState.result && importState.result.kind === 'android' && importState.result.packageName) {
      pkg = importState.result.packageName;
    }
    if (!pkg) throw new Error('当前前台是桌面，插件还不知道要重启哪个应用：先在模拟器里打开或导入一个应用，再点「重启应用」');
    rememberAndroidApp(pkg);
    log.push('system', `[安卓] 重启应用：${pkg}`);
    await runAdbCapture(adbPath, ['-s', serial, 'shell', 'am', 'force-stop', pkg], 15000);
    await sleep(600);
    const launched = await runAdbCapture(
      adbPath,
      ['-s', serial, 'shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'],
      20000
    );
    await sleep(900);
    if (androidState.streaming) {
      try {
        await androidStop();
        await sleep(700);
        await androidStart();
      } catch (error) {
        log.push('system', `[安卓] 重启镜像失败：${errorMessage(error)}`);
      }
    }
    return { packageName: pkg, output: String(launched.out || '').trim().split('\n').slice(-2).join(' ').slice(0, 300) };
  }

  /** 安卓镜像一帧（优先 30fps 高清串流，降级截图轮询）。 */
  function androidFrame() {
    if (!androidState.streaming) return null;
    try {
      if (androidStreamMode() === 'h264') {
        const frame = getStream().getFrame();
        if (frame && frame.data && frame.data.length > 0) {
          androidState.lastFrameAt = frame.ts || Date.now();
          androidState.lastFrame = frame;
          return frame;
        }
        return androidState.lastFrame;
      }
      const frame = android.frame?.();
      if (frame && frame.data && frame.data.length > 0) {
        androidState.lastFrame = frame;
        androidState.lastFrameAt = Date.now();
        if (androidState.error) androidState.error = null;
        return frame;
      }
    } catch (error) {
      androidState.error = errorMessage(error);
    }
    return androidState.lastFrame;
  }

  /** 当前高清串流模式：'h264' | 'screencap' | 'idle'。 */
  function androidStreamMode() {
    const stats = getStream().stats();
    if (stats.mode === 'h264' && stats.running) return 'h264';
    if (androidState.streaming) return 'screencap';
    return 'idle';
  }

  /** MJPEG 端点订阅（仅 h264 模式有帧；保留接口给 server.js）。 */
  function subscribeAndroidFrames(listener) {
    if (androidStreamMode() !== 'h264') return () => {};
    return getStream().subscribe(listener);
  }

  /** 网页预览地址。 */
  function setWebUrl(input) {
    const url = normalizeUrl(input);
    if (!url) throw new Error('URL 必须是 http(s) 地址');
    web.url = url;
    web.autoDetected = false;
    log.push('system', `[网页] 预览地址设为 ${url}`);
    return url;
  }

  async function runCommand({ command, cwd, kind, url }) {
    const targetCwd = cwd ? String(cwd) : config.cwd;
    config.cwd = targetCwd;
    const result = await runner.start({ command, cwd: targetCwd });
    if (kind === 'web' && url) {
      try {
        setWebUrl(url);
      } catch (error) {
        log.push('system', `[网页] 忽略无效 URL：${errorMessage(error)}`);
      }
    }
    return result;
  }

  async function deskList() {
    try {
      const windows = await getWindowsCapture().list();
      return windows.map((item) => ({
        hwnd: item.hwnd,
        title: item.title,
        pid: item.pid,
        className: item.className ?? '',
        rect: item.rect ?? [0, 0, 0, 0],
      }));
    } catch (error) {
      setDeskError(error);
      throw error;
    }
  }

  async function deskSelect(hwnd) {
    const id = Number(hwnd);
    if (!Number.isFinite(id) || id <= 0) throw new Error('hwnd 无效');
    const info = await getWindowsCapture().info(id);
    desk.selectedHwnd = id;
    desk.selectedTitle = info.title ?? `#${id}`;
    desk.streaming = true;
    desk.error = null;
    desk.lastBuf = null;
    desk.lastBufAt = 0;
    log.push('system', `[桌面] 开始串流窗口「${desk.selectedTitle}」(${id})`);
    return { hwnd: id, title: desk.selectedTitle };
  }

  function deskStop() {
    if (desk.streaming) log.push('system', '[桌面] 停止串流');
    desk.streaming = false;
    desk.selectedHwnd = null;
    desk.selectedTitle = null;
    desk.lastBuf = null;
    desk.error = null;
    return { stopped: true };
  }

  async function deskActivate() {
    if (!desk.selectedHwnd) throw new Error('还没有选择窗口');
    const ok = await activateWindow(desk.selectedHwnd);
    if (!ok) throw new Error('窗口置前失败（可能已被关闭或权限不足）');
    return { activated: true };
  }

  async function androidInstall() {
    if (androidState.installing) throw new Error('adb 正在安装中');
    androidState.installing = true;
    androidState.installError = null;
    log.push('system', '[安卓] 开始下载 platform-tools …');
    try {
      const result = await android.install();
      log.push('system', `[安卓] adb 安装完成：${result?.path ?? ''} ${result?.version ?? ''}`.trim());
      androidState.statusCache = null;
      return result;
    } catch (error) {
      androidState.installError = errorMessage(error);
      log.push('stderr', `[安卓] adb 安装失败：${androidState.installError}`);
      throw error;
    } finally {
      androidState.installing = false;
      androidState.statusCache = null;
    }
  }

  async function androidDevices(force = true) {
    try {
      const devices = await android.devices();
      androidState.statusCache = null;
      return devices;
    } catch (error) {
      androidState.error = errorMessage(error);
      throw error;
    }
  }

  async function androidSelect(serial) {
    if (!serial || typeof serial !== 'string') throw new Error('serial 无效');
    const result = await android.select(serial);
    androidState.serial = serial;
    androidState.statusCache = null;
    log.push('system', `[安卓] 已选择设备 ${serial}`);
    return result;
  }

  /** quickboot 刚恢复时 adb 可能短暂 "error: closed"，重试几次再算失败。 */
  async function selectDeviceWithRetry(serial, attempts = 4) {
    let lastError = null;
    for (let index = 0; index < attempts; index += 1) {
      try {
        const result = await androidSelect(serial);
        return result;
      } catch (error) {
        lastError = error;
        if (index < attempts - 1) await sleep(600);
      }
    }
    throw lastError || new Error('选择设备失败');
  }

  async function androidStart() {
    const status = await androidStatus(true);
    if (!status.adb.available) throw new Error('adb 不可用，请先安装');
    const serial = status.device ?? androidState.serial;
    if (!serial) throw new Error('还没有选择安卓设备');
    androidState.serial = serial;

    // 首选 30fps 高清串流；ffmpeg 不可用或启动失败时降级截图轮询。
    let mode = 'screencap';
    try {
      // 快照恢复/息屏时 screenrecord 可能启动失败：先唤醒屏幕再起串流。
      try {
        await runAdbCapture(status.adb.path, ['-s', serial, 'shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], 5000);
      } catch {
        /* ignore */
      }
      await refreshFfmpeg();
      if (ffmpegState.path) {
        let result = await getStream().start();
        if (!(result?.ok && result.mode === 'h264')) {
          log.push('system', `[串流] 高清串流首次启动失败（${result?.detail || '未知原因'}），1.2 秒后重试一次…`);
          await sleep(1200);
          try {
            await getStream().stop();
          } catch {
            /* ignore */
          }
          result = await getStream().start();
        }
        if (result?.ok && result.mode === 'h264') {
          mode = 'h264';
        } else if (result?.detail) {
          log.push('system', `[串流] 高清串流不可用，降级截图轮询：${result.detail}`);
        }
      } else {
        log.push('system', '[串流] 未安装 ffmpeg，使用截图轮询（点「安装高清串流组件」可解锁 30fps）');
      }
    } catch (error) {
      log.push('system', `[串流] 高清串流启动失败，降级截图轮询：${errorMessage(error)}`);
    }
    if (mode !== 'h264') {
      await android.start();
    }
    androidState.streaming = true;
    androidState.error = null;
    androidState.statusCache = null;
    log.push('system', `[安卓] 开始镜像 ${serial}（${mode === 'h264' ? '高清串流' : '截图轮询'}）`);
    return { streaming: true, mode };
  }

  async function androidStop() {
    try {
      await getStream().stop();
    } catch {
      /* ignore */
    }
    try {
      await android.stop();
    } catch {
      /* ignore */
    }
    androidState.streaming = false;
    androidState.lastFrame = null;
    androidState.statusCache = null;
    log.push('system', '[安卓] 停止镜像');
    return { streaming: false };
  }

  // ── 模拟器 / ffmpeg 动作 ─────────────────────────────────────────────────
  async function androidEmulatorInstall() {
    log.push('system', '[模拟器] 开始一键安装：Java + Android SDK + 模拟器 + 系统镜像（约 2GB，请保持网络）');
    try {
      const result = await emulator.install();
      log.push('system', '[模拟器] 安装完成');
      androidState.statusCache = null;
      await refreshFfmpeg();
      return result;
    } catch (error) {
      log.push('stderr', `[模拟器] 安装失败：${errorMessage(error)}`);
      throw error;
    }
  }

  /** 模拟器每次冷启动后清掉上次安装的第三方应用（保留系统设置，例如简体中文语言）。 */
  async function resetAndroidUserApps(adbPath, serial) {
    if (process.env.DSH_LIVE_PREVIEW_KEEP_APPS === '1') {
      log.push('system', '[模拟器] 已设置保留应用（DSH_LIVE_PREVIEW_KEEP_APPS=1），跳过清理');
      return;
    }
    try {
      const listed = await runAdbCapture(adbPath, ['-s', serial, 'shell', 'pm', 'list', 'packages', '-3'], 15000);
      const packages = String(listed.out || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith('package:'))
        .map((line) => line.slice('package:'.length))
        .filter(Boolean);
      if (packages.length === 0) {
        log.push('system', '[模拟器] 已恢复初始应用列表（没有上次安装的第三方应用）');
        return;
      }
      let removed = 0;
      for (const pkg of packages) {
        try {
          const res = await runAdbCapture(adbPath, ['-s', serial, 'shell', 'pm', 'uninstall', '--user', '0', pkg], 30000);
          if (/Success/i.test(String(res.out || ''))) removed += 1;
          else log.push('warn', `[模拟器] 清理应用失败：${pkg}（${String(res.out || res.err || '').trim().slice(0, 120)}）`);
        } catch (error) {
          log.push('warn', `[模拟器] 清理应用失败：${pkg}（${errorMessage(error)}）`);
        }
      }
      log.push('system', `[模拟器] 已恢复初始应用列表：清理了 ${removed}/${packages.length} 个上次安装的应用（系统设置与语言保留）`);
    } catch (error) {
      log.push('warn', `[模拟器] 恢复初始应用列表失败：${errorMessage(error)}`);
    }
  }

  async function androidEmulatorStart(avd) {
    const baseline = await windowBaseline();
    const result = await emulator.launch(avd);
    // 模拟器会弹出自己的窗口和 qemu 控制台（命令提示符），都会盖住 DSH：
    // 启动后把它们自动最小化；截屏走 adb，最小化不影响预览。
    startWindowTamer({
      pid: result?.pid,
      baseline,
      titlePatterns: [/Android Emulator -/i, /qemu-system-x86_64/i, /emulator(\.exe)?$/i],
      action: 'minimize',
      durationMs: 180000,
      label: '模拟器窗口',
    });
    const serial = result?.serial ?? (await emulator.deviceSerial());
    if (serial) {
      try {
        await selectDeviceWithRetry(serial);
        androidState.serial = serial;
      } catch (error) {
        log.push('system', `[模拟器] 选择设备失败：${errorMessage(error)}`);
      }
    }
    // 启动后刷新加速状态，面板可直接显示 AEHD/WHPX 而不是"检测中"。
    try {
      await emulator.checkAccel?.();
    } catch {
      /* ignore */
    }
    androidState.statusCache = null;
    await sleep(400);
    // 每次冷启动后清掉上次装的应用：模拟器恢复“初始应用列表”，系统设置（语言等）保留。
    if (serial) {
      try {
        const st = await androidStatus(true);
        if (st.adb.path) await resetAndroidUserApps(st.adb.path, serial);
      } catch (error) {
        log.push('warn', `[模拟器] 清理上次安装的应用失败：${errorMessage(error)}`);
      }
    }
    await androidStart();
    return { ...result, serial: serial ?? null, streaming: androidState.streaming, mode: androidStreamMode() };
  }

  async function androidEmulatorStop() {
    await androidStop();
    const result = await emulator.stop();
    // 清掉“选中设备”，否则 adb 里已经没有设备时面板还显示在线、按钮还写“停止模拟器”。
    try {
      await android.forgetDevice?.();
    } catch {
      /* ignore */
    }
    androidState.serial = null;
    androidState.statusCache = null;
    return result;
  }

  async function androidEmulatorAccelInstall() {
    const result = await emulator.installAccel();
    androidState.statusCache = null;
    return result;
  }

  async function androidFfmpegInstall() {
    if (ffmpegState.installing) throw new Error('ffmpeg 正在安装中');
    ffmpegState.installing = true;
    ffmpegState.lastError = null;
    ffmpegState.progress = null;
    log.push('system', '[串流] 开始安装 ffmpeg（约 114MB）…');
    try {
      const result = await installFfmpeg(dataDir, (progress) => {
        ffmpegState.progress = progress;
        const percent = Number(progress?.percent);
        const bucket = Number.isFinite(percent) ? Math.floor(percent / 20) * 20 : -1;
        const key = `${progress?.phase}|${bucket}`;
        if (key === ffmpegProgressKey) return;
        ffmpegProgressKey = key;
        log.push('system', `[串流] ffmpeg ${progress?.phase ?? '安装'}${Number.isFinite(percent) ? ` ${percent}%` : ''}`);
      });
      ffmpegState.path = result.path;
      ffmpegState.version = result.version;
      log.push('system', `[串流] ffmpeg 安装完成：${result.path}${result.version ? `（${result.version}）` : ''}`);
      // 正在截图轮询的话自动升级为高清串流
      if (androidState.streaming && androidStreamMode() !== 'h264') {
        try {
          const started = await getStream().start();
          if (started?.ok && started.mode === 'h264') {
            log.push('system', '[串流] 已自动切换为 30fps 高清串流');
            androidState.statusCache = null;
          }
        } catch (error) {
          log.push('system', `[串流] 自动切换高清失败：${errorMessage(error)}`);
        }
      }
      return result;
    } catch (error) {
      ffmpegState.lastError = errorMessage(error);
      log.push('stderr', `[串流] ffmpeg 安装失败：${ffmpegState.lastError}`);
      throw error;
    } finally {
      ffmpegState.installing = false;
      ffmpegState.progress = null;
    }
  }
  let ffmpegProgressKey = '';

  async function androidInput(action, payload) {
    switch (action) {
      case 'android.tap':
        return android.tap(Number(payload.x), Number(payload.y));
      case 'android.swipe':
        return android.swipe(Number(payload.x1), Number(payload.y1), Number(payload.x2), Number(payload.y2), Number(payload.durationMs) || 300);
      case 'android.text':
        return android.text(String(payload.text ?? ''));
      case 'android.key':
        return android.key(String(payload.key ?? ''));
      default:
        throw new Error(`未知的安卓输入动作：${action}`);
    }
  }

  /** 处理一条 HTTP/tool 动作，返回 JSON 可序列化结果。 */
  async function action(payload) {
    const actionName = String(payload?.action ?? '');
    const singleLine = (value) => {
      try {
        log.push('system', `[操作] ${actionName} → ${typeof value === 'string' ? value : JSON.stringify(value)}`);
      } catch {
        /* ignore */
      }
    };
    let result;
    switch (actionName) {
      case 'run':
        result = await runCommand({
          command: payload.command,
          cwd: payload.cwd,
          kind: payload.kind,
          url: payload.url,
        });
        singleLine(result.id);
        return { ok: true, run: result };
      case 'stop':
        await runner.stop();
        return { ok: true, stopped: true };
      case 'web.url':
        return { ok: true, url: setWebUrl(payload.url) };
      case 'desk.list': {
        const windows = await deskList();
        singleLine(`${windows.length} 个窗口`);
        return { ok: true, windows };
      }
      case 'desk.select': {
        const info = await deskSelect(payload.hwnd);
        return { ok: true, selected: info };
      }
      case 'desk.stop':
        deskStop();
        return { ok: true };
      case 'desk.activate':
        return { ok: true, ...(await deskActivate()) };
      case 'desk.restore': {
        if (!desk.selectedHwnd) throw new Error('还没有选中的桌面窗口');
        const result = await getWindowsCapture().onscreen(desk.selectedHwnd);
        return { ok: true, restored: result };
      }
      case 'android.install': {
        const installed = await androidInstall();
        return { ok: true, adb: installed };
      }
      case 'android.devices': {
        const devices = await androidDevices(true);
        const status = await androidStatus(true);
        return { ok: true, devices, adb: status.adb };
      }
      case 'android.select': {
        const selected = await androidSelect(payload.serial);
        return { ok: true, selected };
      }
      case 'android.start':
        return { ok: true, ...(await androidStart()) };
      case 'android.stop':
        return { ok: true, ...(await androidStop()) };
      case 'android.restart_app': {
        const restarted = await androidRestartApp(payload.packageName ? String(payload.packageName) : undefined);
        return { ok: true, restarted };
      }
      case 'android.emulators': {
        const emulator = await android.avds();
        return { ok: true, emulator };
      }
      case 'android.launch': {
        const launched = await android.launchEmulator(String(payload.avd ?? ''));
        return { ok: true, launched };
      }
      case 'android.tap':
      case 'android.swipe':
      case 'android.text':
      case 'android.key': {
        await androidInput(actionName, payload);
        return { ok: true };
      }
      case 'android.sdk': {
        const sdkRoot = payload.sdkRoot ? String(payload.sdkRoot) : null;
        config.sdkRoot = sdkRoot;
        android.setSdkRoot?.(sdkRoot);
        androidState.statusCache = null;
        log.push('system', `[安卓] SDK 目录设为 ${sdkRoot ?? '(自动)'}`);
        return { ok: true, sdkRoot };
      }
      case 'android.emulator.install': {
        const installed = await androidEmulatorInstall();
        return { ok: true, emulator: installed };
      }
      case 'android.emulator.start': {
        const started = await androidEmulatorStart(payload.avd ? String(payload.avd) : undefined);
        return { ok: true, ...started };
      }
      case 'android.emulator.stop': {
        const stopped = await androidEmulatorStop();
        return { ok: true, ...stopped };
      }
      case 'android.emulator.status': {
        androidState.statusCache = null;
        const status = await androidStatus(true);
        return { ok: true, emulator: status.emulator, stream: status.stream };
      }
      case 'android.emulator.accel.install': {
        const result = await androidEmulatorAccelInstall();
        return { ok: true, ...result };
      }
      case 'android.emulator.accel.check': {
        const result = await emulator.checkAccel();
        androidState.statusCache = null;
        return { ok: true, accel: result };
      }
      case 'android.ffmpeg.install': {
        const result = await androidFfmpegInstall();
        return { ok: true, ffmpeg: result };
      }
      case 'app.import': {
        const target = payload.path ? String(payload.path) : '';
        if (!target) throw new Error('缺少文件路径');
        return importAppFile(target, {
          name: payload.name ? String(payload.name) : undefined,
          origin: payload.origin === 'tool' ? 'tool' : 'upload',
          sessionId: payload.sessionId ? String(payload.sessionId) : undefined,
        });
      }
      case 'app.version.list':
        return { ok: true, versions: await listVersionSummaries(), choice: versionState.choice };
      case 'app.version.choose': {
        const chosen = await chooseVersion(String(payload.versionId ?? payload.id ?? ''));
        return { ok: true, chosen, choice: versionState.choice };
      }
      case 'app.version.mark':
        return { ok: true, version: await markVersion(String(payload.versionId ?? payload.id ?? ''), !!payload.marked) };
      case 'app.version.assign_session': {
        const ids = Array.isArray(payload.versionIds) ? payload.versionIds : [payload.versionId ?? payload.id];
        const assigned = await assignVersionsToSession(ids, String(payload.sessionId ?? ''));
        return { ok: true, assigned };
      }
      case 'app.version.open': {
        const target = await versionStore.getVersion(String(payload.versionId ?? payload.id ?? ''));
        if (!target) throw new Error('版本不存在');
        versionState.opening = { id: target.id, name: target.name, kind: target.kind, startedAt: Date.now() };
        try {
          const opened = await activateVersion(target);
          await versionStore.updateVersion(opened.id, { lastUsedAt: Date.now() });
          return { ok: true, version: versionSummary(await versionStore.getVersion(opened.id)) };
        } finally {
          versionState.opening = null;
        }
      }
      case 'app.version.delete':
        return { ok: true, deleted: await deleteVersion(String(payload.versionId ?? payload.id ?? '')) };
      case 'config.cwd':
        config.cwd = String(payload.cwd ?? config.cwd);
        return { ok: true, cwd: config.cwd };
      default:
        throw new Error(`未知动作：${actionName || '(空)'}`);
    }
  }

  /** 供 Agent 工具调用的统一入口。 */
  async function toolAction(args, context = {}) {
    const actionName = String(args?.action ?? '');
    const cwd = args?.cwd || context.cwd || undefined;
    switch (actionName) {
      case 'status': {
        const snapshot = await buildSnapshot();
        return {
          ok: true,
          running: snapshot.run.status === 'running' || snapshot.run.status === 'starting',
          status: snapshot.run.status,
          command: snapshot.run.command,
          cwd: snapshot.run.cwd,
          webUrl: snapshot.web.url,
          desk: { selected: snapshot.desk.selectedTitle, streaming: snapshot.desk.streaming, error: snapshot.desk.error },
          android: {
            adb: snapshot.android.adb.available,
            device: snapshot.android.device,
            streaming: snapshot.android.streaming,
            error: snapshot.android.error,
          },
          hint: '左侧栏「实时预览」面板可看画面与日志',
        };
      }
      case 'run': {
        const result = await runCommand({
          command: args?.command,
          cwd: cwd || config.cwd,
          kind: args?.kind || 'web',
          url: args?.url,
        });
        await sleep(600);
        const snapshot = await buildSnapshot();
        return {
          ok: true,
          run: result,
          webUrl: snapshot.web.url,
          logs: snapshot.logs.slice(-12).map((line) => line.text),
          hint: '打开 DSH 左侧栏的「实时预览」查看画面；网页会自动加载探测到的地址',
        };
      }
      case 'stop':
        await runner.stop();
        return { ok: true, stopped: true };
      case 'web.url': {
        const url = setWebUrl(args?.url);
        return { ok: true, webUrl: url };
      }
      case 'windows': {
        const windows = await deskList();
        return { ok: true, windows, hint: '用 select_window 选择 hwnd，再在面板里看实时画面' };
      }
      case 'select_window': {
        const selected = await deskSelect(args?.hwnd);
        return { ok: true, selected, hint: '桌面窗口画面已在面板中串流' };
      }
      case 'activate_window':
        return { ok: true, ...(await deskActivate()) };
      case 'desk_stop':
        deskStop();
        return { ok: true, stopped: true };
      case 'android_devices': {
        const status = await androidStatus(true);
        return { ok: true, adb: status.adb, devices: status.devices };
      }
      case 'android_install': {
        const installed = await androidInstall();
        return { ok: true, adb: installed };
      }
      case 'android_start':
        return { ok: true, ...(await androidStart()) };
      case 'android_stop':
        return { ok: true, ...(await androidStop()) };
      case 'android_restart_app': {
        const restarted = await androidRestartApp(args?.packageName ? String(args.packageName) : undefined);
        return { ok: true, restarted, hint: '已强制停止并重新打开前台应用，镜像已重启' };
      }
      case 'android_emulators':
        return { ok: true, emulator: await android.avds() };
      case 'android_emulator_install': {
        const installed = await androidEmulatorInstall();
        return { ok: true, emulator: installed, hint: '安装完成后用 android_emulator_start 启动模拟器' };
      }
      case 'android_emulator_start': {
        const started = await androidEmulatorStart(args?.avd ? String(args.avd) : undefined);
        return { ok: true, ...started, hint: '模拟器已启动，面板「安卓」页正在实时预览' };
      }
      case 'android_emulator_stop': {
        const stopped = await androidEmulatorStop();
        return { ok: true, ...stopped };
      }
      case 'android_emulator_status': {
        const status = await androidStatus(true);
        return {
          ok: true,
          sdkRoot: status.emulator?.sdkRoot ?? null,
          installed: !!status.emulator?.installed,
          installing: !!status.emulator?.installing,
          progress: status.emulator?.progress ?? null,
          accel: status.emulator?.accel ?? null,
          avds: status.emulator?.avds ?? [],
          running: !!status.emulator?.running,
          ffmpeg: status.emulator?.ffmpeg ?? null,
          stream: status.stream ?? null,
          device: status.device ?? null,
        };
      }
      case 'android_ffmpeg_install': {
        const result = await androidFfmpegInstall();
        return { ok: true, ffmpeg: result, hint: '已安装高清串流组件，重新开始镜像即可达到 30fps' };
      }
      case 'import_app': {
        const target = args?.path ? String(args.path) : '';
        if (!target) throw new Error('import_app 需要 path（本机应用文件的绝对路径，支持 APK / exe / HTML / ZIP）');
        const result = await importAppFile(target, {
          name: args?.name ? String(args.name) : undefined,
          origin: 'tool',
          sessionId: context?.sessionId ? String(context.sessionId) : undefined,
        });
        return {
          ok: true,
          import: result.import,
          info: result.info,
          hint: '面板已切换到对应的预览目标；右侧边栏「实时预览」可与会话同时显示',
        };
      }
      case 'import_status':
        return { ok: true, app: importSnapshot() };
      case 'app_versions': {
        return {
          ok: true,
          versions: await listVersionSummaries(),
          choice: versionState.choice
            ? { oldVersion: versionSummary(versionState.choice.oldVersion), newVersion: versionSummary(versionState.choice.newVersion), chosenId: versionState.choice.chosenId, closesAt: versionState.choice.closesAt }
            : null,
        };
      }
      case 'app_version_choose': {
        const chosen = await chooseVersion(String(args?.versionId ?? ''));
        return { ok: true, ...chosen };
      }
      case 'app_version_mark': {
        return { ok: true, version: await markVersion(String(args?.versionId ?? ''), !!args?.marked) };
      }
      case 'app_version_assign_session': {
        const ids = Array.isArray(args?.versionIds) ? args.versionIds : [args?.versionId];
        return { ok: true, assigned: await assignVersionsToSession(ids, String(args?.sessionId ?? '')) };
      }
      case 'app_version_open': {
        const target = await versionStore.getVersion(String(args?.versionId ?? ''));
        if (!target) throw new Error('版本不存在');
        versionState.opening = { id: target.id, name: target.name, kind: target.kind, startedAt: Date.now() };
        try {
          const opened = await activateVersion(target);
          await versionStore.updateVersion(opened.id, { lastUsedAt: Date.now() });
          return { ok: true, version: versionSummary(await versionStore.getVersion(opened.id)), hint: '已切换到该版本并开始预览' };
        } finally {
          versionState.opening = null;
        }
      }
      case 'app_version_delete': {
        return { ok: true, deleted: await deleteVersion(String(args?.versionId ?? '')) };
      }

      case 'android_tap':
        await androidInput('android.tap', args ?? {});
        return { ok: true, tapped: [Number(args?.x), Number(args?.y)] };
      case 'android_swipe':
        await androidInput('android.swipe', args ?? {});
        return { ok: true, swiped: [Number(args?.x1), Number(args?.y1), Number(args?.x2), Number(args?.y2)] };
      case 'android_key':
        await androidInput('android.key', args ?? {});
        return { ok: true, key: args?.key };
      case 'android_text':
        await androidInput('android.text', args ?? {});
        return { ok: true, chars: String(args?.text ?? '').length };
      default:
        throw new Error(`未知 action：${actionName || '(空)'}`);
    }
  }

  // ── 导入应用文件（自动识别 Android APK / Windows exe / 网页包）───────────
  function importMessage(text) {
    importState.detail = text;
    log.push('system', `[导入] ${text}`);
  }

  async function waitForAppWindow({ pid, nameHint, baseline, timeoutMs = 25000 }) {
    const deadline = Date.now() + timeoutMs;
    const hint = String(nameHint || '').toLowerCase();
    const before = baseline instanceof Set ? baseline : new Set(Array.isArray(baseline) ? baseline.map(String) : []);
    while (Date.now() < deadline) {
      try {
        const windows = await getWindowsCapture().list();
        // 1) 同 pid 最准；2) 标题里带文件名（有的程序启动即改名）；3) 启动后新出现的可见窗口
        //    （商店版 Notepad / 启动器再拉起子进程时 pid 对不上，靠“新窗口”兜底）。
        let match = windows.find((item) => pid && Number(item.pid) === Number(pid));
        if (!match && hint) match = windows.find((item) => String(item.title || '').toLowerCase().includes(hint));
        if (!match) {
          match = windows.find((item) => {
            const title = String(item.title || '').trim();
            if (!title || before.has(String(item.hwnd))) return false;
            if (/DeepSeek Harness|CASCADIA_HOSTING|用户账户控制|User Account Control|Windows 安全|Windows Security/i.test(title)) return false;
            return true;
          });
        }
        if (match) return match;
      } catch {
        /* 窗口列表偶发失败，继续等 */
      }
      await sleep(700);
    }
    return null;
  }

  async function windowBaseline() {
    try {
      const windows = await getWindowsCapture().list();
      return new Set((windows || []).map((item) => String(item.hwnd)));
    } catch {
      return new Set();
    }
  }

  /**
   * 启动后的窗口管家：把本次启动“新出现”的窗口处理掉，别让它盖住 DSH。
   * - action='minimize'：真最小化（模拟器/控制台窗口，不依赖它出画）
   * - action='offscreen'：移到屏幕外但保持可见（被插件捕获的应用窗口；
   *   最小化窗口 PrintWindow 会黑屏，所以不能真最小化）
   * 只对“启动后新出现的窗口”和“本次进程的窗口”生效，不动用户别的窗口。
   * @param {{pid?:number, baseline?:Set<string>, titlePatterns?:Array<RegExp|string>, action?:'minimize'|'offscreen', durationMs?:number, label?:string}} options
   * @returns {() => void} 停止函数
   */
  function startWindowTamer(options = {}) {
    if (process.platform !== 'win32') return () => {};
    const before = options.baseline instanceof Set ? options.baseline : new Set(Array.isArray(options.baseline) ? options.baseline.map(String) : []);
    const patterns = (options.titlePatterns || []).map((item) => (item instanceof RegExp ? item : new RegExp(String(item), 'i')));
    const action = options.action === 'offscreen' ? 'offscreen' : 'minimize';
    const label = options.label || '启动的窗口';
    const durationMs = Number(options.durationMs) > 0 ? Number(options.durationMs) : 60000;
    const pid = options.pid ? Number(options.pid) : null;
    const handled = new Set();
    const deadline = Date.now() + durationMs;
    let stopped = false;
    let timer = null;

    async function pass() {
      if (stopped) return;
      try {
        const windows = await getWindowsCapture().list();
        for (const item of windows || []) {
          const hwnd = String(item.hwnd);
          if (handled.has(hwnd)) continue;
          const title = String(item.title || '');
          if (!title) continue;
          if (/DeepSeek Harness/i.test(title)) continue;
          const pidHit = pid && Number(item.pid) === pid;
          const titleHit = patterns.some((re) => re.test(title));
          const isNew = !before.has(hwnd);
          if (!pidHit && !titleHit && !(isNew && patterns.length === 0)) continue;
          handled.add(hwnd);
          try {
            if (action === 'offscreen') await getWindowsCapture().offscreen(item.hwnd);
            else await getWindowsCapture().minimize(item.hwnd);
            log.push('system', `[窗口] ${label}已${action === 'offscreen' ? '移出屏幕' : '最小化'}：${title.slice(0, 60)}`);
          } catch (error) {
            /* 窗口可能已经关闭，忽略 */
          }
        }
      } catch {
        /* 枚举失败下一轮再试 */
      }
      if (!stopped && Date.now() < deadline) timer = setTimeout(pass, 700);
    }
    timer = setTimeout(pass, 350);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }

  async function ensureAndroidForImport() {
    let status = await androidStatus(true);
    if (!status.adb.available) {
      importMessage('未找到 adb，先自动安装 platform-tools…');
      await android.install();
      androidState.statusCache = null;
      status = await androidStatus(true);
    }
    if (!status.adb.available) throw new Error('adb 不可用，无法安装安卓应用');
    if (!status.device) {
      importMessage('没有在线安卓设备，正在启动模拟器…');
      await androidEmulatorStart();
    } else if (!androidState.streaming) {
      await androidStart();
    }
    status = await androidStatus(true);
    const serial = status.device ?? androidState.serial;
    if (!serial) throw new Error('没有可用的安卓设备（模拟器启动失败？）');
    return { serial, adbPath: status.adb.path };
  }

  /**
   * 导入一个应用文件：识别类型后安装/运行，并让面板切换到对应预览。
   * @param {string} filePath 宿主上的绝对路径
   * @param {{ name?: string, origin?: 'upload'|'tool', sessionId?: string }} [options]
   */
  async function importAppFile(filePath, options = {}) {
    if (importState.importing) throw new Error('已有应用正在导入，请稍候');
    const absolute = path.resolve(String(filePath || ''));
    const displayName = options.name || path.basename(absolute);
    const sessionId = options.sessionId ? String(options.sessionId) : null;
    let info;
    try {
      info = await detectAppFile(absolute);
    } catch (error) {
      throw new Error(`无法读取文件：${errorMessage(error)}`);
    }
    Object.assign(importState, {
      importing: true,
      name: displayName,
      kind: info.kind,
      format: info.format ?? null,
      arch: info.arch ?? null,
      detail: info.detail ?? null,
      progress: 'detected',
      error: null,
      startedAt: Date.now(),
      finishedAt: null,
      result: null,
    });
    log.push('system', `[导入] ${displayName} → ${info.kind}${info.arch ? ` / ${info.arch}` : ''}（${info.format ?? '未知格式'}）`);
    try {
      if (info.kind === 'android') {
        const { serial, adbPath } = await ensureAndroidForImport();
        importState.progress = 'installing';
        importMessage(`正在安装到 ${serial}…`);
        const installed = await installAndroidApp({ adbPath, serial, filePath: absolute, onLog: (line) => log.push('system', `[adb] ${line}`) });
        importState.progress = 'launching';
        importMessage(`安装完成：${installed.packageName || '未知包名'}，正在启动…`);
        if (installed.packageName) {
          await launchAndroidApp({ adbPath, serial, packageName: installed.packageName, onLog: (line) => log.push('system', `[adb] ${line}`) });
          rememberAndroidApp(installed.packageName);
        }
        await sleep(800);
        importState.progress = 'streaming';
        try {
          await androidStop();
          await sleep(1200);
          await androidStart();
        } catch (error) {
          log.push('system', `[导入] 重新开始镜像失败：${errorMessage(error)}`);
        }
        const result = { kind: 'android', packageName: installed.packageName ?? null, serial };
        importState.result = result;
        try {
          await recordImportedVersion({ kind: 'android', info, absolute, result, name: displayName, sessionId });
        } catch (error) {
          log.push('stderr', `[版本] 记录失败：${errorMessage(error)}`);
        }
        importMessage(`已在模拟器内启动${installed.packageName ? `：${installed.packageName}` : ''}`);
        return { ok: true, import: result, info };
      }

      if (info.kind === 'windows') {
        if (info.format === 'msi') {
          throw new Error('MSI 安装包暂不支持直接导入：请先安装，再导入安装目录里的 exe');
        }
        importState.progress = 'launching';
        importMessage(info.arch === 'arm64' ? '检测到 ARM64 程序，尝试启动…' : '正在启动 Windows 程序…');
        const baseline = await windowBaseline();
        const launched = launchWindowsApp(absolute);
        if (launched.elevated) importMessage('程序要求管理员权限，已通过 UAC 提权启动');
        else if (launched.shell) importMessage('已通过 ShellExecute 启动（安装器常需要这种方式）');
        importMessage(`进程已启动 pid=${launched.pid}，等待窗口…`);
        const waitMs = launched.elevated ? 60000 : 40000;
        const window = await waitForAppWindow({
          pid: launched.pid,
          nameHint: path.basename(absolute, path.extname(absolute)),
          baseline,
          timeoutMs: waitMs,
        });
        if (!window) {
          throw new Error(
            `程序已启动（pid=${launched.pid}），但 ${Math.round(waitMs / 1000)} 秒内没有捕获到它的窗口：` +
              '可能在等待 UAC/安装向导、或它本身没有窗口。安装器请先完成安装，再导入安装目录里的主程序 exe。'
          );
        }
        await deskSelect(window.hwnd);
        // 应用窗口不要盖住 DSH：移到屏幕外（最小化会让 PrintWindow 黑屏，预览就没了）。
        try {
          await getWindowsCapture().offscreen(window.hwnd);
          log.push('system', `[窗口] 已把「${String(window.title || '').slice(0, 40)}」移到屏幕外（预览仍可看）`);
        } catch (error) {
          log.push('system', `[窗口] 移到屏幕外失败：${errorMessage(error)}`);
        }
        startWindowTamer({
          pid: launched.pid,
          baseline,
          action: 'offscreen',
          durationMs: 20000,
          label: `「${String(path.basename(absolute)).slice(0, 24)}」的窗口`,
        });
        importState.progress = 'streaming';
        const result = {
          kind: 'windows',
          pid: launched.pid,
          hwnd: window.hwnd,
          title: window.title ?? null,
          arch: info.arch ?? null,
          launcher: launched.elevated ? 'shell:runas' : launched.shell ? 'shell' : 'createprocess',
        };
        importState.result = result;
        try {
          await recordImportedVersion({ kind: 'windows', info, absolute, result, name: displayName, sessionId });
        } catch (error) {
          log.push('stderr', `[版本] 记录失败：${errorMessage(error)}`);
        }
        importMessage(`已启动并开始预览：${window.title || `#${window.hwnd}`}`);
        return { ok: true, import: result, info };
      }

      if (info.kind === 'web') {
        importState.progress = 'preparing';
        importMessage('正在准备网页应用…');
        const token = randomBytes(8).toString('hex');
        const destination = path.join(importsDir, `web-${token}`);
        const prepared = await prepareWebApp(absolute, destination);
        webApps.set(token, prepared);
        const url = `/live-preview/app/${token}/${String(prepared.entry || 'index.html').split('/').map(encodeURIComponent).join('/')}`;
        web.url = url;
        web.autoDetected = false;
        importState.progress = 'streaming';
        const result = { kind: 'web', url, token };
        importState.result = result;
        try {
          await recordImportedVersion({ kind: 'web', info, absolute, result, name: displayName, sessionId });
        } catch (error) {
          log.push('stderr', `[版本] 记录失败：${errorMessage(error)}`);
        }
        importMessage(`网页应用已就绪：${url}`);
        return { ok: true, import: result, info };
      }

      throw new Error(info.reason || '不支持的文件类型（支持 APK / Windows exe / HTML / ZIP 网页包）');
    } catch (error) {
      const message = errorMessage(error);
      importState.error = message;
      importState.progress = 'failed';
      log.push('stderr', `[导入] 失败：${message}`);
      throw error;
    } finally {
      importState.importing = false;
      importState.finishedAt = Date.now();
      importState.history.unshift({
        name: displayName,
        kind: info.kind,
        format: info.format ?? null,
        ok: !importState.error,
        error: importState.error,
        at: importState.finishedAt,
      });
      if (importState.history.length > 12) importState.history.length = 12;
    }
  }

  /** 导入的网页包根目录（token 校验在服务端完成）。 */
  function webAppRoot(token) {
    const entry = webApps.get(String(token || ''));
    return entry ? entry.rootDir || entry.dir || null : null;
  }

  function importSnapshot() {
    return {
      importing: importState.importing,
      name: importState.name,
      kind: importState.kind,
      format: importState.format,
      arch: importState.arch,
      detail: importState.detail,
      progress: importState.progress,
      error: importState.error,
      startedAt: importState.startedAt,
      finishedAt: importState.finishedAt,
      result: importState.result,
      history: importState.history.slice(),
    };
  }

  // ── 应用版本（历史应用 / 保留哪个版本）────────────────────────────────
  function versionAppKey(kind, extra = {}) {
    if (kind === 'android') {
      const pkg = extra.packageName || '';
      return pkg ? `android:${pkg}` : null;
    }
    const base = path.basename(String(extra.name || extra.filePath || 'app')).toLowerCase();
    return base ? `${kind}:${base}` : null;
  }

  function versionSummary(version) {
    if (!version) return null;
    return {
      id: version.id,
      appKey: version.appKey,
      kind: version.kind,
      name: version.name,
      format: version.format ?? null,
      arch: version.arch ?? null,
      packageName: version.packageName ?? null,
      sessionId: (version.meta && version.meta.sessionId) || null,
      size: version.size ?? null,
      createdAt: version.createdAt ?? null,
      lastUsedAt: version.lastUsedAt ?? null,
      marked: !!version.marked,
      running: version.running ?? null,
      chosen: versionState.choice ? versionState.choice.chosenId === version.id : false,
      active: versionState.activeVersionId === version.id,
      latest: false,
    };
  }

  /** 把版本数组转成摘要，并按「对话 + 应用」给最新一条打上 latest。 */
  function summarizeVersions(list) {
    const latestByKey = new Map();
    for (const version of list || []) {
      const key = `${(version.meta && version.meta.sessionId) || ''}|${version.appKey}`;
      const current = latestByKey.get(key);
      if (!current || Number(version.createdAt || 0) > Number(current.createdAt || 0)) {
        latestByKey.set(key, version);
      }
    }
    return (list || []).map((version) => {
      const summary = versionSummary(version);
      const latest = latestByKey.get(`${(version.meta && version.meta.sessionId) || ''}|${version.appKey}`);
      summary.latest = !!latest && latest.id === version.id;
      return summary;
    });
  }

  /** 导入成功后登记版本；若同一应用已有版本，则进入“保留哪个版本”状态。 */
  async function recordImportedVersion({ kind, info, absolute, result, name, sessionId }) {
    const logicalName = name || path.basename(absolute);
    const appKey = versionAppKey(kind, { packageName: result.packageName ?? null, name: logicalName });
    if (!appKey) {
      log.push('system', `[版本] 无法确定应用身份（${logicalName}），跳过版本记录`);
      return { version: null, previous: null };
    }
    const existing = await versionStore.findByAppKey(appKey);
    // 只在同一个对话内比较“上一版”，不同对话互不干扰。
    const sessionKey = sessionId ? String(sessionId) : '';
    const sameSession = (existing || []).filter((item) => ((item.meta && item.meta.sessionId) || '') === sessionKey);
    const previous = sameSession.length > 0 ? sameSession[0] : null;
    let version = await versionStore.addVersion({
      appKey,
      kind,
      name: logicalName,
      format: info.format ?? null,
      arch: info.arch ?? null,
      packageName: result.packageName ?? null,
      sourcePath: absolute,
      meta: {
        displayName: result.title ?? result.packageName ?? logicalName,
        originalName: logicalName,
        sessionId: sessionId ? String(sessionId) : null,
        url: result.url ?? null,
        token: result.token ?? null,
        serial: result.serial ?? null,
      },
    });
    const running =
      kind === 'android'
        ? { serial: result.serial ?? null, packageName: result.packageName ?? null }
        : kind === 'windows'
          ? { pid: result.pid ?? null, hwnd: result.hwnd ?? null, title: result.title ?? null }
          : { token: result.token ?? null, url: result.url ?? null };
    version = await versionStore.updateVersion(version.id, { running, lastUsedAt: Date.now() });
    versionState.activeVersionId = version.id;
    if (previous) {
      versionState.choice = {
        appKey,
        appName: logicalName,
        sessionId: sessionId ? String(sessionId) : null,
        oldVersion: previous,
        newVersion: version,
        chosenId: null,
        chosenNew: null,
        decidedAt: null,
        closesAt: null,
      };
      log.push('system', `[版本] 「${logicalName}」检测到新版本（旧版本 ${previous.id}），等待用户选择保留哪个版本`);
    }
    return { version, previous };
  }

  function killPidTree(pid) {
    return new Promise((resolve) => {
      const target = Number(pid);
      if (!target) {
        resolve(false);
        return;
      }
      try {
        const child = spawn('taskkill', ['/PID', String(target), '/F', '/T'], { windowsHide: true, stdio: 'ignore' });
        child.once('exit', () => resolve(true));
        child.once('error', () => resolve(false));
      } catch {
        resolve(false);
      }
    });
  }

  /** 安卓版本被点击时：没设备就先把模拟器拉起来（历史应用一键运行）。 */
  async function ensureAndroidDeviceForVersion() {
    let status = await androidStatus(true);
    const adb = status.adb.path;
    // 设备可能“看起来在线”但其实正在关机/已失联：先 get-state 验证。
    if (status.device && adb) {
      try {
        await runAdbCapture(adb, ['-s', status.device, 'get-state'], 5000);
        return status;
      } catch {
        log.push('system', `[版本] 设备 ${status.device} 已不在线，先重新启动模拟器…`);
      }
    }
    if (!status.adb.available) throw new Error('adb 不可用：请先安装安卓模拟器');
    const emu = status.emulator || {};
    if (!emu.installed) throw new Error('还没安装安卓模拟器：请先在主面板点「安装安卓模拟器」');
    if (versionState.opening) versionState.opening.phase = 'emulator';
    log.push('system', '[版本] 还没有在线设备，先自动启动安卓模拟器…');
    const launched = await androidEmulatorStart();
    status = await androidStatus(true);
    const serial = status.device || (launched && launched.serial) || null;
    if (!serial) throw new Error('模拟器启动后没有找到在线设备');
    return { ...status, device: serial };
  }

  /** 等新版本真的出画面（否则客户端加载动画要一直转，不能露旧画面）。 */
  async function waitForFreshFrame(kind, since, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const frameAt =
        kind === 'android'
          ? Number(getStream().stats().lastFrameAt) || 0
          : Number(desk.lastFrameAt) || 0;
      if (frameAt > since) return true;
      await sleep(250);
    }
    return false;
  }

  /** 把某个版本设为当前预览目标（Windows 会重新拉起进程，安卓会装回旧 APK）。 */
  async function activateVersion(version) {
    if (!version) throw new Error('版本不存在');
    const activationStart = Date.now();
    if (version.kind === 'windows') {
      if (versionState.opening) versionState.opening.phase = 'launch';
      let running = version.running && version.running.hwnd ? version.running : null;
      if (running) {
        try {
          const info = await getWindowsCapture().info(running.hwnd);
          if (!info) running = null;
        } catch {
          running = null;
        }
      }
      if (!running) {
        const baseline = await windowBaseline();
        const launched = launchWindowsApp(version.filePath);
        const found = await waitForAppWindow({ pid: launched.pid, baseline, timeoutMs: 40000 });
        if (!found) throw new Error('旧版本已启动但没抓到窗口（可能已被系统拦截）');
        try {
          await getWindowsCapture().offscreen(found.hwnd);
        } catch {
          /* ignore */
        }
        running = { pid: launched.pid, hwnd: found.hwnd, title: found.title ?? null };
        await versionStore.updateVersion(version.id, { running, lastUsedAt: Date.now() });
        version = await versionStore.getVersion(version.id);
      }
      await deskSelect(running.hwnd);
      versionState.activeVersionId = version.id;
      await waitForFreshFrame('desk', activationStart, 6000);
      return version;
    }
    if (version.kind === 'web') {
      const url = (version.meta && version.meta.url) || null;
      if (url) {
        web.url = url;
        web.autoDetected = false;
      }
      await versionStore.updateVersion(version.id, { lastUsedAt: Date.now() });
      versionState.activeVersionId = version.id;
      return version;
    }
    if (version.kind === 'android') {
      let status = await androidStatus(true);
      if (!status.device) status = await ensureAndroidDeviceForVersion();
      if (versionState.opening) versionState.opening.phase = 'install';
      importMessage(`正在把旧版本装回模拟器：${version.name}`);
      await installAndroidApp({
        adbPath: status.adb.path,
        serial: status.device,
        filePath: version.filePath,
        onLog: (line) => log.push('system', `[adb] ${line}`),
      });
      if (versionState.opening) versionState.opening.phase = 'launch';
      if (version.packageName) {
        await launchAndroidApp({
          adbPath: status.adb.path,
          serial: status.device,
          packageName: version.packageName,
          onLog: (line) => log.push('system', `[adb] ${line}`),
        });
        rememberAndroidApp(version.packageName);
      }
      try {
        await androidStop();
        await sleep(800);
        await androidStart();
      } catch (error) {
        log.push('system', `[版本] 重启镜像失败：${errorMessage(error)}`);
      }
      await versionStore.updateVersion(version.id, {
        running: { serial: status.device, packageName: version.packageName ?? null },
        lastUsedAt: Date.now(),
      });
      versionState.activeVersionId = version.id;
      await waitForFreshFrame('android', activationStart, 8000);
      return versionStore.getVersion(version.id);
    }
    return version;
  }

  /** 关闭未保留版本的“进程”；应用包/文件永远保留。 */
  async function stopVersionProcess(version) {
    if (!version) return;
    if (version.kind === 'windows' && version.running && version.running.pid) {
      await killPidTree(version.running.pid);
      await versionStore.clearRunning(version.id);
      log.push('system', `[版本] 已关闭未保留版本的进程：${version.name}`);
      return;
    }
    if (version.kind === 'web') {
      const token = version.meta && version.meta.token;
      if (token) {
        webApps.delete(token);
        if (web.url && web.url.indexOf(`/live-preview/app/${token}/`) === 0) web.url = null;
      }
      await versionStore.clearRunning(version.id);
      log.push('system', `[版本] 已停止未保留的网页版本：${version.name}`);
      return;
    }
    if (version.kind === 'android') {
      await versionStore.clearRunning(version.id);
      log.push('system', `[版本] 安卓只保留一个运行版本，未保留版本的 APK 仍在历史应用中`);
    }
  }

  /** 用户选择保留哪个版本；60 秒后关闭未保留版本的进程。 */
  async function chooseVersion(versionId) {
    const choice = versionState.choice;
    if (!choice) throw new Error('当前没有待选择的版本（需要先导入同一个应用的新版本）');
    const chosenNew = versionId === choice.newVersion.id;
    const chosen = chosenNew ? choice.newVersion : choice.oldVersion;
    const unchosen = chosenNew ? choice.oldVersion : choice.newVersion;
    let activated = await versionStore.getVersion(chosen.id);
    // 已经在前台/预览中的版本不用再切一次（避免安卓重复安装、Windows 重复拉起）。
    const alreadyActive =
      (chosen.kind === 'android' && chosenNew) ||
      (chosen.kind === 'web' && !!web.url && !!(chosen.meta && chosen.meta.url) && web.url === chosen.meta.url) ||
      (chosen.kind === 'windows' && !!(chosen.running && chosen.running.hwnd) && Number(desk.selectedHwnd) === Number(chosen.running.hwnd));
    if (!alreadyActive) {
      try {
        activated = await activateVersion(activated);
      } catch (error) {
        importMessage(`切换版本失败：${errorMessage(error)}`);
      }
    } else {
      versionState.activeVersionId = chosen.id;
    }
    versionState.choice = {
      ...choice,
      oldVersion: chosenNew ? choice.oldVersion : activated,
      newVersion: chosenNew ? activated : choice.newVersion,
      chosenId: chosen.id,
      chosenNew,
      decidedAt: Date.now(),
      closesAt: Date.now() + 60000,
    };
    if (versionState.timer) clearTimeout(versionState.timer);
    versionState.timerUnchosenId = unchosen.id;
    versionState.timer = setTimeout(() => {
      versionState.timer = null;
      versionState.timerUnchosenId = null;
      const unchosenSnapshot = unchosen;
      stopVersionProcess(unchosenSnapshot).catch((error) => log.push('stderr', `[版本] 关闭未保留版本失败：${errorMessage(error)}`));
      log.push('system', `[版本] 已保留「${chosen.name}」，未保留版本已关闭（文件保留）`);
      versionState.choice = null;
    }, 60000);
    log.push('system', `[版本] 已选择保留「${chosen.name}」，60 秒后关闭「${unchosen.name}」的进程（应用包保留）`);
    const chosenFresh = await versionStore.getVersion(chosen.id);
    const unchosenFresh = await versionStore.getVersion(unchosen.id);
    return {
      chosen: versionSummary(chosenFresh),
      unchosen: versionSummary(unchosenFresh),
      closesAt: versionState.choice.closesAt,
      note: chosen.kind === 'android' ? '安卓同一时间只运行一个版本；未保留版本的 APK 仍在历史应用中' : undefined,
    };
  }

  async function listVersionSummaries() {
    const all = await versionStore.listVersions();
    return summarizeVersions(all);
  }

  async function markVersion(id, marked) {
    const version = await versionStore.markVersion(id, !!marked);
    return versionSummary(version);
  }

  /** 把一批版本归到某个对话（用于迁移加会话功能之前的旧版本）。 */
  async function assignVersionsToSession(versionIds, sessionId) {
    const sid = sessionId ? String(sessionId) : '';
    if (!sid) throw new Error('缺少会话 id（主面板历史里点「归到当前对话」需要先知道当前对话）');
    const ids = Array.isArray(versionIds) ? versionIds : [versionIds];
    const updated = [];
    for (const id of ids) {
      const version = await versionStore.getVersion(String(id || ''));
      if (!version) continue;
      const meta = Object.assign({}, version.meta || {}, { sessionId: sid });
      const next = await versionStore.updateVersion(version.id, { meta });
      updated.push(versionSummary(next));
    }
    if (updated.length > 0) log.push('system', `[版本] 已把 ${updated.length} 个版本归到对话 ${sid.slice(0, 8)}`);
    return { ok: true, updated };
  }

  async function deleteVersion(id) {
    const version = await versionStore.getVersion(id);
    if (!version) throw new Error('版本不存在');
    if (version.kind === 'windows' && version.running && version.running.pid) await killPidTree(version.running.pid);
    if (version.kind === 'web' && version.meta && version.meta.token) {
      webApps.delete(version.meta.token);
      if (web.url && web.url.indexOf(`/live-preview/app/${version.meta.token}/`) === 0) web.url = null;
    }
    if (version.kind === 'windows' && version.running && version.running.hwnd === desk.selectedHwnd) deskStop();
    const result = await versionStore.deleteVersion(id, { deleteFile: true });
    if (versionState.activeVersionId === id) versionState.activeVersionId = null;
    if (versionState.choice) {
      if (versionState.choice.oldVersion.id === id || versionState.choice.newVersion.id === id) versionState.choice = null;
    }
    log.push('system', `[版本] 已删除版本：${version.name}（${id}）`);
    return result;
  }

  async function buildSnapshot() {
    const androidStatusValue = await androidStatus();
    return {
      ok: true,
      ts: Date.now(),
      web: { url: web.url, autoDetected: web.autoDetected, runCommand: runner.state.command },
      run: { ...runner.state },
      logs: log.tail(300),
      desk: {
        supported: process.platform === 'win32',
        ready: !!windowsCapture,
        selectedHwnd: desk.selectedHwnd,
        selectedTitle: desk.selectedTitle,
        streaming: desk.streaming,
        fps: deskFps(),
        error: desk.error,
        lastFrameAt: desk.lastFrameAt || null,
      },
      android: androidStatusValue,
      app: {
        ...importSnapshot(),
        versions: await versionStore.listVersions().then((list) => summarizeVersions(list)),
        versionChoice: versionState.choice
          ? {
              appKey: versionState.choice.appKey,
              appName: versionState.choice.appName,
              sessionId: versionState.choice.sessionId ?? null,
              oldVersion: versionSummary(versionState.choice.oldVersion),
              newVersion: versionSummary(versionState.choice.newVersion),
              chosenId: versionState.choice.chosenId,
              chosenNew: versionState.choice.chosenNew,
              closesAt: versionState.choice.closesAt,
            }
          : null,
        versionOpening: versionState.opening
          ? {
              id: versionState.opening.id,
              name: versionState.opening.name,
              kind: versionState.opening.kind,
              phase: versionState.opening.phase || null,
              startedAt: versionState.opening.startedAt,
            }
          : null,
      },
      config: { cwd: config.cwd, dataDir: config.dataDir, sdkRoot: config.sdkRoot },
    };
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    if (versionState.timer) {
      clearTimeout(versionState.timer);
      versionState.timer = null;
    }
    try {
      await runner.stop(true);
    } catch {
      /* ignore */
    }
    try {
      await androidStop();
    } catch {
      /* ignore */
    }
    try {
      await android.dispose?.();
    } catch {
      /* ignore */
    }
    try {
      await getStream().dispose?.();
    } catch {
      /* ignore */
    }
    try {
      await emulator.dispose?.();
    } catch {
      /* ignore */
    }
    try {
      await windowsCapture?.dispose?.();
    } catch {
      /* ignore */
    }
  }

  return {
    config,
    action,
    toolAction,
    snapshot: buildSnapshot,
    logsSince: (seq) => log.since(seq),
    logInfo: (text) => log.push('system', String(text)),
    deskFrame,
    androidFrame,
    androidStreamMode,
    subscribeAndroidFrames,
    importAppFile,
    webAppRoot,
    dispose,
  };
}
