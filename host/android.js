// dsh-live-preview / host/android.js
// 安卓真机/模拟器后端：adb 发现与安装、设备枚举、截屏串流、输入注入、模拟器（AVD）管理。
//
// 契约见 ../CONTRACT.md「host/android.js」一节；本文件不依赖其他 host 模块，
// 由 index.js/service.js 通过 createAndroidBackend({ dataDir, logger }) 装配。
//
// 设计约束：
//  - 无 adb / 无设备 / 下载失败一律抛或返回带原因的明确错误，绝不崩进程；
//  - 所有外部命令都有超时（默认 10s，screencap 15s，解压 120s）；
//  - adb 查找顺序：配置的 sdkRoot → ANDROID_HOME/ANDROID_SDK_ROOT → PATH → dataDir/platform-tools。

import { createWriteStream, existsSync, promises as fsp } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const PLATFORM_TOOLS_URL =
  'https://dl.google.com/android/repository/platform-tools-latest-windows.zip';
const PLATFORM_TOOLS_MIN_BYTES = 1_000_000;

const CMD_TIMEOUT_MS = 10_000;
const SCREENCAP_TIMEOUT_MS = 15_000;
const EXTRACT_TIMEOUT_MS = 120_000;
const DOWNLOAD_TIMEOUT_MS = 300_000;

const FRAME_MIN_INTERVAL_MS = 250;
const FRAME_MAX_INTERVAL_MS = 800;
const MAX_CONSECUTIVE_FRAME_ERRORS = 5;

const VERSION_CACHE_MS = 60_000;
const EMULATOR_CACHE_MS = 10_000;

const IS_WIN = process.platform === 'win32';
const ADB_NAME = IS_WIN ? 'adb.exe' : 'adb';
const EMULATOR_NAME = IS_WIN ? 'emulator.exe' : 'emulator';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Android keyevent 常用映射（数字码），其余名称按 KEYCODE_<NAME> 透传。
const KEY_MAP = {
  back: 4,
  home: 3,
  enter: 66,
  recents: 187,
  app_switch: 187,
  menu: 82,
  power: 26,
  wakeup: 224,
  sleep: 223,
  volume_up: 24,
  volume_down: 25,
  mute: 164,
  delete: 67,
  del: 67,
  backspace: 67,
  tab: 61,
  space: 62,
  escape: 111,
  esc: 111,
  search: 84,
  camera: 27,
  dpad_up: 19,
  dpad_down: 20,
  dpad_left: 21,
  dpad_right: 22,
  center: 23,
  notification: 83,
  play_pause: 85,
  next: 87,
  previous: 88,
};

/**
 * 创建安卓后端实例。
 * @param {{ dataDir?: string, logger?: any }} [opts]
 */
