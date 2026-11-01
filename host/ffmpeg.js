/**
 * dsh-live-preview — Host ffmpeg 定位 / 自动安装 / 版本探测。
 *
 * 契约见 ../CONTRACT-EMULATOR.md「host/ffmpeg.js」：
 *   resolveFfmpeg(dataDir)             → string|null（dataDir/ffmpeg/ffmpeg.exe → PATH）
 *   installFfmpeg(dataDir, onProgress) → { path, version, binDir, source }
 *   ffmpegVersion(path)                → string|null（ffmpeg -version 第一行）
 *
 * 下载源策略（国内部署实测后确定）：
 *   1. npmmirror 的 @ffmpeg-installer/win32-x64 tarball（约 22MB，含 libx264）
 *   2. BtbN FFmpeg-Builds GitHub 构建（zip）
 *   3. gyan.dev essentials（zip，原始兜底）
 * 按顺序尝试；连接后 8 秒内平均速度 < 80KB/s 判定「源太慢」，立即中断切下一个源；
 * 超过 20 秒没有新数据也中断切换。进度回调带 source 字段，便于面板展示。
 *
 * 其它约束：无第三方依赖；zip 用 PowerShell Expand-Archive（缺失回落 pwsh），
 * tgz 用 Windows 自带 tar；所有命令都有超时，失败抛带原因的错误，绝不挂死宿主。
 */
import { spawn } from 'node:child_process';
import { existsSync, promises as fsp } from 'node:fs';
import { curlDownload } from './netutil.js';
import os from 'node:os';
import path from 'node:path';

const LOW_SPEED_BYTES_PER_SEC = 80 * 1024;
const LOW_SPEED_GRACE_MS = 8000;
const DOWNLOAD_IDLE_TIMEOUT_MS = 20 * 1000;
const DOWNLOAD_TOTAL_TIMEOUT_MS = 30 * 60 * 1000;
const EXTRACT_TIMEOUT_MS = 10 * 60 * 1000;
const EXEC_TIMEOUT_MS = 20 * 1000;
const PROGRESS_THROTTLE_MS = 150;

const IS_WIN = process.platform === 'win32';
const FFMPEG_NAME = IS_WIN ? 'ffmpeg.exe' : 'ffmpeg';

/** 默认下载源（按优先级排序）。 */
const DEFAULT_SOURCES = [
  {
    id: 'npmmirror',
    label: 'npmmirror 镜像（约 22MB，含 libx264）',
    url: 'https://registry.npmmirror.com/@ffmpeg-installer/win32-x64/-/win32-x64-4.1.0.tgz',
    kind: 'tgz',
    cacheName: 'ffmpeg-win32-x64-4.1.0.tgz',
    minBytes: 15 * 1024 * 1024,
  },
  {
    id: 'btbn',
    label: 'BtbN GitHub 构建',
    url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl-shared.zip',
    kind: 'zip',
    cacheName: 'ffmpeg-btbn-latest-win64-gpl-shared.zip',
    minBytes: 40 * 1024 * 1024,
  },
  {
    id: 'gyan',
    label: 'gyan.dev essentials',
    url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
    kind: 'zip',
    cacheName: 'ffmpeg-gyan-release-essentials.zip',
    minBytes: 100 * 1024 * 1024,
  },
];

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

function resolveDataDir(dataDir) {
  const raw = dataDir == null ? '' : String(dataDir).trim();
  if (raw) return path.resolve(raw);
  return path.join(process.env.LOCALAPPDATA || os.homedir(), 'dsh-live-preview');
}

function emit(onProgress, payload) {
  if (typeof onProgress !== 'function') return;
  try {
    onProgress(payload);
  } catch {
    /* 进度回调异常不影响安装 */
  }
}

