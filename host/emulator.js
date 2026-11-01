/**
 * dsh-live-preview — Host 安卓模拟器一键安装后端。
 *
 * 契约见 ../CONTRACT-EMULATOR.md「host/emulator.js」一节：
 *   createEmulatorBackend({ dataDir, logger, onLog, onProgress }) → {
 *     status, install, installAccel, checkAccel, listAvds, createAvd,
 *     launch, stop, waitForDevice, deviceSerial, adbPath, dispose
 *   }
 *
 * 安装步骤（与契约一致，进度同步到 status.progress）：
 *   1. Java：JAVA_HOME / PATH / dataDir/jre 已有则复用，否则下载 Adoptium JRE 21
 *   2. cmdline-tools：下载 commandlinetools-win-*.zip → sdkRoot/cmdline-tools/latest
 *   3. 许可证：sdkmanager --licenses，stdin 定时喂 y
 *   4. SDK 包：platform-tools、emulator、platforms;android-35、系统镜像（约 1.8GB）
 *   5. AVD：avdmanager create avd → 改写 config.ini（720x1600/320dpi/2048MB/GPU host）
 *   6. 加速检测：emulator -accel-check，解析 WHPX/AEHD/HAXM
 *
 * 设计约束：
 *  - 无第三方依赖；所有外部命令都有超时并 windowsHide，失败抛带原因的错误，绝不挂死宿主；
 *  - 长下载用 fetch 流式读取并回调进度；解压用 PowerShell Expand-Archive（缺失回落 pwsh）；
 *  - 普通 .bat/.cmd 一律经 cmd.exe /d /s /c 包装执行（Node 不能直接 spawn .bat）；
 *  - status() 不做重活：只做文件存在性检查 + 小目录扫描 + 已有缓存；
 *  - install() 可重入：并发调用共享同一个 promise。
 *
 * 测试/镜像钩子（契约外的可选 settings，服务层不传时行为完全不变）：
 *   settings.commands = { java, sdkmanager, avdmanager, emulator, adb }   // 命令替身（支持 .bat）
 *   settings.jreZip / settings.cmdlineToolsZip / settings.aehdZip        // 本地压缩包替代网络下载
 *   settings.avdName                                                     // install 时使用的 AVD 名
 */
import { spawn } from 'node:child_process';
import { existsSync, promises as fsp } from 'node:fs';
import { curlDownload, getSystemProxy } from './netutil.js';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const IS_WIN = process.platform === 'win32';
const IS_ARM64 = process.arch === 'arm64';
const ADB_NAME = IS_WIN ? 'adb.exe' : 'adb';
const EMULATOR_NAME = IS_WIN ? 'emulator.exe' : 'emulator';

const JRE_URL_ARM64 =
  'https://api.adoptium.net/v3/binary/latest/21/ga/windows/aarch64/jre/hotspot/normal/eclipse?project=jdk';
const JRE_URL_X64 =
  'https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jre/hotspot/normal/eclipse?project=jdk';

/**
 * Java 下载源（按优先级排序，国内网络实测：华为 10MB/s、aka.ms 432KB/s、Adoptium 30KB/s）。
 * 均为 zip；解压后递归找 bin/java.exe，JAVA_HOME = java.exe 所在 bin 的父目录。
 */
const JRE_SOURCES = IS_ARM64
  ? [
      {
        id: 'adoptium-arm64',
        label: 'Adoptium JRE 21（arm64）',
        url: JRE_URL_ARM64,
        kind: 'zip',
        cacheName: 'adoptium-jre21-arm64.zip',
        minBytes: 20 * 1024 * 1024,
      },
    ]
  : [
      {
        id: 'huawei',
        label: '华为镜像 OpenJDK 21（约 190MB）',
        url: 'https://mirrors.huaweicloud.com/openjdk/21.0.2/openjdk-21.0.2_windows-x64_bin.zip',
        kind: 'zip',
        cacheName: 'openjdk-21.0.2_windows-x64_bin.zip',
        minBytes: 100 * 1024 * 1024,
      },
      {
        id: 'microsoft',
        label: 'Microsoft OpenJDK 21',
        url: 'https://aka.ms/download-jdk/microsoft-jdk-21-windows-x64.zip',
        kind: 'zip',
        cacheName: 'microsoft-jdk-21-windows-x64.zip',
        minBytes: 100 * 1024 * 1024,
      },
      {
        id: 'adoptium',
        label: 'Adoptium JRE 21',
        url: JRE_URL_X64,
        kind: 'zip',
        cacheName: 'adoptium-jre21.zip',
        minBytes: 20 * 1024 * 1024,
      },
    ];

const CMDLINE_TOOLS_URL =
  'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip';
const AEHD_URL = 'https://dl.google.com/android/repository/aehd-windows_v2.2.zip';

const MIN_BYTES = {
  jre: 20 * 1024 * 1024,
  cmdlineTools: 50 * 1024 * 1024,
  aehd: 50 * 1024,
};

const DOWNLOAD_TOTAL_TIMEOUT_MS = 90 * 60 * 1000;
/** 20s 无新数据即认为源失效，切换镜像（原 90s 太长）。 */
const DOWNLOAD_IDLE_TIMEOUT_MS = 20 * 1000;
const LOW_SPEED_BYTES_PER_SEC = 80 * 1024;
const LOW_SPEED_GRACE_MS = 8000;
const EXTRACT_TIMEOUT_MS = 15 * 60 * 1000;
const CMD_TIMEOUT_MS = 20 * 1000;
const LICENSE_TIMEOUT_MS = 180 * 1000;
const PACKAGES_TIMEOUT_MS = 90 * 60 * 1000;

const AVD_DEFAULT = 'dsh_live_preview';
const AVD_DEVICE = 'pixel_7';
const AVD_DEVICE_FALLBACKS = [AVD_DEVICE, 'pixel', null];
const AVD_TUNING = [
  ['hw.lcd.width', '720'],
  ['hw.lcd.height', '1600'],
  ['hw.lcd.density', '320'],
  // 稳定优先：2GB / 4 核（4GB/6 核 + 快照在本机会让 qemu 崩，已回退）。
  ['hw.ramSize', '2048'],
  ['hw.cpu.ncore', '4'],
  ['hw.keyboard', 'yes'],
  ['hw.gpu.enabled', 'yes'],
  ['hw.gpu.mode', 'host'],
];
/** 宿主 CPU 给模拟器的核数（-cores 参数，留出余量给 DSH/串流）。 */
const EMULATOR_CORES = 4;
const EMULATOR_MEMORY_MB = 2048;

const SYSTEM_IMAGE = `system-images;android-35;google_apis;${IS_ARM64 ? 'arm64-v8a' : 'x86_64'}`;
const TOTAL_STEPS = 6;
const STEP_TITLES = {
  java: 'Java 运行环境',
  'cmdline-tools': 'Android cmdline-tools',
  licenses: 'Android SDK 许可证',
  sdk: 'Android SDK 组件',
  avd: 'AVD 虚拟设备',
  accel: '硬件加速检测',
};
const STEP_ORDER = ['java', 'cmdline-tools', 'licenses', 'sdk', 'avd', 'accel'];

const AVDS_CACHE_MS = 3000;
const DEVICE_POLL_MS = 2000;
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const PROGRESS_LOG_STEP = 10;

// ---------------------------------------------------------------------------
// 纯函数（可被 Lead 直接单测）
// ---------------------------------------------------------------------------

/**
 * 解析 emulator -accel-check 的输出。
 * @param {string} text stdout+stderr 合并文本
 * @param {number|null} [exitCode]
 * @returns {{usable:boolean, mode:'WHPX'|'AEHD'|'HAXM'|'none'|'unknown', detail:string, raw:string, exitCode:number|null}}
 */
export function parseAccelText(text, exitCode = null) {
  const raw = String(text || '');
  const driverOf = (line) => {
    const l = line.toLowerCase();
    if (/aehd|android emulator hypervisor/.test(l)) return 'AEHD';
    if (/whpx|windows hypervisor/.test(l)) return 'WHPX';
    if (/\bhaxm\b/.test(l)) return 'HAXM';
    return null;
  };
  const usableDrivers = [];
  for (const line of raw.split(/\r?\n/)) {
    const l = line.toLowerCase();
    const positive =
      /\bis installed and usable\b|\bis working properly\b|\bis working\b|accel(eration)? is (available|enabled|ok|working)/.test(
        l,
      );
    if (!positive) continue;
    const driver = driverOf(line);
    if (driver) usableDrivers.push(driver);
  }
  const usable = usableDrivers.length > 0;
  let mode = usable ? usableDrivers[0] : 'none';
  if (!raw.trim() && !usable) mode = 'unknown';
  let detail;
  if (usable) {
    detail = `已启用硬件加速（${mode}），模拟器可满帧运行`;
  } else if (!raw.trim()) {
    detail = 'emulator -accel-check 无输出，无法判断加速状态；可启用 WHPX 或安装 AEHD 后重试。';
  } else {
    detail =
      '未检测到可用的硬件加速。可任选其一：① 启用 Windows Hypervisor Platform（WHPX）（「启用或关闭 Windows 功能」→ 勾选「Windows 虚拟机监控程序平台」→ 重启）；② 安装 AEHD 驱动（需管理员权限，会弹 UAC）。未启用加速时模拟器会明显变慢。';
  }
  return { usable, mode, detail, raw: raw.trim().slice(0, 600), exitCode };
}