export function createAndroidBackend(opts = {}) {
  const dataDir =
    opts.dataDir && String(opts.dataDir).trim()
      ? path.resolve(String(opts.dataDir).trim())
      : path.join(process.env.LOCALAPPDATA || os.homedir(), 'dsh-live-preview');
  const logger = opts.logger;
  // service.js 还会传入 getSdkRoot()（配置里的 SDK 路径）；setSdkRoot 优先。
  const externalSdkRoot = typeof opts.getSdkRoot === 'function' ? opts.getSdkRoot : null;
  const platformToolsDir = path.join(dataDir, 'platform-tools');
  const adbExeInDataDir = path.join(platformToolsDir, ADB_NAME);

  // ---- 运行状态 ----
  let sdkRoot = null;
  let adbPathCache = null;
  let deviceSerial = null;
  let resolution = null;
  let latestFrame = null;
  let lastFrameAt = null;
  let streaming = false;
  let loopPromise = null;
  let loopSeq = 0;
  let wakeSleep = null;
  let consecutiveFrameErrors = 0;
  let lastError = null;
  let installing = false;
  let installError = null;
  let installPromise = null;
  const versionCache = new Map(); // adb path -> { version, at }
  let emulatorCache = null; // { key, at, value }

  // ---- 小工具 ----
  function log(level, message) {
    try {
      if (!logger) return;
      if (typeof logger === 'function') {
        logger(level, message);
        return;
      }
      if (typeof logger[level] === 'function') {
        logger[level](message);
        return;
      }
      if (typeof logger.log === 'function') logger.log(message);
    } catch {
      /* 日志失败不影响主流程 */
    }
  }

  function formatError(e) {
    if (!e) return '未知错误';
    return e.message ? String(e.message) : String(e);
  }

  // adb 首次运行会在 %USERPROFILE%\.android 建目录；权限不足时给出可操作的提示。
  function adbRunHint(message) {
    if (/\.android/i.test(message) || /Cannot mkdir/i.test(message) || /Permission denied/i.test(message)) {
      return '（adb 首次运行需要创建 %USERPROFILE%\\.android，请确认该目录存在且当前用户可写）';
    }
    return '';
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        wakeSleep = null;
        resolve();
      }, ms);
      wakeSleep = () => {
        clearTimeout(timer);
        wakeSleep = null;
        resolve();
      };
    });
  }

  function wakeLoop() {
    const wake = wakeSleep;
    if (wake) wake();
  }

  async function fileExists(file) {
    try {
      const st = await fsp.stat(file);
      return st.isFile();
    } catch {
      return false;
    }
  }

  function toInt(value, name, min = -100_000, max = 100_000) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) throw new Error(`参数 ${name} 不是有效数字：${String(value)}`);
    if (n < min || n > max) throw new Error(`参数 ${name} 超出范围 [${min}, ${max}]：${n}`);
    return n;
  }

  // ---- 外部命令执行（带超时、无黑窗、二进制安全） ----
  function runCommand(exe, args, commandOpts = {}) {
    const timeout = commandOpts.timeout ?? CMD_TIMEOUT_MS;
    const label = `${path.basename(exe)} ${args.join(' ')}`.slice(0, 300);
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(exe, args, {
          cwd: commandOpts.cwd,
          env: commandOpts.env ?? process.env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        reject(new Error(`无法执行 ${path.basename(exe)}：${formatError(e)}`));
        return;
      }
      const out = [];
      const err = [];
      let settled = false;
      let timer = null;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        fn(value);
      };
      timer = setTimeout(() => {
        finish(reject, new Error(`命令超时（${timeout}ms）：${label}`));
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      }, timeout);
      child.stdout.on('data', (chunk) => out.push(chunk));
      child.stderr.on('data', (chunk) => err.push(chunk));
      child.on('error', (e) => {
        finish(reject, new Error(`无法执行 ${path.basename(exe)}：${formatError(e)}`));
      });
      child.on('close', (code) => {
        const stdout = Buffer.concat(out);
        const stderr = Buffer.concat(err);
        const text = stdout.toString('utf8');
        const errText = stderr.toString('utf8');
        if (code !== 0) {
          const detail = (errText || text).trim();
          const e = new Error(`${label} 失败（exit ${code}）${detail ? '：' + detail.slice(0, 400) : ''}`);
          e.exitCode = code;
          e.stdout = stdout;
          e.stderr = stderr;
          finish(reject, e);
          return;
        }
        finish(resolve, { code, stdout, stderr, text, errText });
      });
    });
  }

  // ---- adb 发现 / 版本 ----
  function effectiveSdkRoot() {
    if (sdkRoot) return sdkRoot;
    if (externalSdkRoot) {
      try {
        const value = externalSdkRoot();
        if (value && String(value).trim()) return path.resolve(String(value).trim());
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  function resolveAdb(force = false) {
    if (!force && adbPathCache && existsSync(adbPathCache)) return adbPathCache;
    adbPathCache = null;
    const candidates = [];
    const root = effectiveSdkRoot();
    if (root) candidates.push(path.join(root, 'platform-tools', ADB_NAME));
    for (const envName of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) {
      const value = process.env[envName];
      if (value && String(value).trim()) {
        candidates.push(path.join(String(value).trim(), 'platform-tools', ADB_NAME));
      }
    }
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
      if (dir) candidates.push(path.join(dir, ADB_NAME));
    }
    candidates.push(adbExeInDataDir);

    const seen = new Set();
    for (const candidate of candidates) {
      let normalized;
      try {
        normalized = path.resolve(candidate);
      } catch {
        continue;
      }
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      try {
        if (existsSync(normalized)) {
          adbPathCache = normalized;
          return normalized;
        }
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  function requireAdb() {
    const adb = resolveAdb();
    if (adb) return adb;
    throw new Error(
      '未找到 adb：请先点击「安装 platform-tools」下载，或设置 Android SDK 根目录（含 platform-tools）',
    );
  }

  async function adbVersion(adbPath, force = false) {
    if (!force) {
      const cached = versionCache.get(adbPath);
      if (cached && Date.now() - cached.at < VERSION_CACHE_MS) return cached.version;
    }
    const r = await runCommand(adbPath, ['version'], { timeout: CMD_TIMEOUT_MS });
    const text = `${r.text}\n${r.errText}`;
    const platformMatch = /^\s*Version\s+(\S+)/m.exec(text);
    const bridgeMatch = /Android Debug Bridge version\s+(\S+)/i.exec(text);
    const version = (platformMatch && platformMatch[1]) || (bridgeMatch && bridgeMatch[1]) || null;
    versionCache.set(adbPath, { version, at: Date.now() });
    return version;
  }

  // ---- platform-tools 下载 / 解压 ----
  function describeNetworkError(e) {
    const cause = e && e.cause;
    const detail = cause ? cause.code || cause.message || String(cause) : '';
    return `${formatError(e)}${detail ? `（${detail}）` : ''}`;
  }

  async function downloadOnce(zipPath) {
    const tmpZip = `${zipPath}.part`;
    let response;
    try {
      const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
      response = await fetch(PLATFORM_TOOLS_URL, { signal, redirect: 'follow' });
    } catch (e) {
      throw new Error(`网络请求失败：${describeNetworkError(e)}`);
    }
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status} ${response.statusText || ''}`.trim());
    }
    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(tmpZip));
      await fsp.rename(tmpZip, zipPath);
    } catch (e) {
      await fsp.rm(tmpZip, { force: true }).catch(() => {});
      throw new Error(`写入临时文件失败：${describeNetworkError(e)}`);
    }
    const stat = await fsp.stat(zipPath).catch(() => null);
    if (!stat || stat.size < PLATFORM_TOOLS_MIN_BYTES) {
      throw new Error(`压缩包体积异常（${stat ? stat.size : 0} 字节）`);
    }
    return stat.size;
  }

  async function downloadPlatformTools(zipPath) {
    log('info', `下载 platform-tools：${PLATFORM_TOOLS_URL}`);
    let lastErrorDetail = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const size = await downloadOnce(zipPath);
        log('info', `下载完成：${(size / 1024 / 1024).toFixed(1)} MB`);
        return size;
      } catch (e) {
        lastErrorDetail = formatError(e);
        if (attempt < 2) {
          log('warn', `下载失败，1s 后重试：${lastErrorDetail}`);
          await sleep(1000);
        }
      }
    }
    throw new Error(`下载 platform-tools 失败：${lastErrorDetail || '未知错误'}`);
  }

  function psQuote(value) {
    return String(value).replace(/'/g, "''");
  }

  async function extractZip(zipPath, destination) {
    const script = [
      `Expand-Archive -LiteralPath '${psQuote(zipPath)}'`,
      `-DestinationPath '${psQuote(destination)}' -Force`,
    ].join(' ');
    const baseArgs = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
    ];
    log('info', `解压 platform-tools 到 ${destination}`);
    try {
      await runCommand('powershell.exe', baseArgs, { timeout: EXTRACT_TIMEOUT_MS });
    } catch (e) {
      // 极少数环境只有 pwsh，没有 Windows PowerShell。
      if (/无法执行/i.test(formatError(e))) {
        await runCommand('pwsh', baseArgs, { timeout: EXTRACT_TIMEOUT_MS });
      } else {
        throw new Error(`解压 platform-tools 失败：${formatError(e)}`);
      }
    }
  }

  async function doInstall(installOpts = {}) {
    const force = !!installOpts.force;
    installing = true;
    installError = null;
    try {
      // 幂等：已有可用的 adb 就直接返回（force 则重新下载）。
      if (!force && (await fileExists(adbExeInDataDir))) {
        try {
          const version = await adbVersion(adbExeInDataDir, true);
          resolveAdb(true);
          log('info', `platform-tools 已存在：${adbExeInDataDir}（${version || '版本未知'}）`);
          return { ok: true, path: adbExeInDataDir, version, cached: true };
        } catch (e) {
          const reason = formatError(e);
          const hint = adbRunHint(reason);
          if (hint) throw new Error(`platform-tools 已存在，但 adb.exe 无法运行：${reason}${hint}`);
          log('warn', `已有 platform-tools 不可用，重新安装：${reason}`);
        }
      }
      await fsp.mkdir(dataDir, { recursive: true });
      const zipPath = path.join(dataDir, 'platform-tools.zip');
      const existing = await fsp.stat(zipPath).catch(() => null);
      if (!force && existing && existing.size >= PLATFORM_TOOLS_MIN_BYTES) {
        log('info', '复用已下载的 platform-tools.zip');
      } else {
        await downloadPlatformTools(zipPath);
      }
      await fsp.mkdir(dataDir, { recursive: true });
      await extractZip(zipPath, dataDir);
      if (!(await fileExists(adbExeInDataDir))) {
        throw new Error(`解压完成但未找到 ${adbExeInDataDir}，压缩包内容可能不完整`);
      }
      const version = await adbVersion(adbExeInDataDir, true).catch((e) => {
        const reason = formatError(e);
        throw new Error(`platform-tools 已解压，但 adb.exe 无法运行：${reason}${adbRunHint(reason)}`);
      });
      if (!version) {
        throw new Error('adb version 未返回版本号，安装可能不完整');
      }
      resolveAdb(true);
      emulatorCache = null;
      log('info', `platform-tools 安装完成：${adbExeInDataDir}（${version}）`);
      return { ok: true, path: adbExeInDataDir, version };
    } catch (e) {
      installError = formatError(e);
      log('error', `安装 platform-tools 失败：${installError}`);
      throw e instanceof Error ? e : new Error(installError);
    } finally {
      installing = false;
    }
  }

  async function install(installOpts = {}) {
    if (installPromise) return installPromise; // 并发调用共用同一次安装
    installPromise = doInstall(installOpts).finally(() => {
      installPromise = null;
    });
    return installPromise;
  }

  // ---- 设备 ----
  function parseDevices(text) {
    const devices = [];
    for (const rawLine of String(text || '').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (/^List of devices/i.test(line)) continue;
      if (/^\*/.test(line)) continue; // "* daemon started successfully"
      const match = /^(\S+)\s+(\S+)(.*)$/.exec(line);
      if (!match) continue;
      const serial = match[1];
      const state = match[2];
      const rest = match[3] || '';
      const modelMatch = /\bmodel:(\S+)/.exec(rest);
      const deviceMatch = /\bdevice:(\S+)/.exec(rest);
      const productMatch = /\bproduct:(\S+)/.exec(rest);
      const model = modelMatch
        ? modelMatch[1].replace(/_/g, ' ')
        : deviceMatch
          ? deviceMatch[1].replace(/_/g, ' ')
          : productMatch
            ? productMatch[1].replace(/_/g, ' ')
            : serial;
      devices.push({ serial, state, model });
    }
    return devices;
  }

  async function devices() {
    const adb = resolveAdb();
    if (!adb) {
      lastError = '未找到 adb，无法读取设备列表';
      return [];
    }
    try {
      const r = await runCommand(adb, ['devices', '-l'], { timeout: CMD_TIMEOUT_MS });
      return parseDevices(r.text);
    } catch (e) {
      lastError = `读取设备列表失败：${formatError(e)}`;
      log('warn', lastError);
      return [];
    }
  }

  async function readResolution(adb, serial) {
    const r = await runCommand(adb, ['-s', serial, 'shell', 'wm', 'size'], {
      timeout: CMD_TIMEOUT_MS,
    });
    const text = r.text || '';
    const match =
      /Physical size:\s*(\d+)x(\d+)/i.exec(text) || /Override size:\s*(\d+)x(\d+)/i.exec(text);
    if (!match) {
      const sample = text.trim().slice(0, 160) || '（空输出）';
      throw new Error(`无法解析设备分辨率：wm size 输出为 ${sample}`);
    }
    return { width: Number(match[1]), height: Number(match[2]) };
  }

  async function select(serial) {
    const target = serial == null ? '' : String(serial).trim();
    if (!target) throw new Error('缺少设备 serial，无法选择设备');
    const adb = requireAdb();
    if (deviceSerial && deviceSerial !== target) {
      if (streaming) await stop();
      latestFrame = null;
      lastFrameAt = null;
      resolution = null;
    }
    deviceSerial = target;
    resolution = await readResolution(adb, target);
    lastError = null;
    log('info', `选中设备 ${target}（${resolution.width}x${resolution.height}）`);
    return { ok: true, serial: target, resolution };
  }

  /** 关闭模拟器 / 设备掉线后清掉选中状态，避免面板继续显示“在线设备”。 */
  async function forgetDevice() {
    try {
      if (streaming) await stop();
    } catch {
      /* ignore */
    }
    deviceSerial = null;
    resolution = null;
    latestFrame = null;
    lastFrameAt = null;
    return { ok: true };
  }

  function requireDevice() {
    if (!deviceSerial) {
      throw new Error('未选择安卓设备：请刷新设备列表并先选择一台设备');
    }
    return deviceSerial;
  }

  // ---- 截屏串流 ----
  function pngDimensions(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
    for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
      if (buffer[i] !== PNG_SIGNATURE[i]) return null;
    }
    if (buffer.toString('latin1', 12, 16) !== 'IHDR') return null;
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    if (!width || !height) return null;
    return { width, height };
  }

  async function captureScreencap(adb, serial) {
    const r = await runCommand(adb, ['-s', serial, 'exec-out', 'screencap', '-p'], {
      timeout: SCREENCAP_TIMEOUT_MS,
    });
    if (!r.stdout || r.stdout.length === 0) {
      throw new Error('screencap 返回空数据');
    }
    return r.stdout;
  }

  async function frameLoop(adb, serial, runId) {
    let interval = 300;
    while (streaming && loopSeq === runId) {
      const startedAt = Date.now();
      try {
        const buffer = await captureScreencap(adb, serial);
        if (!streaming || loopSeq !== runId) break;
        const dims = pngDimensions(buffer);
        if (!dims) throw new Error('screencap 返回的数据不是有效 PNG');
        latestFrame = { data: buffer, width: dims.width, height: dims.height, at: Date.now() };
        lastFrameAt = latestFrame.at;
        consecutiveFrameErrors = 0;
        lastError = null;
        const cost = Date.now() - startedAt;
        // 自适应：抓帧快则贴近最小间隔，慢则逐步放宽到最大值。
        interval = Math.round(150 + cost * 0.5);
        if (interval < FRAME_MIN_INTERVAL_MS) interval = FRAME_MIN_INTERVAL_MS;
        else if (interval > FRAME_MAX_INTERVAL_MS) interval = FRAME_MAX_INTERVAL_MS;
        log('debug', `帧 ${dims.width}x${dims.height} ${(buffer.length / 1024).toFixed(0)}KB 耗时 ${cost}ms`);
      } catch (e) {
        if (!streaming || loopSeq !== runId) break;
        consecutiveFrameErrors += 1;
        lastError = `截屏失败：${formatError(e)}`;
        log('warn', `截屏失败（${consecutiveFrameErrors}/${MAX_CONSECUTIVE_FRAME_ERRORS}）：${formatError(e)}`);
        if (consecutiveFrameErrors >= MAX_CONSECUTIVE_FRAME_ERRORS) {
          lastError = `连续 ${MAX_CONSECUTIVE_FRAME_ERRORS} 次截屏失败，已停止串流：${formatError(e)}`;
          log('error', lastError);
          streaming = false;
          break;
        }
        interval = FRAME_MAX_INTERVAL_MS;
      }
      if (streaming && loopSeq === runId) await sleep(interval);
    }
  }

  async function start() {
    if (streaming) return { ok: true, streaming: true, serial: deviceSerial, already: true };
    const adb = requireAdb();
    const serial = requireDevice();
    if (!resolution) {
      try {
        resolution = await readResolution(adb, serial);
      } catch (e) {
        log('warn', `读取分辨率失败（继续串流）：${formatError(e)}`);
      }
    }
    streaming = true;
    consecutiveFrameErrors = 0;
    lastError = null;
    const runId = ++loopSeq;
    loopPromise = (async () => {
      try {
        await frameLoop(adb, serial, runId);
      } catch (e) {
        lastError = `截屏循环异常终止：${formatError(e)}`;
        log('error', lastError);
      } finally {
        if (loopSeq === runId) {
          streaming = false;
          loopPromise = null;
        }
      }
    })();
    log('info', `开始截屏串流：${serial}`);
    return { ok: true, streaming: true, serial };
  }

  async function stop() {
    streaming = false;
    loopSeq += 1; // 让新循环与旧循环互斥
    wakeLoop();
    const pending = loopPromise;
    if (pending) {
      try {
        await pending;
      } catch {
        /* ignore */
      }
    }
    loopPromise = null;
    log('info', '已停止截屏串流');
    return { ok: true, streaming: false };
  }

  function frame() {
    if (!latestFrame) return null;
    return {
      data: latestFrame.data,
      width: latestFrame.width,
      height: latestFrame.height,
      at: latestFrame.at,
    };
  }

  // ---- 输入注入 ----
  async function shellInput(commandArgs) {
    const adb = requireAdb();
    const serial = requireDevice();
    const r = await runCommand(adb, ['-s', serial, 'shell', ...commandArgs], {
      timeout: CMD_TIMEOUT_MS,
    });
    return { ok: true, stdout: (r.text || '').trim() };
  }

  async function tap(x, y) {
    const px = toInt(x, 'x', 0);
    const py = toInt(y, 'y', 0);
    return shellInput(['input', 'tap', String(px), String(py)]);
  }

  async function swipe(x1, y1, x2, y2, ms = 300) {
    const ax = toInt(x1, 'x1', 0);
    const ay = toInt(y1, 'y1', 0);
    const bx = toInt(x2, 'x2', 0);
    const by = toInt(y2, 'y2', 0);
    let duration = Math.round(Number(ms));
    if (!Number.isFinite(duration)) duration = 300;
    duration = Math.max(50, Math.min(10_000, duration));
    return shellInput(['input', 'swipe', String(ax), String(ay), String(bx), String(by), String(duration)]);
  }

  function shellQuote(text) {
    return `'${String(text).replace(/'/g, `'\\''`)}'`;
  }

  function escapeInputText(raw) {
    // input text 无法注入换行；空格交给 input 的 %s 约定，其余字符用单引号包裹由设备端 shell 解析。
    let text = String(raw == null ? '' : raw).replace(/\r\n?|\n/g, ' ');
    text = text.trim();
    if (!text) throw new Error('要输入的文字为空');
    const withSpaces = text.replace(/ /g, '%s');
    return shellQuote(withSpaces);
  }

  async function text(value) {
    const quoted = escapeInputText(value);
    return shellInput(['input', 'text', quoted]);
  }

  async function key(name) {
    const raw = String(name == null ? '' : name).trim().toLowerCase();
    if (!raw) throw new Error('缺少按键名称');
    let keyArg;
    if (/^\d+$/.test(raw)) {
      keyArg = raw;
    } else if (Object.prototype.hasOwnProperty.call(KEY_MAP, raw)) {
      keyArg = String(KEY_MAP[raw]);
    } else if (/^keycode_/i.test(raw)) {
      keyArg = raw.toUpperCase();
    } else {
      keyArg = `KEYCODE_${raw.replace(/[^a-z0-9]+/g, '_').toUpperCase()}`;
    }
    return shellInput(['input', 'keyevent', keyArg]);
  }

  // ---- 模拟器 ----
  function findEmulator() {
    const candidates = [];
    const root = effectiveSdkRoot();
    if (root) candidates.push(path.join(root, 'emulator', EMULATOR_NAME));
    for (const envName of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) {
      const value = process.env[envName];
      if (value && String(value).trim()) {
        candidates.push(path.join(String(value).trim(), 'emulator', EMULATOR_NAME));
      }
    }
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
      if (dir) candidates.push(path.join(dir, EMULATOR_NAME));
    }
    const seen = new Set();
    for (const candidate of candidates) {
      let normalized;
      try {
        normalized = path.resolve(candidate);
      } catch {
        continue;
      }
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      try {
        if (existsSync(normalized)) return normalized;
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  async function avds(avdOpts = {}) {
    const force = !!avdOpts.force;
    const exe = findEmulator();
    const cacheKey = exe || '';
    const now = Date.now();
    if (
      !force &&
      emulatorCache &&
      emulatorCache.key === cacheKey &&
      now - emulatorCache.at < EMULATOR_CACHE_MS
    ) {
      return { ...emulatorCache.value };
    }
    let value;
    if (!exe) {
      value = { available: false, avds: [], path: null, error: null };
    } else {
      try {
        const r = await runCommand(exe, ['-list-avds'], { timeout: CMD_TIMEOUT_MS });
        const list = String(r.text || '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(
            (line) =>
              line &&
              !/^(INFO|WARN|WARNING|ERROR|PANIC)[:\s]/i.test(line) &&
              !/^emulator:/i.test(line),
          );
        value = { available: true, avds: list, path: exe, error: null };
      } catch (e) {
        value = { available: true, avds: [], path: exe, error: formatError(e) };
        log('warn', `读取 AVD 列表失败：${value.error}`);
      }
    }
    emulatorCache = { key: cacheKey, at: now, value };
    return { ...value };
  }

  async function launchEmulator(avdName) {
    const name = String(avdName == null ? '' : avdName).trim();
    if (!name) throw new Error('缺少 AVD 名称');
    const exe = findEmulator();
    if (!exe) {
      throw new Error('未找到 emulator.exe：请设置 Android SDK 根目录（含 emulator）或安装 Android SDK');
    }
    let child;
    try {
      child = spawn(exe, ['-avd', name], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: process.env,
      });
    } catch (e) {
      throw new Error(`启动模拟器失败：${formatError(e)}`);
    }
    child.on('error', (e) => {
      lastError = `启动模拟器失败：${formatError(e)}`;
      log('error', lastError);
    });
    child.unref();
    log('info', `已请求启动模拟器 ${name}（${exe}）`);
    return { ok: true, avd: name, path: exe, pid: child.pid ?? null };
  }

  // ---- SDK 设置 / 状态 / 释放 ----
  function setSdkRoot(value) {
    const raw = value == null ? '' : String(value).trim();
    sdkRoot = raw ? path.resolve(raw) : null;
    adbPathCache = null;
    emulatorCache = null;
    versionCache.clear();
    if (sdkRoot && !existsSync(sdkRoot)) {
      log('warn', `Android SDK 路径不存在：${sdkRoot}`);
    }
    log('info', sdkRoot ? `Android SDK 路径设为 ${sdkRoot}` : '已清除 Android SDK 路径');
    return { ok: true, sdkRoot };
  }

  async function status() {
    const adb = resolveAdb();
    let available = false;
    let version = null;
    if (adb) {
      try {
        version = await adbVersion(adb);
        available = true;
      } catch (e) {
        const reason = formatError(e);
        lastError = `adb 不可用：${reason}${adbRunHint(reason)}`;
        log('warn', lastError);
      }
    }

    let list = [];
    if (adb && available) list = await devices();

    const emulator = await avds().catch((e) => ({
      available: false,
      avds: [],
      path: null,
      error: formatError(e),
    }));

    let error = lastError;
    if (!available && !error) {
      error = installError || '未找到 adb：请点击「安装 platform-tools」（约 8MB）或设置 Android SDK 路径';
    }

    return {
      available,
      path: adb,
      version,
      devices: list,
      device: deviceSerial,
      deviceConnected: deviceSerial ? list.some((d) => d.serial === deviceSerial) : false,
      resolution,
      streaming,
      lastFrameAt,
      installing,
      installError,
      error,
      emulator: {
        available: emulator.available,
        avds: emulator.avds,
        path: emulator.path,
        error: emulator.error ?? null,
      },
      sdkRoot: effectiveSdkRoot(),
      dataDir,
    };
  }

  async function dispose() {
    try {
      await stop();
    } catch {
      /* ignore */
    }
    adbPathCache = null;
    versionCache.clear();
    emulatorCache = null;
  }

  return {
    status,
    install,
    devices,
    select,
    forgetDevice,
    start,
    stop,
    frame,
    tap,
    swipe,
    text,
    key,
    avds,
    launchEmulator,
    setSdkRoot,
    dispose,
  };
}