async function fileExists(target) {
  try {
    return (await fsp.stat(target)).isFile();
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error) {
  if (!error) return '未知错误';
  if (typeof error === 'string') return error;
  if (error.message) return String(error.message);
  return String(error);
}

/** PATH 中查找可执行文件（同步、无副作用）。 */
function findOnPath(name) {
  const seen = new Set();
  const pathValue = process.env.PATH || process.env.Path || '';
  for (const dir of String(pathValue).split(path.delimiter)) {
    if (!dir) continue;
    let normalized;
    try {
      normalized = path.resolve(dir);
    } catch {
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const candidate = path.join(normalized, name);
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** 执行外部命令并宽容地收集输出（不因非 0 退出码抛错）。 */
function runCapture(exe, args, timeout = EXEC_TIMEOUT_MS) {
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

function psQuote(value) {
  return String(value).replace(/'/g, "''");
}

/** 运行一段 PowerShell 脚本（powershell.exe 不可用时回落到 pwsh）。 */
async function runPowerShell(script, timeout) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];
  const first = await runCapture('powershell.exe', args, timeout);
  if (!first.error && first.code === 0) return first;
  const second = await runCapture('pwsh', args, timeout);
  if (!second.error && second.code === 0) return second;
  const firstDetail = first.error
    ? String(first.error.message || first.error)
    : (first.stderr || first.stdout || '').trim();
  const secondDetail = second.error
    ? String(second.error.message || second.error)
    : (second.stderr || second.stdout || '').trim();
  const detail = (firstDetail || secondDetail || '未知错误').slice(0, 500);
  throw new Error(`PowerShell 执行失败：${detail}`);
}

/** Expand-Archive -Force 到目标目录。 */
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
    const result = await runCapture(
      'tar',
      ['-xzf', archivePath, '-C', destination],
      EXTRACT_TIMEOUT_MS,
    );
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
 * 下载到 dest（先写 .part 再改名），回调 onProgress(received,total)。
 * 低速策略：连接后 8s 平均 < 80KB/s 或 20s 无新数据 → 中断并抛 SOURCE_SLOW/SOURCE_TIMEOUT。
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
    // 首字节 + 足够样本后才判断低速，避免 TLS/DNS 握手慢被误判为源太慢。
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
      headers: { 'user-agent': 'dsh-live-preview/0.1 (+ffmpeg)' },
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
    if (abortKind) throw buildAbortError(label, abortKind, received, startedAt);
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
    if (abortKind) throw buildAbortError(label, abortKind, received, startedAt);
    // Node fetch 连接超时时退回系统 curl（带系统代理）。
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

/** 广度优先递归查找文件名（大小写不敏感），返回首个绝对路径或 null。 */
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

/** 取版的短版本号：优先 "ffmpeg version 7.1.1-xxx"，否则回退第一行。 */
function shortVersion(firstLine) {
  const line = String(firstLine || '').trim();
  if (!line) return null;
  const match = /^ffmpeg version (\S+)/i.exec(line);
  return match ? match[1] : line;
}

// ---------------------------------------------------------------------------
// 契约接口
// ---------------------------------------------------------------------------

/**
 * 定位 ffmpeg：dataDir/ffmpeg/ffmpeg.exe → PATH。
 * @param {string} [dataDir]
 * @returns {Promise<string|null>}
 */
export async function resolveFfmpeg(dataDir) {
  const raw = dataDir == null ? '' : String(dataDir).trim();
  if (raw) {
    const root = path.resolve(raw);
    const local = path.join(root, 'ffmpeg', FFMPEG_NAME);
    if (await fileExists(local)) return local;
  }
  return findOnPath(FFMPEG_NAME);
}

/**
 * 执行 ffmpeg -version，返回第一行；不可执行/无输出时返回 null。
 * @param {string} ffmpegPath
 * @returns {Promise<string|null>}
 */
export async function ffmpegVersion(ffmpegPath) {
  const target = ffmpegPath == null ? '' : String(ffmpegPath).trim();
  if (!target || !existsSync(target)) return null;
  const result = await runCapture(target, ['-version'], EXEC_TIMEOUT_MS);
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  const first = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return first || null;
}

/**
 * 自动安装 ffmpeg：按镜像优先级下载 → 解压 → 把 ffmpeg.exe 所在目录
 * 复制到 dataDir/ffmpeg → 校验 ffmpeg -version。
 *
 * @param {string} dataDir 插件数据目录
 * @param {(p: { phase:'download'|'extract'|'verify', source?:string, received?:number, total?:number, percent?:number|null, text?:string }) => void} [onProgress]
 * @param {{ sources?: Array<{id:string,label:string,url:string,kind:'tgz'|'zip',cacheName:string,minBytes?:number}> }} [options]
 *        可选：测试/企业镜像注入下载源列表（服务层不传即用默认镜像）。
 * @returns {Promise<{ path:string, version:string, binDir:string, source:string }>}
 */
export async function installFfmpeg(dataDir, onProgress, options = {}) {
  if (!IS_WIN) {
    throw new Error('自动安装 ffmpeg 目前仅支持 Windows（请手动把 ffmpeg.exe 放进 dataDir/ffmpeg）');
  }
  const root = resolveDataDir(dataDir);
  const targetDir = path.join(root, 'ffmpeg');
  const targetExe = path.join(targetDir, FFMPEG_NAME);
  const sources =
    Array.isArray(options.sources) && options.sources.length > 0 ? options.sources : DEFAULT_SOURCES;

  // 已装好的直接复用（幂等）。
  if (await fileExists(targetExe)) {
    const firstLine = await ffmpegVersion(targetExe);
    if (firstLine) {
      emit(onProgress, {
        phase: 'verify',
        source: 'existing',
        received: 0,
        total: 0,
        percent: 100,
        text: 'ffmpeg 已存在，跳过安装',
      });
      return {
        path: targetExe,
        version: shortVersion(firstLine),
        binDir: targetDir,
        source: 'existing',
      };
    }
    // 文件在但跑不起来：继续走重装流程。
  }

  await fsp.mkdir(path.join(root, 'downloads'), { recursive: true });
  const failures = [];
  for (const source of sources) {
    try {
      return await installFromSource(source, { root, targetDir, targetExe, onProgress });
    } catch (e) {
      const reason = formatError(e);
      failures.push(`${source.id || source.url}: ${reason}`);
      emit(onProgress, {
        phase: 'download',
        source: source.id || 'unknown',
        received: 0,
        total: 0,
        percent: null,
        text: `${source.label || source.id || '下载源'} 不可用，切换镜像：${reason.slice(0, 160)}`,
      });
    }
  }
  throw new Error(`ffmpeg 所有下载源均失败：\n${failures.join('\n')}`);
}

/** 从单个下载源安装 ffmpeg。 */
async function installFromSource(source, ctx) {
  const { root, targetDir, targetExe, onProgress } = ctx;
  const zipPath = path.join(root, 'downloads', source.cacheName || `ffmpeg-${source.id}.download`);
  const extractDir = path.join(root, 'downloads', 'ffmpeg-extract');
  const sourceId = source.id || 'custom';
  const label = source.label || sourceId;

  let lastPercent = -1;
  let lastEmittedAt = 0;
  const reportDownload = (received, total) => {
    const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null;
    const now = Date.now();
    if (percent === lastPercent && now - lastEmittedAt < PROGRESS_THROTTLE_MS) return;
    lastPercent = percent;
    lastEmittedAt = now;
    const mb = (received / 1024 / 1024).toFixed(1);
    const totalMb = total > 0 ? (total / 1024 / 1024).toFixed(1) : '?';
    emit(onProgress, {
      phase: 'download',
      source: sourceId,
      received,
      total,
      percent,
      text: `正在从 ${label} 下载 ffmpeg ${mb}MB / ${totalMb}MB`,
    });
  };

  const download = async () => {
    emit(onProgress, {
      phase: 'download',
      source: sourceId,
      received: 0,
      total: 0,
      percent: 0,
      text: `连接 ${label} 下载 ffmpeg…`,
    });
    await downloadToFile(source.url, zipPath, {
      label: `下载 ffmpeg（${label}）`,
      minBytes: source.minBytes || 0,
      onProgress: reportDownload,
    });
  };

  const cachedStat = await statOrNull(zipPath);
  const hasCached = !!(
    cachedStat &&
    cachedStat.isFile() &&
    cachedStat.size >= (source.minBytes || 0)
  );
  if (hasCached) {
    emit(onProgress, {
      phase: 'download',
      source: sourceId,
      received: cachedStat.size,
      total: cachedStat.size,
      percent: 100,
      text: `复用已下载的 ffmpeg 压缩包（${label}）`,
    });
  } else {
    await download();
  }

  const runExtract = async () => {
    emit(onProgress, {
      phase: 'extract',
      source: sourceId,
      received: 0,
      total: 0,
      percent: 0,
      text: `正在解压 ffmpeg（${label}）…`,
    });
    await fsp.rm(extractDir, { recursive: true, force: true });
    await fsp.mkdir(extractDir, { recursive: true });
    await extractArchive(source.kind, zipPath, extractDir, '解压 ffmpeg');

    const found = await findFileUnder(extractDir, FFMPEG_NAME, 8);
    if (!found) {
      throw new Error(`解压完成但未找到 ${FFMPEG_NAME}（来源 ${label}）`);
    }
    const sourceBin = path.dirname(found);
    // 把 ffmpeg.exe 所在目录（zip 的 bin/ 或 tarball 的 package/）复制到 dataDir/ffmpeg。
    await fsp.rm(targetDir, { recursive: true, force: true });
    await fsp.mkdir(path.dirname(targetDir), { recursive: true });
    try {
      await fsp.cp(sourceBin, targetDir, { recursive: true, force: true });
    } catch (e) {
      throw new Error(`复制 ffmpeg 到 ${targetDir} 失败：${formatError(e)}`);
    }
    if (!(await fileExists(targetExe))) {
      throw new Error(`复制完成但未找到 ${targetExe}`);
    }
    emit(onProgress, {
      phase: 'verify',
      source: sourceId,
      received: 0,
      total: 0,
      percent: 60,
      text: `校验 ffmpeg 可执行性（${label}）…`,
    });
    const firstLine = await ffmpegVersion(targetExe);
    if (!firstLine) {
      throw new Error(
        `ffmpeg.exe 已解压到 ${targetExe}，但无法执行（-version 无输出，来源 ${label}）`,
      );
    }
    await fsp.rm(extractDir, { recursive: true, force: true }).catch(() => {});
    const version = shortVersion(firstLine);
    emit(onProgress, {
      phase: 'verify',
      source: sourceId,
      received: 0,
      total: 0,
      percent: 100,
      text: `ffmpeg ${version} 安装完成（来源 ${label}）`,
    });
    return { path: targetExe, version, binDir: targetDir, source: sourceId };
  };

  try {
    return await runExtract();
  } catch (e) {
    if (!hasCached) throw e;
    // 缓存压缩包可能损坏：删掉重下一次。
    emit(onProgress, {
      phase: 'download',
      source: sourceId,
      received: 0,
      total: 0,
      percent: 0,
      text: `缓存压缩包不可用，重新下载 ffmpeg（${label}）…`,
    });
    await fsp.rm(zipPath, { force: true }).catch(() => {});
    await sleep(300);
    await download();
    return runExtract();
  }
}