/** 解析 adb devices 输出里的 emulator-* serial（仅 state=device）。 */
function parseDeviceSerials(text) {
  const serials = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^List of devices/i.test(line) || line.startsWith('*')) continue;
    const match = /^(\S+)\s+(\S+)/.exec(line);
    if (match && match[1].startsWith('emulator-') && match[2] === 'device') serials.push(match[1]);
  }
  return serials;
}

/** 解析 sdkmanager 进度行里的百分比（供单测/调试）。 */
export function parseSdkPercent(line) {
  const match = /(\d{1,3})\s*%/.exec(String(line || ''));
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null;
}

// ---------------------------------------------------------------------------
// 纯工具函数
// ---------------------------------------------------------------------------

function resolveDataDir(dataDir) {
  const raw = dataDir == null ? '' : String(dataDir).trim();
  if (raw) return path.resolve(raw);
  return path.join(process.env.LOCALAPPDATA || os.homedir(), 'dsh-live-preview');
}

function formatError(error) {
  if (!error) return '未知错误';
  if (typeof error === 'string') return error;
  if (error.message) return String(error.message);
  return String(error);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fileExists(target) {
  try {
    const st = await fsp.stat(target);
    return st.isFile();
  } catch {
    return false;
  }
}

async function statOrNull(target) {
  try {
    return await fsp.stat(target);
  } catch {
    return null;
  }
}

function psQuote(value) {
  return String(value).replace(/'/g, "''");
}

/** cmd.exe 参数引号（含 = ; , 等 cmd 会解析的字符）。 */
function cmdQuote(value) {
  const text = String(value);
  if (text === '') return '""';
  if (/^[\w@%+=:,./\\-]+$/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * 把要执行的程序归一化成 spawn 参数：.bat/.cmd 经 cmd.exe /d /s /c 包装，
 * 其余直接执行。
 */
function commandSpec(exe, args) {
  const target = String(exe);
  if (IS_WIN && /\.(bat|cmd)$/i.test(target)) {
    const line = [target, ...args].map(cmdQuote).join(' ');
    return {
      file: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${line}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { file: target, args: args.map(String), windowsVerbatimArguments: false };
}

function killTree(pid) {
  if (!pid) return;
  try {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } catch {
    /* ignore */
  }
}

/** 广度优先递归查找文件名（大小写不敏感）。 */
async function findFileUnder(root, basename, maxDepth = 6) {
  const wanted = String(basename).toLowerCase();
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length > 0) {
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const subdirs = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === wanted) return full;
      if (entry.isDirectory() && depth < maxDepth) subdirs.push(full);
    }
    for (const sub of subdirs) queue.push({ dir: sub, depth: depth + 1 });
  }
  return null;
}

/** 移动目录；跨卷或占用时退化为复制 + 删除。 */
async function moveDir(source, target) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.rm(target, { recursive: true, force: true });
  try {
    await fsp.rename(source, target);
    return;
  } catch (e) {
    const code = e && e.code;
    if (!['EXDEV', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EBUSY', 'EINVAL'].includes(code)) throw e;
  }
  await fsp.cp(source, target, { recursive: true, force: true });
  await fsp.rm(source, { recursive: true, force: true });
}

/** 运行一段 PowerShell（先 powershell.exe，失败回落 pwsh）。 */
async function runPowerShell(script, timeout) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];
  const first = await runCapture('powershell.exe', args, timeout);
  if (!first.error && first.code === 0) return first;
  const second = await runCapture('pwsh', args, timeout);
  if (!second.error && second.code === 0) return second;
  const detail = (
    first.error
      ? formatError(first.error)
      : (first.stderr || first.stdout || '').trim() || formatError(second.error)
  )
    .trim()
    .slice(0, 500);
  throw new Error(`PowerShell 执行失败：${detail || '未知错误'}`);
}

/** 宽容执行（不因非 0 退出码抛错），只用于 PowerShell 探测。 */
function runCapture(exe, args, timeout = CMD_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: '', error: e });
      return;
    }
    const out = [];
    const err = [];
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish({
        code: null,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        error: new Error(`命令超时（${timeout}ms）：${path.basename(exe)}`),
      });
    }, timeout);
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', (e) => finish({ code: null, stdout: '', stderr: '', error: e }));
    child.on('close', (code) =>
      finish({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        error: null,
      }),
    );
  });
}

/** Expand-Archive -Force。 */
async function expandArchive(zipPath, destination, label = '解压') {
  const script = [
    `Expand-Archive -LiteralPath '${psQuote(zipPath)}'`,
    `-DestinationPath '${psQuote(destination)}' -Force`,
  ].join(' ');
  try {
    await runPowerShell(script, EXTRACT_TIMEOUT_MS);
  } catch (e) {
    throw new Error(`${label}失败：${formatError(e)}`);
  }
}

/** 按压缩包类型解压（zip → Expand-Archive；tgz/tar.gz → Windows 自带 tar）。 */
async function extractArchive(kind, archivePath, destination, label = '解压') {
  const type = String(kind || 'zip').toLowerCase();
  if (type === 'tgz' || type === 'tar.gz' || /\.(tgz|tar\.gz)$/i.test(archivePath)) {
    const result = await runCapture('tar', ['-xzf', archivePath, '-C', destination], EXTRACT_TIMEOUT_MS);
    if (result.error || result.code !== 0) {
      const detail = result.error
        ? formatError(result.error)
        : (result.stderr || result.stdout || '').trim().slice(0, 500);
      throw new Error(`${label}失败（tar）：${detail || '未知错误'}`);
    }
    return;
  }
  await expandArchive(archivePath, destination, label);
}

function buildAbortError(label, kind, received, startedAt) {
  const elapsed = Math.max(1, (Date.now() - startedAt) / 1000);
  const rate = Math.round(received / elapsed / 1024);
  if (String(kind).startsWith('slow')) {
    const error = new Error(
      `${label}源太慢（${rate}KB/s < ${Math.round(LOW_SPEED_BYTES_PER_SEC / 1024)}KB/s），已中断切换镜像`,
    );
    error.code = 'SOURCE_SLOW';
    return error;
  }
  if (kind === 'idle') {
    const error = new Error(`${label}超时（${DOWNLOAD_IDLE_TIMEOUT_MS / 1000}s 无新数据）`);
    error.code = 'SOURCE_TIMEOUT';
    return error;
  }
  return new Error(`${label}超时（${DOWNLOAD_TOTAL_TIMEOUT_MS / 60000} 分钟）`);
}

/**
 * 下载到 dest（先写 .part 再改名）。
 * 低速策略：连接后 8s 平均 < 80KB/s 或 20s 无新数据 → 中断并抛 SOURCE_SLOW/SOURCE_TIMEOUT，
 * 调用方据此切换下一个下载源（Java 镜像 / cmdline-tools）。
 * @param {string} url
 * @param {string} dest
 * @param {{ onProgress?: (received:number,total:number)=>void, minBytes?:number, label?:string }} [options]
 */
async function downloadToFile(url, dest, options = {}) {
  const { onProgress, minBytes = 0, label = '下载' } = options;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  const controller = new AbortController();
  const startedAt = Date.now();
  let lastActivityAt = startedAt;
  let firstByteAt = 0;
  let abortKind = null;
  let received = 0;
  let total = 0;

  const monitor = setInterval(() => {
    if (abortKind) return;
    const now = Date.now();
    if (now - lastActivityAt > DOWNLOAD_IDLE_TIMEOUT_MS) {
      abortKind = 'idle';
      controller.abort();
      return;
    }
    // 低速判断必须在「已有首字节 + 足够样本」之后再做：
    // 首次连接 TLS/DNS 慢 8-20 秒很常见，不能因此误判整个源不可用。
    if (firstByteAt > 0 && received >= 1024 * 1024) {
      const sampleMs = now - firstByteAt;
      if (sampleMs >= LOW_SPEED_GRACE_MS) {
        const rate = received / (sampleMs / 1000);
        if (rate < LOW_SPEED_BYTES_PER_SEC) {
          abortKind = `slow:${Math.round(rate / 1024)}`;
          controller.abort();
        }
      }
    }
  }, 1000);
  const overallTimer = setTimeout(() => {
    if (abortKind) return;
    abortKind = 'overall';
    controller.abort();
  }, DOWNLOAD_TOTAL_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'dsh-live-preview/0.1 (+android-emulator)' },
    });
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status} ${response.statusText || ''}`.trim());
    }
    total = Number(response.headers.get('content-length')) || 0;
    const handle = await fsp.open(tmp, 'w');
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        if (chunk.length === 0) continue;
        await handle.write(chunk);
        received += chunk.length;
        if (firstByteAt === 0) firstByteAt = Date.now();
        lastActivityAt = Date.now();
        if (typeof onProgress === 'function') onProgress(received, total);
        if (abortKind) break;
      }
    } finally {
      await handle.close().catch(() => {});
    }
    if (abortKind && !(total > 0 && received >= total)) {
      throw buildAbortError(label, abortKind, received, startedAt);
    }
    if (received <= 0) throw new Error('下载内容为空');
    if (minBytes && received < minBytes) {
      throw new Error(
        `下载体积异常（${(received / 1024 / 1024).toFixed(1)}MB，预期至少 ${Math.round(
          minBytes / 1024 / 1024,
        )}MB）`,
      );
    }
    await fsp.rename(tmp, dest);
    return { received, total };
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    if (abortKind && !(total > 0 && received >= total)) {
      throw buildAbortError(label, abortKind, received, startedAt);
    }
    // Node fetch 在部分 Windows 网络下会 CONNECT_TIMEOUT：退回系统 curl（带系统代理）。
    try {
      const viaCurl = await curlDownload(url, tmp, {
        label: `${label}（curl 兜底）`,
        onProgress: (size) => {
          received = size;
          if (typeof onProgress === 'function') onProgress(size, 0);
        },
      });
      if (minBytes && viaCurl.received < minBytes) {
        throw new Error(`下载体积异常（${(viaCurl.received / 1024 / 1024).toFixed(1)}MB，低于预期）`);
      }
      await fsp.rename(tmp, dest);
      return { received: viaCurl.received, total: viaCurl.received };
    } catch (curlError) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      const cause = e && e.cause ? e.cause.code || e.cause.message || '' : '';
      throw new Error(
        `${label}失败：fetch ${formatError(e)}${cause ? `（${cause}）` : ''}；curl ${formatError(curlError)}`,
      );
    }
  } finally {
    clearInterval(monitor);
    clearTimeout(overallTimer);
  }
}

// ---------------------------------------------------------------------------
// 后端工厂
// ---------------------------------------------------------------------------

/**
 * @param {{ dataDir?:string, logger?:any, onLog?:(entry:{level:string,message:string,t:number})=>void,
 *           onProgress?:(p:{step:string|null,index:number,total:number,detail:string,percent:number})=>void,
 *           commands?:Record<string,string>, jreZip?:string, cmdlineToolsZip?:string, aehdZip?:string,
 *           avdName?:string }} [settings]
 */
export function createEmulatorBackend(settings = {}) {
  const dataDir = resolveDataDir(settings.dataDir);
  const logger = settings.logger;
  const onLog = typeof settings.onLog === 'function' ? settings.onLog : null;
  const onProgress = typeof settings.onProgress === 'function' ? settings.onProgress : null;
  const overrides = settings.commands && typeof settings.commands === 'object' ? settings.commands : {};
  const archiveOverrides = {
    jre: settings.jreZip ? String(settings.jreZip) : null,
    cmdlineTools: settings.cmdlineToolsZip ? String(settings.cmdlineToolsZip) : null,
    aehd: settings.aehdZip ? String(settings.aehdZip) : null,
  };

  // ---- 目录布局（契约「数据目录」） ----
  const sdkRoot = path.join(dataDir, 'android-sdk');
  const avdDir = path.join(dataDir, 'avd');
  const androidUserHome = path.join(dataDir, 'android-user-home');
  const downloadsDir = path.join(dataDir, 'downloads');
  const jreDir = path.join(dataDir, 'jre');
  const systemImageDir = path.join(
    sdkRoot,
    'system-images',
    'android-35',
    'google_apis',
    IS_ARM64 ? 'arm64-v8a' : 'x86_64',
  );

  const PACKAGE_DEFS = [
    { pkg: 'platform-tools', kind: 'file', rel: path.join(sdkRoot, 'platform-tools', ADB_NAME) },
    { pkg: 'emulator', kind: 'file', rel: path.join(sdkRoot, 'emulator', EMULATOR_NAME) },
    {
      pkg: 'platforms;android-35',
      kind: 'file',
      rel: path.join(sdkRoot, 'platforms', 'android-35', 'android.jar'),
    },
    { pkg: SYSTEM_IMAGE, kind: 'dir', rel: systemImageDir },
  ];

  // ---- 运行状态 ----
  let javaHome = null;
  let javaPath = null;
  let javaVersion = null;
  let javaVersionChecking = null;
  let javaVersionAttemptedPath = null;
  let installing = false;
  let installingStep = null;
  let lastError = null;
  let installPromise = null;
  let emulatorChild = null;
  let currentSerial = null;
  let currentAvd = null;
  let launchPromise = null;
  let avdsCache = null;
  let avdsCacheAt = 0;
  let elevatedCache = null;
  let disposed = false;
  const progressState = { step: null, index: 0, total: TOTAL_STEPS, detail: '', percent: 0 };
  const accelState = { checked: false, usable: false, detail: '尚未检测硬件加速', mode: 'unknown' };

  // ---- 日志 / 进度 ----
  function log(level, message) {
    const text = String(message == null ? '' : message);
    if (onLog) {
      try {
        onLog({ level, message: text, t: Date.now() });
      } catch {
        /* ignore */
      }
    }
    try {
      if (!logger) return;
      if (typeof logger === 'function') {
        logger(level, text);
        return;
      }
      if (typeof logger[level] === 'function') {
        logger[level](text);
        return;
      }
      if (typeof logger.log === 'function') logger.log(text);
    } catch {
      /* 日志失败不影响主流程 */
    }
  }

  function emitProgress() {
    if (!onProgress) return;
    try {
      onProgress({ ...progressState });
    } catch {
      /* ignore */
    }
  }

  function beginStep(step, detail) {
    const index = STEP_ORDER.indexOf(step) + 1 || 1;
    progressState.step = step;
    progressState.index = index;
    progressState.total = TOTAL_STEPS;
    progressState.detail = String(detail || STEP_TITLES[step] || '');
    progressState.percent = Math.round(((index - 1) / TOTAL_STEPS) * 100);
    installingStep = STEP_TITLES[step] || step;
    emitProgress();
  }

  function stepFraction(fraction, detail) {
    const index = Math.max(1, Math.min(TOTAL_STEPS, progressState.index || 1));
    const value = Math.max(0, Math.min(1, Number(fraction) || 0));
    progressState.percent = Math.min(100, Math.round(((index - 1 + value) / TOTAL_STEPS) * 100));
    if (detail != null) progressState.detail = String(detail).slice(0, 400);
    emitProgress();
  }

  function completeStep(detail) {
    stepFraction(1, detail == null ? progressState.detail : detail);
  }

  function failProgress(message) {
    progressState.detail = String(message).slice(0, 400);
    emitProgress();
  }

  // ---- 命令定位（同步、只做存在性检查） ----
  function javaHomeOf(javaExe) {
    const dir = path.dirname(javaExe);
    return path.basename(dir).toLowerCase() === 'bin' ? path.dirname(dir) : dir;
  }

  function resolveJavaSync() {
    const candidates = [];
    if (overrides.java) {
      const target = String(overrides.java);
      candidates.push({ path: target, home: javaHomeOf(target) });
    }
    const envHome = process.env.JAVA_HOME && String(process.env.JAVA_HOME).trim();
    if (envHome) candidates.push({ path: path.join(envHome, 'bin', 'java.exe'), home: envHome });
    const localExe = path.join(jreDir, 'bin', 'java.exe');
    candidates.push({ path: localExe, home: jreDir });
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
      if (dir) {
        candidates.push({ path: path.join(dir, 'java.exe'), home: javaHomeOf(path.join(dir, 'java.exe')) });
      }
    }
    for (const candidate of candidates) {
      try {
        if (existsSync(candidate.path)) return candidate;
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  function emulatorPath() {
    if (overrides.emulator) {
      const target = String(overrides.emulator);
      return existsSync(target) ? target : null;
    }
    const local = path.join(sdkRoot, 'emulator', EMULATOR_NAME);
    if (existsSync(local)) return local;
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
      if (!dir) continue;
      const candidate = path.join(dir, EMULATOR_NAME);
      try {
        if (existsSync(candidate)) return candidate;
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  function sdkmanagerPath() {
    if (overrides.sdkmanager) {
      const target = String(overrides.sdkmanager);
      return existsSync(target) ? target : null;
    }
    const target = path.join(sdkRoot, 'cmdline-tools', 'latest', 'bin', 'sdkmanager.bat');
    return existsSync(target) ? target : null;
  }

  function avdmanagerPath() {
    if (overrides.avdmanager) {
      const target = String(overrides.avdmanager);
      return existsSync(target) ? target : null;
    }
    const target = path.join(sdkRoot, 'cmdline-tools', 'latest', 'bin', 'avdmanager.bat');
    return existsSync(target) ? target : null;
  }

  function adbPath() {
    if (overrides.adb) {
      const target = String(overrides.adb);
      return existsSync(target) ? target : null;
    }
    const candidates = [
      path.join(sdkRoot, 'platform-tools', ADB_NAME),
      path.join(dataDir, 'platform-tools', ADB_NAME),
    ];
    for (const candidate of candidates) {
      try {
        if (existsSync(candidate)) return candidate;
      } catch {
        /* ignore */
      }
    }
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
      if (!dir) continue;
      const candidate = path.join(dir, ADB_NAME);
      try {
        if (existsSync(candidate)) return candidate;
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  /** 执行命令用的环境变量：SDK / AVD / Java 全部指向插件数据目录。 */
  function toolEnv(extra = {}) {
    const env = { ...process.env };
    // 注意：Windows 上 process.env 的键名可能是 "Path" 而不是 "PATH"。展开成普通对象后
    // env.PATH 为 undefined，若直接拼 PATH 会丢掉全部系统路径（findstr/java/adb 都找不到）。
    // 这里先取出原始值，并清掉大小写不同的重复键（同一环境块里重复键会被覆盖）。
    const originalPath = process.env.PATH || process.env.Path || '';
    delete env.PATH;
    delete env.Path;
    delete env.path;
    if (javaHome) env.JAVA_HOME = javaHome;
    env.ANDROID_SDK_ROOT = sdkRoot;
    env.ANDROID_HOME = sdkRoot;
    env.ANDROID_AVD_HOME = avdDir;
    env.ANDROID_USER_HOME = androidUserHome;
    const prepend = [];
    if (javaHome) prepend.push(path.join(javaHome, 'bin'));
    prepend.push(
      path.join(sdkRoot, 'emulator'),
      path.join(sdkRoot, 'platform-tools'),
      path.join(dataDir, 'platform-tools'),
    );
    env.PATH = [...prepend, originalPath].filter(Boolean).join(path.delimiter);
    return Object.assign(env, extra);
  }

  // ---- 命令执行（带超时 / 喂 stdin / 流式回调） ----
  function runCommand(exe, args, cmdOpts = {}) {
    const timeout = cmdOpts.timeout ?? CMD_TIMEOUT_MS;
    const label = `${path.basename(String(exe))} ${args.join(' ')}`.slice(0, 300);
    const spec = commandSpec(exe, args);
    const feed = cmdOpts.feedInput;
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(spec.file, spec.args, {
          cwd: cmdOpts.cwd,
          env: cmdOpts.env ?? process.env,
          windowsHide: true,
          windowsVerbatimArguments: spec.windowsVerbatimArguments,
          stdio: [feed ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        reject(new Error(`无法执行 ${path.basename(String(exe))}：${formatError(e)}`));
        return;
      }
      const outChunks = [];
      const errChunks = [];
      let outBytes = 0;
      let errBytes = 0;
      let settled = false;
      let timer = null;
      let feedTimer = null;
      const stopFeed = () => {
        if (feedTimer) {
          clearInterval(feedTimer);
          feedTimer = null;
        }
      };
      const trim = (chunks, bytes) => {
        while (bytes > MAX_STREAM_BYTES / 2 && chunks.length > 1) {
          const dropped = chunks.shift();
          bytes -= dropped.length;
        }
        return bytes;
      };
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        stopFeed();
        fn(value);
      };
      timer = setTimeout(() => {
        const error = new Error(`命令超时（${timeout}ms）：${label}`);
        error.exitCode = null;
        error.stdout = Buffer.concat(outChunks);
        error.stderr = Buffer.concat(errChunks);
        error.timedOut = true;
        finish(reject, error);
        killTree(child.pid);
      }, timeout);
      child.stdout.on('data', (chunk) => {
        outChunks.push(chunk);
        outBytes += chunk.length;
        outBytes = trim(outChunks, outBytes);
        if (typeof cmdOpts.onStdout === 'function') {
          try {
            cmdOpts.onStdout(chunk.toString('utf8'));
          } catch {
            /* ignore */
          }
        }
      });
      child.stderr.on('data', (chunk) => {
        errChunks.push(chunk);
        errBytes += chunk.length;
        errBytes = trim(errChunks, errBytes);
        if (typeof cmdOpts.onStderr === 'function') {
          try {
            cmdOpts.onStderr(chunk.toString('utf8'));
          } catch {
            /* ignore */
          }
        }
      });
      child.on('error', (e) => {
        finish(reject, new Error(`无法执行 ${path.basename(String(exe))}：${formatError(e)}`));
      });
      child.on('close', (code) => {
        const stdout = Buffer.concat(outChunks);
        const stderr = Buffer.concat(errChunks);
        const result = {
          code,
          stdout,
          stderr,
          text: stdout.toString('utf8'),
          errText: stderr.toString('utf8'),
        };
        if (code !== 0) {
          const tail = (result.errText || result.text || '').trim();
          const error = new Error(
            `${label} 失败（exit ${code}）${tail ? `：${tail.slice(0, 400)}` : ''}`,
          );
          error.exitCode = code;
          error.stdout = stdout;
          error.stderr = stderr;
          finish(reject, error);
          return;
        }
        finish(resolve, result);
      });
      if (feed && child.stdin) {
        child.stdin.on('error', () => {
          /* 进程退出后的 EPIPE 忽略 */
        });
        let sent = 0;
        const maxTimes = feed.maxTimes ?? 40;
        const writeOnce = () => {
          if (settled || sent >= maxTimes) {
            stopFeed();
            return;
          }
          sent += 1;
          try {
            child.stdin.write(feed.text ?? 'y\n');
          } catch {
            stopFeed();
          }
        };
        writeOnce(); // 立刻先喂一次，避免 sdkmanager 等待
        feedTimer = setInterval(writeOnce, feed.intervalMs ?? 500);
      }
    });
  }

  // ---- 压缩包准备（支持本地替身 / 缓存复用 / 损坏重下） ----
  async function prepareArchive(options) {
    const { label, url, zipPath, localOverride, minBytes, onProgress: progressCb, force = false } = options;
    await fsp.mkdir(path.dirname(zipPath), { recursive: true });
    if (localOverride) {
      const overridePath = path.resolve(localOverride);
      if (!(await fileExists(overridePath))) {
        throw new Error(`${label} 本地压缩包不存在：${overridePath}`);
      }
      if (path.resolve(zipPath) !== overridePath) {
        await fsp.copyFile(overridePath, zipPath);
      }
      if (progressCb) progressCb(1, `使用本地压缩包 ${path.basename(overridePath)}`);
      return { cached: true, local: true };
    }
    if (!force) {
      const stat = await statOrNull(zipPath);
      if (stat && stat.isFile() && stat.size >= minBytes) {
        if (progressCb) progressCb(1, `复用已下载的${label}压缩包`);
        return { cached: true, local: false };
      }
    }
    if (progressCb) progressCb(0, `开始下载 ${label}`);
    const startedAt = Date.now();
    await downloadToFile(url, zipPath, {
      label: `下载${label}`,
      minBytes,
      onProgress: (received, total) => {
        if (!progressCb) return;
        const fraction = total > 0 ? received / total : 0;
        const mb = (received / 1024 / 1024).toFixed(1);
        const totalMb = total > 0 ? (total / 1024 / 1024).toFixed(1) : '?';
        progressCb(fraction, `正在下载${label} ${mb}MB / ${totalMb}MB`);
      },
    });
    log('info', `${label} 下载完成（${((Date.now() - startedAt) / 1000).toFixed(1)}s）`);
    return { cached: false, local: false };
  }

  async function withArchive(options, extractFn) {
    const prepared = await prepareArchive(options);
    try {
      return await extractFn();
    } catch (e) {
      if (!prepared.cached || prepared.local) throw e;
      log('warn', `${options.label} 缓存压缩包不可用（${formatError(e)}），删除后重新下载`);
      await fsp.rm(options.zipPath, { force: true }).catch(() => {});
      await sleep(300);
      await prepareArchive({ ...options, force: true });
      return extractFn();
    }
  }

  // ---- 各安装步骤 ----

  async function javaVersionOf(target) {
    try {
      const result = await runCommand(target, ['-version'], { timeout: 15000, env: toolEnv() });
      const text = `${result.text}\n${result.errText}`;
      const match = /version "([^"]+)"/i.exec(text) || /(?:openjdk|java)\s+(\d[\w.+-]*)/i.exec(text);
      return match ? match[1] : null;
    } catch (e) {
      if (e && (e.stdout || e.stderr)) {
        const text = `${e.stdout ? e.stdout.toString('utf8') : ''}\n${e.stderr ? e.stderr.toString('utf8') : ''}`;
        const match = /version "([^"]+)"/i.exec(text);
        if (match) return match[1];
      }
      return null;
    }
  }

  async function ensureJava() {
    const existing = resolveJavaSync();
    if (existing) {
      const version = await javaVersionOf(existing.path);
      javaHome = existing.home;
      javaPath = existing.path;
      if (version) javaVersion = version;
      log('info', `复用已有 Java：${existing.path}${version ? `（${version}）` : ''}`);
      completeStep(`Java 已就绪${version ? `（${version}）` : ''}`);
      return { path: existing.path, home: existing.home, version, source: 'existing' };
    }
    if (!IS_WIN) throw new Error('自动安装 Java 目前仅支持 Windows');

    const sources = archiveOverrides.jre
      ? [
          {
            id: 'local',
            label: '本地 Java 压缩包',
            url: null,
            kind: 'zip',
            cacheName: 'jre-local.zip',
            minBytes: 0,
            localOverride: archiveOverrides.jre,
          },
        ]
      : JRE_SOURCES;

    const failures = [];
    for (const source of sources) {
      try {
        return await installJavaFromSource(source);
      } catch (e) {
        const reason = formatError(e);
        failures.push(`${source.id}: ${reason}`);
        log(
          'warn',
          `Java 来源 ${source.label} 失败（${reason.slice(0, 200)}），切换下一个下载源`,
        );
        stepFraction(0.02, `Java 来源 ${source.label} 不可用，切换下一个源…`);
      }
    }
    throw new Error(`便携 Java 安装失败：所有下载源均不可用：\n${failures.join('\n')}`);
  }

  /** 从单个下载源安装 Java（zip → 递归找 bin/java.exe → JAVA_HOME = bin 的父目录）。 */
  async function installJavaFromSource(source) {
    const zipPath = path.join(downloadsDir, source.cacheName || 'jre.zip');
    const extractDir = path.join(downloadsDir, 'jre-extract');
    const label = source.label || source.id;

    const prepare = (force = false) =>
      prepareArchive({
        label,
        url: source.url,
        zipPath,
        localOverride: source.localOverride,
        minBytes: source.minBytes ?? MIN_BYTES.jre,
        force,
        onProgress: (fraction, text) => stepFraction(fraction * 0.8, text),
      });

    const prepared = await prepare(false);
    const runExtract = async () => {
      await fsp.rm(extractDir, { recursive: true, force: true });
      await fsp.mkdir(extractDir, { recursive: true });
      stepFraction(0.82, `正在解压 ${label}…`);
      await extractArchive(source.kind, zipPath, extractDir, `解压 ${label}`);
      const javaExe = await findFileUnder(extractDir, 'java.exe', 7);
      if (!javaExe) throw new Error(`${label} 解压完成但未找到 bin/java.exe`);
      const home = javaHomeOf(javaExe);
      stepFraction(0.92, '正在部署 JDK 到 dataDir/jre…');
      await moveDir(home, jreDir);
    };
    try {
      await runExtract();
    } catch (e) {
      if (!prepared.cached || source.localOverride) throw e;
      // 缓存压缩包可能损坏：删掉重下一次。
      log('warn', `Java 压缩包缓存不可用（${formatError(e)}），重新下载`);
      await fsp.rm(zipPath, { force: true }).catch(() => {});
      await prepare(true);
      await runExtract();
    }

    const jreExe = path.join(jreDir, 'bin', 'java.exe');
    if (!(await fileExists(jreExe))) throw new Error(`Java 部署失败，未找到 ${jreExe}`);
    stepFraction(0.96, '正在校验 Java 版本…');
    const version = await javaVersionOf(jreExe);
    if (!version) {
      throw new Error(`Java 已安装到 ${jreDir}，但 java -version 无法解析版本号（可能被安全软件拦截）`);
    }
    javaHome = jreDir;
    javaPath = jreExe;
    javaVersion = version;
    await fsp.rm(extractDir, { recursive: true, force: true }).catch(() => {});
    log('info', `Java 安装完成：${jreExe}（${version}，来源 ${source.id}）`);
    completeStep(`Java 已就绪（${version}）`);
    return { path: jreExe, home: jreDir, version, source: source.id };
  }

  async function ensureCmdlineTools() {
    if (sdkmanagerPath() && avdmanagerPath()) {
      log('info', 'cmdline-tools 已存在，跳过下载');
      completeStep('cmdline-tools 已安装');
      return;
    }
    if (!IS_WIN) throw new Error('自动安装 cmdline-tools 目前仅支持 Windows');
    await fsp.mkdir(sdkRoot, { recursive: true });

    const zipPath = path.join(downloadsDir, 'commandlinetools-win-latest.zip');
    const extractDir = path.join(downloadsDir, 'cmdline-tools-extract');
    const latestDir = path.join(sdkRoot, 'cmdline-tools', 'latest');
    await withArchive(
      {
        label: 'Android cmdline-tools',
        url: CMDLINE_TOOLS_URL,
        zipPath,
        localOverride: archiveOverrides.cmdlineTools,
        minBytes: MIN_BYTES.cmdlineTools,
        onProgress: (fraction, text) => stepFraction(fraction * 0.8, text),
      },
      async () => {
        await fsp.rm(extractDir, { recursive: true, force: true });
        await fsp.mkdir(extractDir, { recursive: true });
        stepFraction(0.82, '正在解压 cmdline-tools（约 153MB）…');
        await expandArchive(zipPath, extractDir, '解压 cmdline-tools');
        const sdkmanagerBat = await findFileUnder(extractDir, 'sdkmanager.bat', 6);
        if (!sdkmanagerBat) throw new Error('cmdline-tools 解压完成但未找到 sdkmanager.bat');
        const home = path.dirname(path.dirname(sdkmanagerBat)); // …/cmdline-tools
        stepFraction(0.9, '正在移动到 sdkRoot/cmdline-tools/latest…');
        await moveDir(home, latestDir);
      },
    );
    const sdkmanagerBat = path.join(latestDir, 'bin', 'sdkmanager.bat');
    const avdmanagerBat = path.join(latestDir, 'bin', 'avdmanager.bat');
    if (!(await fileExists(sdkmanagerBat))) {
      throw new Error(`cmdline-tools 安装不完整：未找到 ${sdkmanagerBat}`);
    }
    if (!(await fileExists(avdmanagerBat))) {
      throw new Error(`cmdline-tools 安装不完整：未找到 ${avdmanagerBat}`);
    }
    await fsp.rm(extractDir, { recursive: true, force: true }).catch(() => {});
    log('info', `cmdline-tools 安装完成：${latestDir}`);
    completeStep('cmdline-tools 已安装');
  }

  async function acceptLicenses() {
    const sdkmanager = sdkmanagerPath();
    if (!sdkmanager) throw new Error('未找到 sdkmanager.bat，无法接受 SDK 许可证（请先安装 cmdline-tools）');
    stepFraction(0.05, '正在接受 Android SDK 许可证（自动应答 y）…');
    let result;
    try {
      result = await runCommand(sdkmanager, ['--sdk_root=' + sdkRoot, '--licenses'], {
        timeout: LICENSE_TIMEOUT_MS,
        env: toolEnv(),
        feedInput: { text: 'y\n', intervalMs: 500, maxTimes: 40 },
      });
    } catch (e) {
      log('warn', `许可证应答失败（继续安装，安装 SDK 包时会重试）：${formatError(e)}`);
      completeStep('许可证应答未确认，继续安装');
      return;
    }
    const text = `${result.text}\n${result.errText}`.trim();
    if (result.code === 0 || /All SDK package licenses accepted/i.test(text)) {
      log('info', 'Android SDK 许可证已接受');
      completeStep('许可证已接受');
      return;
    }
    log('warn', `许可证应答退出码 ${result.code}（继续安装）：${text.slice(-400)}`);
    completeStep('许可证应答未完全成功，安装时重试');
  }

  async function packagePresent(def) {
    if (def.kind === 'dir') {
      try {
        return (await fsp.stat(def.rel)).isDirectory();
      } catch {
        return false;
      }
    }
    return fileExists(def.rel);
  }

  async function ensurePackages() {
    const sdkmanager = sdkmanagerPath();
    if (!sdkmanager) throw new Error('未找到 sdkmanager.bat，无法安装 SDK 组件');
    const missing = [];
    for (const def of PACKAGE_DEFS) {
      if (!(await packagePresent(def))) missing.push(def);
    }
    if (missing.length === 0) {
      log('info', 'Android SDK 组件已全部安装，跳过下载');
      completeStep('SDK 组件已安装');
      return;
    }
    await fsp.mkdir(sdkRoot, { recursive: true });
    log('info', `安装 SDK 组件：${missing.map((m) => m.pkg).join('、')}（约 1.8GB，请耐心等待）`);
    stepFraction(0.01, '正在连接 Google SDK 仓库…');

    const total = missing.length;
    const pctByPkg = new Map();
    let lineBuffer = '';
    let tail = '';
    let lastLoggedPercent = -1;
    const handleLine = (rawLine) => {
      const line = String(rawLine).replace(/^\s*\[[^\]]*\]\s*/, '').trim();
      if (!line) return;
      tail = `${tail}\n${line}`.slice(-2000);
      const percent = parseSdkPercent(line);
      const matched = missing.find(
        (def) => line.includes(def.pkg) || line.includes(def.pkg.replace(/;/g, '/')),
      );
      if (percent != null && matched) {
        pctByPkg.set(matched.pkg, Math.max(pctByPkg.get(matched.pkg) || 0, percent));
      }
      let sum = 0;
      for (const value of pctByPkg.values()) sum += value;
      const fraction = total > 0 ? sum / (100 * total) : 0;
      if (percent != null) {
        stepFraction(fraction, `${matched ? matched.pkg : 'SDK 组件'} ${percent}%`);
        const flat = Math.floor(fraction * 100);
        if (flat >= lastLoggedPercent + PROGRESS_LOG_STEP) {
          lastLoggedPercent = flat;
          log('info', `SDK 安装进度约 ${flat}%（${matched ? matched.pkg : '组件'} ${percent}%）`);
        }
      } else if (/Preparing|Unzipping|Installing|Downloading/i.test(line)) {
        stepFraction(fraction, line.slice(0, 200));
      }
    };
    const onStdout = (chunk) => {
      lineBuffer += chunk;
      const lines = lineBuffer.split(/\r?\n|\r/);
      lineBuffer = lines.pop() || '';
      for (const line of lines) handleLine(line);
    };

    let result;
    const proxyArgs = (() => {
      try {
        const proxy = getSystemProxy();
        if (!proxy) return [];
        const url = new URL(proxy);
        if (!url.hostname || !url.port) return [];
        log('info', `sdkmanager 使用系统代理 ${url.hostname}:${url.port}`);
        return ['--proxy=http', `--proxy_host=${url.hostname}`, `--proxy_port=${url.port}`];
      } catch {
        return [];
      }
    })();
    const installArgs = ['--sdk_root=' + sdkRoot, ...proxyArgs, ...missing.map((m) => m.pkg)];
    let lastError = null;
    // sdkmanager 对 Google 仓库的连接偶发超时：同一条命令最多重试 3 次（已下载的包会跳过）。
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        result = await runCommand(sdkmanager, installArgs, {
          timeout: PACKAGES_TIMEOUT_MS,
          env: toolEnv(),
          feedInput: { text: 'y\n', intervalMs: 1500, maxTimes: 80 },
          onStdout,
        });
        if (result.code === 0) break;
        lastError = new Error(`sdkmanager exit ${result.code}`);
      } catch (e) {
        lastError = e;
      }
      if (attempt < 3) {
        const message = formatError(lastError);
        log('warn', `SDK 组件第 ${attempt} 次安装失败（${message.slice(0, 160)}），2 秒后重试…`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    if (!result && lastError) {
      throw new Error(`SDK 组件安装失败：${formatError(lastError)}`);
    }
    if (result && result.code !== 0) {
      const chunks = [];
      if (result.stdout) chunks.push(Buffer.isBuffer(result.stdout) ? result.stdout.toString('utf8') : String(result.stdout));
      if (result.stderr) chunks.push(Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : String(result.stderr));
      const detail = (chunks.join('\n').trim() || tail || formatError(lastError) || '').slice(-1500);
      throw new Error(`SDK 组件安装失败（sdkmanager exit ${result.code}）：${detail || '无输出'}`);
    }
    if (lineBuffer) handleLine(lineBuffer);
    const stillMissing = [];
    for (const def of PACKAGE_DEFS) {
      if (!(await packagePresent(def))) stillMissing.push(def.pkg);
    }
    if (stillMissing.length > 0) {
      throw new Error(`sdkmanager 已退出但以下组件仍缺失：${stillMissing.join('、')}（请重试安装）`);
    }
    completeStep('SDK 组件已安装');
    log('info', 'Android SDK 组件安装完成');
  }

  // ---- AVD ----
  function normalizeAvdName(name) {
    const text = name == null ? '' : String(name).trim();
    if (!text) return '';
    if (!/^[A-Za-z0-9_.-]+$/.test(text)) {
      throw new Error(`AVD 名称不合法（只允许字母/数字/下划线/点/短横线）：${text}`);
    }
    return text;
  }

  async function pickAvdPath(name) {
    const candidate = path.join(avdDir, `${name}.avd`);
    try {
      if ((await fsp.stat(candidate)).isDirectory()) return candidate;
    } catch {
      /* ignore */
    }
    const iniPath = path.join(avdDir, `${name}.ini`);
    try {
      const ini = await fsp.readFile(iniPath, 'utf8');
      const match = /^\s*path\s*=\s*(.+)\s*$/im.exec(ini);
      if (match) {
        const value = match[1].trim();
        try {
          if ((await fsp.stat(value)).isDirectory()) return value;
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  async function patchAvdConfig(avdPath, name) {
    const configPath = path.join(avdPath, 'config.ini');
    let raw;
    try {
      raw = await fsp.readFile(configPath, 'utf8');
    } catch {
      log('warn', `AVD 配置文件不存在，跳过分辨率/内存调优：${configPath}`);
      return { patched: false, configPath };
    }
    const desired = new Map(AVD_TUNING);
    const seen = new Set();
    const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/);
    const output = lines.map((line) => {
      const match = /^([^=#\s][^=]*?)\s*=\s*(.*)$/.exec(line);
      if (!match || !desired.has(match[1].trim())) return line;
      const key = match[1].trim();
      if (seen.has(key)) return '';
      seen.add(key);
      return `${key}=${desired.get(key)}`;
    });
    for (const [key, value] of desired) if (!seen.has(key)) output.push(`${key}=${value}`);
    while (output.length > 0 && output[output.length - 1] === '') output.pop();
    await fsp.writeFile(configPath, `${output.join('\r\n')}\r\n`, 'utf8');
    log('info', `已调优 AVD ${name} 配置：720x1600 / 320dpi / 2GB / 4 核 / GPU host / quickboot`);
    return { patched: true, configPath };
  }

  async function createAvdInternal(name) {
    const avdName = normalizeAvdName(name) || AVD_DEFAULT;
    const avdmanager = avdmanagerPath();
    if (!avdmanager) throw new Error('未找到 avdmanager.bat：请先完成 Android SDK 安装');
    await fsp.mkdir(avdDir, { recursive: true });
    stepFraction(0.05, `正在创建 AVD ${avdName}…`);

    let lastFailure = null;
    for (const device of AVD_DEVICE_FALLBACKS) {
      const args = ['create', 'avd', '-n', avdName, '-k', SYSTEM_IMAGE, '--force'];
      if (device) args.push('-d', device);
      let result;
      try {
        result = await runCommand(avdmanager, args, {
          timeout: 180000,
          env: toolEnv(),
          feedInput: { text: 'no\n', intervalMs: 500, maxTimes: 6 },
        });
      } catch (e) {
        lastFailure = e;
        const message = formatError(e);
        if (device && /invalid device|unknown device|device id|no such device|not found/i.test(message)) {
          log('warn', `avdmanager 不接受设备型号 ${device}，回退下一个：${message.slice(0, 200)}`);
          continue;
        }
        throw new Error(`创建 AVD 失败（设备 ${device || '默认'}）：${message}`);
      }
      stepFraction(0.6, `AVD ${avdName} 已创建，正在调优配置…`);
      const foundPath = await pickAvdPath(avdName);
      if (!foundPath) {
        lastFailure = new Error(
          `avdmanager 返回成功但未找到 AVD 目录（${path.join(avdDir, `${avdName}.avd`)}）`,
        );
        log('warn', formatError(lastFailure));
        continue;
      }
      await patchAvdConfig(foundPath, avdName);
      avdsCache = null;
      avdsCacheAt = 0;
      log('info', `AVD 创建完成：${avdName}（${foundPath}）`);
      completeStep(`AVD ${avdName} 已就绪`);
      return { name: avdName, path: foundPath };
    }
    throw lastFailure || new Error('创建 AVD 失败：未知原因');
  }

  async function readAvdImage(avdPath) {
    try {
      const config = await fsp.readFile(path.join(avdPath, 'config.ini'), 'utf8');
      const match = /^\s*image\.sysdir\.1\s*=\s*(.+)$/im.exec(config);
      if (match) return match[1].trim().replace(/[\\/]+$/, '').replace(/\\/g, '/');
    } catch {
      /* ignore */
    }
    return null;
  }

  async function scanAvds() {
    const result = new Map();
    let entries = [];
    try {
      entries = await fsp.readdir(avdDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.ini')) continue;
      const name = entry.name.slice(0, -4);
      let avdPath = path.join(avdDir, `${name}.avd`);
      try {
        const ini = await fsp.readFile(path.join(avdDir, entry.name), 'utf8');
        const match = /^\s*path\s*=\s*(.+)\s*$/im.exec(ini);
        if (match) avdPath = match[1].trim();
      } catch {
        /* ignore */
      }
      result.set(name, { name, image: await readAvdImage(avdPath), path: avdPath });
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.toLowerCase().endsWith('.avd')) continue;
      const name = entry.name.slice(0, -4);
      if (result.has(name)) continue;
      const avdPath = path.join(avdDir, entry.name);
      result.set(name, { name, image: await readAvdImage(avdPath), path: avdPath });
    }
    return [...result.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async function listAvds(force = false) {
    const now = Date.now();
    if (!force && avdsCache && now - avdsCacheAt < AVDS_CACHE_MS) {
      return avdsCache.map((item) => ({ ...item }));
    }
    const list = await scanAvds();
    avdsCache = list;
    avdsCacheAt = now;
    return list.map((item) => ({ ...item }));
  }

  // ---- 加速检测 ----
  async function checkAccelInternal() {
    const emulator = emulatorPath();
    if (!emulator) {
      accelState.checked = true;
      accelState.usable = false;
      accelState.mode = 'unknown';
      accelState.detail = '未找到 emulator.exe：请先完成「安装安卓模拟器」（Android SDK）';
      return { ...accelState };
    }
    let text = '';
    let code = null;
    let execError = null;
    try {
      const result = await runCommand(emulator, ['-accel-check'], { timeout: 30000, env: toolEnv() });
      text = `${result.text}\n${result.errText}`;
      code = result.code;
    } catch (e) {
      if (e && (e.stdout || e.stderr)) {
        text = `${e.stdout ? e.stdout.toString('utf8') : ''}\n${e.stderr ? e.stderr.toString('utf8') : ''}`;
        code = typeof e.exitCode === 'number' ? e.exitCode : null;
      } else {
        execError = e;
      }
    }
    if (execError) {
      accelState.checked = true;
      accelState.usable = false;
      accelState.mode = 'unknown';
      accelState.detail = `无法执行 emulator -accel-check：${formatError(execError)}`;
      return { ...accelState };
    }
    const parsed = parseAccelText(text, code);
    accelState.checked = true;
    accelState.usable = parsed.usable;
    accelState.mode = parsed.mode;
    accelState.detail = parsed.detail;
    log(parsed.usable ? 'info' : 'warn', `硬件加速检测：${parsed.detail}`);
    return { ...accelState, raw: parsed.raw };
  }

  async function isProcessElevated() {
    if (elevatedCache != null) return elevatedCache;
    try {
      const result = await runCommand('whoami', ['/groups'], { timeout: 10000 });
      elevatedCache = /S-1-16-12288/i.test(`${result.text}\n${result.errText}`);
    } catch {
      elevatedCache = false;
    }
    return elevatedCache;
  }

  async function writeElevationWrapper(installer) {
    const wrapper = path.join(path.dirname(installer), 'run_elevated.cmd');
    const content = ['@echo off', 'cd /d "%~dp0"', `call "%~dp0${path.basename(installer)}"`, ''].join('\r\n');
    await fsp.writeFile(wrapper, content, 'utf8');
    return wrapper;
  }

  async function findAehdInstaller() {
    const candidates = [
      path.join(sdkRoot, 'extras', 'google', 'Android_Emulator_Hypervisor_Driver', 'silent_install.bat'),
      path.join(downloadsDir, 'aehd', 'silent_install.bat'),
    ];
    for (const candidate of candidates) {
      if (await fileExists(candidate)) return candidate;
    }
    // 优先通过 sdkmanager 的 extras 包获取（体积很小）。
    const sdkmanager = sdkmanagerPath();
    if (sdkmanager) {
      try {
        log('info', '通过 sdkmanager 获取 AEHD 驱动包（extras;google;Android_Emulator_Hypervisor_Driver）…');
        const result = await runCommand(
          sdkmanager,
          ['--sdk_root=' + sdkRoot, 'extras;google;Android_Emulator_Hypervisor_Driver'],
          {
            timeout: 300000,
            env: toolEnv(),
            feedInput: { text: 'y\n', intervalMs: 1000, maxTimes: 30 },
          },
        );
        if (result.code === 0 && (await fileExists(candidates[0]))) return candidates[0];
        log('warn', `sdkmanager 安装 AEHD 包未成功（exit ${result.code}），尝试直接下载`);
      } catch (e) {
        log('warn', `sdkmanager 安装 AEHD 包失败：${formatError(e)}，尝试直接下载`);
      }
    }
    // 回退：直接下载 AEHD zip。
    try {
      const zipPath = path.join(downloadsDir, 'aehd-windows_v2.2.zip');
      const extractDir = path.join(downloadsDir, 'aehd');
      await withArchive(
        {
          label: 'AEHD 驱动',
          url: AEHD_URL,
          zipPath,
          localOverride: archiveOverrides.aehd,
          minBytes: MIN_BYTES.aehd,
          onProgress: () => {},
        },
        async () => {
          await fsp.rm(extractDir, { recursive: true, force: true });
          await fsp.mkdir(extractDir, { recursive: true });
          await expandArchive(zipPath, extractDir, '解压 AEHD');
        },
      );
      const silent = await findFileUnder(extractDir, 'silent_install.bat', 3);
      if (silent) return silent;
    } catch (e) {
      log('warn', `下载 AEHD 安装包失败：${formatError(e)}`);
    }
    return null;
  }

  async function installAccelInternal(accelOpts = {}) {
    if (accelState.usable) {
      return {
        ok: true,
        detail: `硬件加速已可用（${accelState.mode}），无需安装`,
        needsElevation: false,
        uacLaunched: false,
      };
    }
    const elevated = await isProcessElevated();
    const installer = await findAehdInstaller();
    if (!installer) {
      return {
        ok: false,
        detail:
          '未能获取 AEHD 安装包（可从 Android SDK Manager 安装 extras;google;Android_Emulator_Hypervisor_Driver，或手动下载 aehd-windows_v2.2.zip 放到 dataDir/downloads）。也可启用 WHPX 作为替代。',
        needsElevation: !elevated,
        uacLaunched: false,
      };
    }
    if (accelOpts && accelOpts.dryRun) {
      return {
        ok: false,
        detail: `（dryRun）已定位 AEHD 安装器：${installer}，未触发 UAC`,
        needsElevation: !elevated,
        uacLaunched: false,
        installer,
      };
    }
    if (elevated) {
      log('info', `当前进程已是管理员，直接安装 AEHD：${installer}`);
      try {
        const result = await runCommand(installer, [], {
          cwd: path.dirname(installer),
          timeout: 180000,
          env: toolEnv(),
        });
        const accel = await checkAccelInternal();
        return {
          ok: accel.usable,
          detail: accel.usable
            ? 'AEHD 已安装并生效'
            : `AEHD 安装脚本已执行（exit ${result.code}），但加速仍不可用：${accel.detail}`,
          needsElevation: false,
          uacLaunched: false,
        };
      } catch (e) {
        return {
          ok: false,
          detail: `安装 AEHD 失败：${formatError(e)}`,
          needsElevation: false,
          uacLaunched: false,
        };
      }
    }
    let wrapper;
    try {
      wrapper = await writeElevationWrapper(installer);
    } catch (e) {
      return {
        ok: false,
        detail: `准备 UAC 提权脚本失败：${formatError(e)}`,
        needsElevation: true,
        uacLaunched: false,
      };
    }
    const script = `$ErrorActionPreference='Stop'; Start-Process -FilePath '${psQuote(wrapper)}' -WorkingDirectory '${psQuote(
      path.dirname(installer),
    )}' -Verb RunAs | Out-Null; 'UAC_LAUNCHED'`;
    try {
      const result = await runPowerShell(script, 120000);
      if (/UAC_LAUNCHED/.test(result.stdout || '')) {
        log('info', `已通过 UAC 提权请求安装 AEHD：${wrapper}`);
        return {
          ok: true,
          detail:
            '已弹出 UAC 提权窗口并请求安装 AEHD；请在弹窗中允许，安装完成后点「检测加速」查看结果。',
          needsElevation: true,
          uacLaunched: true,
        };
      }
      return {
        ok: false,
        detail: `UAC 提权未启动：${((result.stderr || result.stdout || '') + '').trim().slice(0, 400) || '未知原因'}`,
        needsElevation: true,
        uacLaunched: false,
      };
    } catch (e) {
      const message = formatError(e);
      const cancelled = /canceled by the user|用户取消|已取消/i.test(message);
      log('warn', `UAC 提权失败：${message}`);
      return {
        ok: false,
        detail: cancelled ? 'UAC 提权被取消，AEHD 未安装' : `UAC 提权失败：${message.slice(0, 400)}`,
        needsElevation: true,
        uacLaunched: false,
      };
    }
  }

  // ---- 设备 / 启动 / 停止 ----
  async function listDeviceSerials() {
    const adb = adbPath();
    if (!adb) return [];
    const result = await runCommand(adb, ['devices'], { timeout: 10000, env: toolEnv() });
    if (result.code !== 0) return [];
    return parseDeviceSerials(result.text);
  }

  async function waitForDeviceInternal(timeoutMs, child) {
    const timeout =
      Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : 240000;
    const deadline = Date.now() + timeout;
    let lastSerial = null;
    let lastDetail = '等待模拟器设备上线…';
    while (Date.now() < deadline) {
      if (child && child.exitCode !== null) {
        return {
          serial: lastSerial,
          booted: false,
          childExited: true,
          exitCode: child.exitCode,
          detail: `模拟器进程已退出（exit ${child.exitCode}），可能缺少硬件加速/AVD 配置异常或显卡驱动不兼容`,
        };
      }
      const adb = adbPath();
      if (!adb) {
        return {
          serial: null,
          booted: false,
          detail: '未找到 adb（platform-tools），无法等待模拟器上线',
        };
      }
      try {
        const serials = await listDeviceSerials();
        if (serials.length > 0) {
          const serial = lastSerial && serials.includes(lastSerial) ? lastSerial : serials[0];
          lastSerial = serial;
          const boot = await runCommand(adb, ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], {
            timeout: 10000,
            env: toolEnv(),
          });
          if ((boot.text || '').trim() === '1') {
            currentSerial = serial;
            return { serial, booted: true, detail: '设备已上线并完成启动' };
          }
          lastDetail = `设备 ${serial} 已上线，等待系统启动完成…`;
        } else {
          lastDetail = '等待模拟器设备上线…';
        }
      } catch (e) {
        lastDetail = `等待设备中：${formatError(e)}`;
      }
      await sleep(DEVICE_POLL_MS);
    }
    return {
      serial: lastSerial,
      booted: false,
      detail:
        (lastSerial ? `设备 ${lastSerial} 已上线但未在时限内完成启动` : lastDetail) +
        `（已等待 ${Math.round(timeout / 1000)}s，超时）`,
    };
  }

  function spawnProgram(exe, args, spawnOpts = {}) {
    const spec = commandSpec(exe, args);
    const child = spawn(spec.file, spec.args, {
      cwd: spawnOpts.cwd,
      env: spawnOpts.env ?? process.env,
      detached: spawnOpts.detached !== false,
      stdio: spawnOpts.stdio || 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
    });
    child.on('error', (e) => {
      lastError = `进程启动失败：${formatError(e)}`;
      log('error', lastError);
    });
    try {
      child.unref();
    } catch {
      /* ignore */
    }
    return child;
  }

  async function killChild(child) {
    if (!child) return;
    if (child.exitCode !== null) return;
    killTree(child.pid);
    await sleep(400);
  }

  async function doLaunch(avdName) {
    if (disposed) throw new Error('模拟器后端已释放，无法启动');
    const emulator = emulatorPath();
    if (!emulator) throw new Error('未找到 emulator.exe：请先点击「安装安卓模拟器」完成 Android SDK 安装');
    let targetAvd = normalizeAvdName(avdName) || currentAvd || '';
    if (!targetAvd) {
      const list = await listAvds();
      targetAvd = list.length > 0 ? list[0].name : AVD_DEFAULT;
    }
    // DSH 重启/插件重载后若已有模拟器在跑，直接接管，绝不再冷启动一次。
    try {
      const serials = await listDeviceSerials();
      const running = (serials || []).find((item) => String(item).startsWith('emulator-'));
      if (running) {
        currentSerial = running;
        currentAvd = currentAvd || targetAvd;
        log('info', `检测到已在运行的模拟器 ${running}，直接接管（无需重启）`);
        return {
          pid: emulatorChild && emulatorChild.pid ? emulatorChild.pid : null,
          avd: currentAvd,
          serial: running,
          already: true,
        };
      }
    } catch {
      /* ignore */
    }

    // 每次启动前把 AVD 配置调到 4GB / 6 核 / quickboot（老 AVD 也一起升级）。
    try {
      const avdPath = await pickAvdPath(targetAvd);
      if (avdPath) await patchAvdConfig(avdPath, targetAvd);
    } catch (error) {
      log('warn', `AVD 配置调优失败（继续启动）：${formatError(error)}`);
    }

    // 稳定优先：清理可能残留的 quickboot 快照（本机 2GB/4GB 快照加载会让 qemu 崩），
    // 统一冷启动（-no-snapshot）。启动后进程常驻，插件重载/DSH 重启不会再重启模拟器。
    try {
      const avdPath = await pickAvdPath(targetAvd);
      if (avdPath) await fsp.rm(path.join(avdPath, 'snapshots'), { recursive: true, force: true });
    } catch {
      /* ignore */
    }

    const env = toolEnv();
    const attempt = async (gpu) => {
      const args = [
        '-avd',
        targetAvd,
        '-no-snapshot',
        // 无窗口：避免 Qt/OpenGL 崩溃（带窗口时 -gpu host 会 graphics driver crash），
        // 画面统一走 adb screenrecord 在插件里看。
        '-no-window',
        '-no-audio',
        '-no-boot-anim',
        '-gpu',
        gpu,
        '-cores',
        String(EMULATOR_CORES),
        '-memory',
        String(EMULATOR_MEMORY_MB),
      ];
      log('info', `启动模拟器：emulator ${args.join(' ')}`.slice(0, 360));
      const child = spawnProgram(emulator, args, { detached: true, env, cwd: path.dirname(emulator) });
      emulatorChild = child;
      const result = await waitForDeviceInternal(240000, child);
      if (!result.booted) {
        await killChild(child);
        if (emulatorChild === child) emulatorChild = null;
        const error = new Error(result.detail || '启动模拟器超时');
        error.wait = result;
        throw error;
      }
      currentSerial = result.serial;
      currentAvd = targetAvd;
      lastError = null;
      log('info', `模拟器已启动：AVD=${targetAvd} serial=${result.serial}`);
      return { pid: child.pid ?? null, avd: targetAvd, serial: result.serial };
    };
    // 1) GPU host（性能最好）；2) 失败则 swiftshader_indirect 兜底。
    try {
      return await attempt('host');
    } catch (e) {
      const wait = e && e.wait;
      if (wait && wait.childExited) {
        log('warn', `-gpu host 启动失败（exit ${wait.exitCode ?? '?'}），回退 swiftshader_indirect …`);
        try {
          return await attempt('swiftshader_indirect');
        } catch (e2) {
          lastError = `启动模拟器失败：${formatError(e2)}`;
          throw e2 instanceof Error ? e2 : new Error(lastError);
        }
      }
      lastError = `启动模拟器失败：${formatError(e)}`;
      throw e instanceof Error ? e : new Error(lastError);
    }
  }

  async function doStop() {
    const serial = currentSerial;
    let stopped = false;
    const adb = adbPath();
    const targets = new Set();
    if (serial) targets.add(serial);
    if (adb && targets.size === 0) {
      try {
        for (const item of await listDeviceSerials()) targets.add(item);
      } catch {
        /* ignore */
      }
    }
    if (adb) {
      for (const target of targets) {
        try {
          await runCommand(adb, ['-s', target, 'emu', 'kill'], { timeout: 15000, env: toolEnv() });
          stopped = true;
          log('info', `已发送模拟器关闭指令：${target}`);
        } catch (e) {
          log('warn', `adb -s ${target} emu kill 失败：${formatError(e)}`);
        }
      }
    }
    if (emulatorChild) {
      const child = emulatorChild;
      const alive = child.exitCode === null;
      emulatorChild = null;
      if (alive) stopped = true;
      // 先等模拟器自己优雅退出（quickboot 快照要在这段时间里落盘），超时再强杀。
      const waitDeadline = Date.now() + 45000;
      while (child.exitCode === null && Date.now() < waitDeadline) await sleep(500);
      if (child.exitCode === null) await killChild(child);
    }
    // 等这些设备真正从 adb 消失再返回（插件重载后 currentSerial 可能为空，但 targets 仍有）。
    if (adb && targets.size > 0) {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        try {
          const serials = await listDeviceSerials();
          const stillOnline = [...targets].some((item) => serials.includes(item));
          if (!stillOnline) break;
        } catch {
          break;
        }
        await sleep(400);
      }
    } else if (serial && adb) {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        try {
          const serials = await listDeviceSerials();
          if (!serials.includes(serial)) break;
        } catch {
          break;
        }
        await sleep(500);
      }
    }
    currentSerial = null;
    currentAvd = null;
    log('info', stopped ? '模拟器已停止' : '当前没有正在运行的模拟器');
    return { stopped };
  }

  // ---- SDK 就绪 / 状态 ----
  async function isSdkReady() {
    if (!sdkmanagerPath() || !emulatorPath()) return false;
    for (const def of PACKAGE_DEFS) {
      if (!(await packagePresent(def))) return false;
    }
    return true;
  }

  function maybeResolveJavaVersion(java) {
    if (!java || javaVersion || javaVersionChecking) return;
    if (javaVersionAttemptedPath === java.path) return;
    javaVersionAttemptedPath = java.path;
    javaVersionChecking = javaVersionOf(java.path)
      .then((version) => {
        if (version) {
          javaVersion = version;
          javaPath = java.path;
          javaHome = java.home;
        }
      })
      .catch(() => {})
      .finally(() => {
        javaVersionChecking = null;
      });
  }

  async function status() {
    const java = resolveJavaSync();
    if (java) {
      javaPath = java.path;
      if (!javaHome) javaHome = java.home;
      maybeResolveJavaVersion(java);
    } else {
      javaPath = null;
    }
    const avds = await listAvds().catch(() => []);
    const sdkReady = await isSdkReady().catch(() => false);
    return {
      sdkRoot,
      dataDir,
      javaPath,
      javaVersion: javaVersion || null,
      cmdlineTools: sdkmanagerPath(),
      sdkReady,
      emulatorPath: emulatorPath(),
      avds,
      avdRunning: !!currentSerial,
      avd: currentAvd,
      serial: currentSerial,
      accel: { ...accelState },
      installing,
      installingStep,
      progress: { ...progressState },
      lastError,
    };
  }

  // ---- 一键安装 ----
  async function doInstall(installOpts = {}) {
    if (disposed) throw new Error('模拟器后端已释放，无法安装');
    installing = true;
    lastError = null;
    installingStep = null;
    progressState.step = null;
    progressState.index = 0;
    progressState.total = TOTAL_STEPS;
    progressState.detail = '准备安装…';
    progressState.percent = 0;
    emitProgress();
    try {
      log('info', `开始安装安卓模拟器：dataDir=${dataDir}（${IS_ARM64 ? 'arm64' : 'x64'} 主机）`);
      beginStep('java', '准备便携 Java 运行环境');
      const javaInfo = await ensureJava();
      beginStep('cmdline-tools', '安装 Android cmdline-tools');
      await ensureCmdlineTools();
      beginStep('licenses', '接受 Android SDK 许可证');
      await acceptLicenses();
      beginStep('sdk', '安装 Android SDK 组件（约 1.8GB）');
      await ensurePackages();
      beginStep('avd', '创建并调优 AVD');
      await createAvdInternal(installOpts.avdName || settings.avdName || AVD_DEFAULT);
      beginStep('accel', '检测硬件加速');
      const accel = await checkAccelInternal();
      completeStep(accel.usable ? '安装完成，硬件加速可用' : '安装完成（硬件加速不可用，可后续安装）');
      const avds = await listAvds(true);
      log('info', '安卓模拟器一键安装完成');
      return {
        ok: true,
        sdkRoot,
        javaPath,
        javaVersion,
        javaSource: javaInfo && javaInfo.source ? javaInfo.source : null,
        cmdlineTools: sdkmanagerPath(),
        emulatorPath: emulatorPath(),
        avds,
        accel,
      };
    } catch (e) {
      const message = formatError(e);
      lastError = message;
      failProgress(`安装失败：${message}`);
      log('error', `安卓模拟器安装失败：${message}`);
      throw e instanceof Error ? e : new Error(message);
    } finally {
      installing = false;
      installingStep = null;
    }
  }

  function install(installOpts = {}) {
    if (installPromise) return installPromise;
    installPromise = doInstall(installOpts).finally(() => {
      installPromise = null;
    });
    return installPromise;
  }

  function launch(avdName) {
    if (launchPromise) return launchPromise;
    launchPromise = doLaunch(avdName).finally(() => {
      launchPromise = null;
    });
    return launchPromise;
  }

  async function waitForDevice(timeoutMs = 240000) {
    const result = await waitForDeviceInternal(timeoutMs, emulatorChild);
    if (result.booted && result.serial) currentSerial = result.serial;
    return result;
  }

  /**
   * 插件卸载/DSH 重启时默认**保留模拟器继续运行**：
   * 下次打开插件直接接管（秒开），避免每次冷启动；要关闭请用面板「停止模拟器」。
   * 进程是 detached 的，父进程退出也不会带走它。
   */
  async function dispose() {
    disposed = true;
    if (emulatorChild) {
      log('info', '插件卸载：保留模拟器进程继续运行（下次直接接管；可在面板「停止模拟器」关闭）');
    }
    // 注意：不调用 doStop()，也不 kill；只放弃子进程句柄。
    emulatorChild = null;
    avdsCache = null;
    avdsCacheAt = 0;
  }

  // ---- 契约返回对象 ----
  return {
    status,
    install,
    installAccel: installAccelInternal,
    checkAccel: checkAccelInternal,
    listAvds,
    createAvd: createAvdInternal,
    launch,
    stop: doStop,
    waitForDevice,
    deviceSerial: () => currentSerial,
    adbPath,
    dispose,
  };
}
