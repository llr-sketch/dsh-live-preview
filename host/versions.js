/**
 * dsh-live-preview / host/versions.js
 *
 * 应用版本仓库（宿主侧）：同一应用每次导入 / 交付新版本都记一条记录，原始文件长期保留在
 * 插件数据目录里，供「历史版本」面板读取、标记收藏、删除、记录运行中状态。
 * 编排（state / logs / HTTP action）由 service.js 负责，本模块只做存储，不依赖第三方库。
 *
 * 对外接口（ESM，全部方法 async，调用方一律 await）：
 *   createVersionStore({ dataDir, logger }) → store
 *     store.ready()                          加载索引（幂等；损坏索引自动备份并从空/可用记录继续）
 *     store.listVersions()                   → 版本数组（新→旧，按 createdAt 倒序）
 *     store.getVersion(id)                   → 版本 | null
 *     store.findByAppKey(appKey)             → 该应用全部版本（新→旧）
 *     store.addVersion({...})                → 版本（复制源文件到 dataDir/versions/<id>/）
 *     store.updateVersion(id, patch)         → 版本（浅合并；id / appKey 不可改）
 *     store.markVersion(id, marked)          → 版本
 *     store.setRunning(id, running)          → 版本（running: { pid, hwnd, title } | null）
 *     store.clearRunning(id)                 → 版本
 *     store.deleteVersion(id, { deleteFile = true }) → { ok, deletedFile, error? }
 *     store.flush()                          等待所有挂起写入落盘（测试 / 关闭用）
 *
 * 版本对象字段：
 *   { id, appKey, kind: 'android'|'windows'|'web', name, format, arch, packageName,
 *     filePath, size, createdAt, lastUsedAt, marked, running, meta }
 *
 * 持久化：
 *  - 索引 dataDir/versions.json = { "versions": [...] }。写入串行化（队列），先写同目录临时文件
 *    再 rename 覆盖，崩溃最多丢最后一次写入，不会产生半个 JSON。
 *  - 每个版本的原始文件放 dataDir/versions/<id>/<安全文件名>。addVersion 是「复制」不是移动，
 *    复制成功后调用方可以删除源文件，不影响版本文件。
 *  - 索引损坏（非 JSON / 结构非法 / 记录缺 id）时：备份为 versions.json.bad-<ts>，跳过坏记录，
 *    重写成干净索引，绝不让插件启动失败。
 *  - 删除版本只删 dataDir/versions/<id>/ 这一级目录，不动索引目录以外的任何文件。
 */

import { randomBytes } from 'node:crypto';
import { existsSync, promises as fsp } from 'node:fs';
import path from 'node:path';

/** 允许的应用类型。 */
const KINDS = new Set(['android', 'windows', 'web']);

/** Windows 上杀毒 / 索引器短暂占用导致的失败码，值得重试。 */
const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY']);

/** 文件系统操作最大尝试次数（含首次）。 */
const FS_ATTEMPTS = 4;

/** 版本目录内文件名长度上限（远离 Windows MAX_PATH 风险）。 */
const MAX_FILE_NAME = 120;

/** 生成唯一 id 的最大尝试次数。 */
const MAX_ID_TRIES = 8;

/** 禁止作为对象键写入的字段（防止 JSON patch 污染原型）。 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// ============================================================================
// 通用小工具
// ============================================================================

function errorMessage(error) {
  if (!error) return '未知错误';
  if (typeof error === 'string') return error;
  if (error.code && error.message) return `${error.code} ${error.message}`;
  if (error.message) return String(error.message);
  return String(error);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 可读的本地时间戳（yyyyMMddHHmmss），用于 id / 备份名。 */
function compactStamp(ms = Date.now()) {
  const date = new Date(ms);
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function randomHex(bytes) {
  return randomBytes(bytes).toString('hex');
}

function formatSize(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 100 ? Math.round(size) : size.toFixed(1)} ${units[index]}`;
}

/** 执行文件系统操作；遇到临时占用类错误退避重试，其它错误立刻抛。 */
async function withRetry(operation, label) {
  let lastError = null;
  for (let attempt = 1; attempt <= FS_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!RETRY_CODES.has(error && error.code) || attempt === FS_ATTEMPTS) break;
      await sleep(20 * 2 ** (attempt - 1)); // 20 → 40 → 80ms
    }
  }
  if (lastError && !lastError.message) {
    try {
      lastError.message = `${label} 失败`;
    } catch {
      /* ignore */
    }
  }
  throw lastError || new Error(`${label} 失败`);
}

/**
 * 把源文件名变成 Windows 安全、可读的文件名（保留扩展名）。
 * 去掉路径分隔符 / 控制字符 / 非法字符 / 结尾的点与空格，避开设备名。
 */
function safeFileName(sourcePath) {
  const raw = path.basename(String(sourcePath ?? ''));
  let name = raw
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/, '')
    .trim();
  if (!name || name === '.' || name === '..') name = 'app.bin';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name)) name = `_${name}`;
  if (name.length > MAX_FILE_NAME) {
    const ext = path.extname(name).slice(0, 16);
    const stem = name.slice(0, name.length - ext.length);
    name = `${stem.slice(0, Math.max(1, MAX_FILE_NAME - ext.length))}${ext}`;
  }
  return name;
}

/** meta 只保留可 JSON 序列化的普通对象（丢弃循环引用 / 数组 / 原始值）。 */
function sanitizeMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {};
  try {
    const parsed = JSON.parse(JSON.stringify(meta));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** running 只保留契约里的三个字段；空对象归一成 null。 */
function normalizeRunning(running) {
  if (!running || typeof running !== 'object' || Array.isArray(running)) return null;
  const positiveInt = (value) => {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? Math.trunc(num) : null;
  };
  const pid = positiveInt(running.pid);
  const hwnd = positiveInt(running.hwnd);
  const title = typeof running.title === 'string' && running.title ? running.title : null;
  if (pid === null && hwnd === null && title === null) return null;
  return { pid, hwnd, title };
}

function normalizeKind(kind) {
  const value = kind === null || kind === undefined ? '' : String(kind).trim().toLowerCase();
  if (!KINDS.has(value)) {
    throw new Error(`版本 kind 必须是 android|windows|web（收到 ${JSON.stringify(kind)}）`);
  }
  return value;
}

/** 对外返回副本：调用方改返回值不会污染仓库内存状态。 */
function cloneVersion(record) {
  return {
    ...record,
    running: record.running ? { ...record.running } : null,
    meta: { ...record.meta },
  };
}

/** 新→旧：createdAt 倒序，同一毫秒用 id 倒序稳定排序。 */
function sortVersions(list) {
  return list
    .slice()
    .sort((a, b) => {
      const delta = b.createdAt - a.createdAt;
      if (delta) return delta;
      if (a.id === b.id) return 0;
      return a.id < b.id ? 1 : -1;
    });
}

// ============================================================================
// 工厂
// ============================================================================

/**
 * 创建应用版本仓库。
 * @param {{ dataDir?: string, logger?: any }} [options]
 *   dataDir  插件数据目录（索引与版本文件都在这里，必须显式给出）
 *   logger   可选：function(level, message) | { info/warn/error/debug/log }
 */
export function createVersionStore(options = {}) {
  const rawDir = options && options.dataDir !== undefined && options.dataDir !== null ? String(options.dataDir).trim() : '';
  if (!rawDir) throw new Error('createVersionStore 缺少 dataDir（插件数据目录）');
  const dataDir = path.resolve(rawDir);
  const logger = options.logger ?? null;
  const indexPath = path.join(dataDir, 'versions.json');
  const versionsDir = path.join(dataDir, 'versions');

  /** @type {Array<object>} 内存中的版本记录（新→旧由查询时排序，内部保持写入顺序）。 */
  let versions = [];
  /** 索引加载 Promise（ready 幂等）。 */
  let readyPromise = null;
  /** 写入队列尾。 */
  let writeChain = Promise.resolve();
  /** 正在生成、还没落到 versions 数组里的 id，避免并发 add 撞 id。 */
  const reservedIds = new Set();

  // ---- 日志 ----
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
      /* 日志失败不影响存储 */
    }
  }

  // ==========================================================================
  // 索引读写
  // ==========================================================================

  /** 排队一次「整份索引落盘」，保证任意时刻只有一个写入者。 */
  function enqueueWrite() {
    const task = writeChain.then(() => writeIndexSnapshot());
    // 队列尾部吞掉错误，避免一次写失败导致后续写入全部短路（错误已抛给本次调用方）。
    writeChain = task.catch(() => {});
    return task;
  }

  /** 把当前内存状态原子写入 versions.json：临时文件 + rename。 */
  async function writeIndexSnapshot() {
    const ordered = sortVersions(versions).map((record) => cloneVersion(record));
    const payload = `${JSON.stringify({ versions: ordered }, null, 2)}\n`;
    await fsp.mkdir(dataDir, { recursive: true });
    const tmpPath = path.join(dataDir, `versions.json.tmp-${process.pid}-${randomHex(4)}`);
    try {
      await withRetry(() => fsp.writeFile(tmpPath, payload, 'utf8'), '写临时索引');
      await withRetry(() => fsp.rename(tmpPath, indexPath), '替换索引');
    } catch (error) {
      try {
        await fsp.rm(tmpPath, { force: true });
      } catch {
        /* 清理失败不影响错误上报 */
      }
      throw new Error(`写入版本索引失败（${indexPath}）：${errorMessage(error)}`);
    }
  }

  /** 损坏索引备份为 versions.json.bad-<ts>；失败只记日志。 */
  async function backupIndex(reason) {
    const target = `${indexPath}.bad-${Date.now()}`;
    try {
      await fsp.copyFile(indexPath, target);
      log('warn', `已备份损坏的版本索引到 ${target}（${reason}）`);
      return target;
    } catch (error) {
      log('warn', `备份损坏的版本索引失败（${reason}）：${errorMessage(error)}`);
      return null;
    }
  }

  /** 尽力把当前（可能已清理的）状态写回索引，失败不抛。 */
  async function persistQuiet() {
    try {
      await enqueueWrite();
    } catch (error) {
      log('warn', `重写版本索引失败（继续运行）：${errorMessage(error)}`);
    }
  }

  /** 索引彻底不可用：清空 + 备份 + 重写空索引。 */
  async function recoverFromCorruption(reason) {
    versions = [];
    log('warn', `版本索引损坏，已按空索引继续：${reason}`);
    await backupIndex(reason);
    await persistQuiet();
  }

  /**
   * 把一条索引记录归一化；返回 null 表示这条记录坏到无法使用（缺 id / 不是对象）。
   * 其余字段缺省或类型不对时用安全默认值修复，尽量保住用户数据。
   */
  function normalizeRecord(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!id) return null;
    const asString = (value) => (typeof value === 'string' ? value : null);
    const asNumber = (value, fallback) => {
      if (value === null || value === undefined || value === '') return fallback;
      const num = Number(value);
      return Number.isFinite(num) ? num : fallback;
    };
    const fallbackName = typeof raw.filePath === 'string' && path.basename(raw.filePath) ? path.basename(raw.filePath) : '未命名版本';
    return {
      id,
      appKey: typeof raw.appKey === 'string' ? raw.appKey : '',
      kind: typeof raw.kind === 'string' && raw.kind ? raw.kind.toLowerCase() : null,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : fallbackName,
      format: asString(raw.format),
      arch: asString(raw.arch),
      packageName: asString(raw.packageName),
      filePath: asString(raw.filePath),
      size: Math.max(0, asNumber(raw.size, 0)),
      createdAt: asNumber(raw.createdAt, 0),
      lastUsedAt: raw.lastUsedAt === null || raw.lastUsedAt === undefined ? null : asNumber(raw.lastUsedAt, null),
      marked: Boolean(raw.marked),
      running: normalizeRunning(raw.running),
      meta: sanitizeMeta(raw.meta),
    };
  }

  /** 加载索引：不存在 → 空；损坏 → 备份 + 跳过坏记录 + 重写干净索引。永不抛。 */
  async function loadIndex() {
    await fsp.mkdir(versionsDir, { recursive: true });

    let text = null;
    try {
      text = await fsp.readFile(indexPath, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        log('info', `版本索引不存在，从空开始（${indexPath}）`);
        return;
      }
      log('warn', `读取版本索引失败，按空索引继续：${errorMessage(error)}`);
      return;
    }

    if (!String(text).trim()) {
      await recoverFromCorruption('索引文件为空（0 字节）');
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      await recoverFromCorruption(`索引不是合法 JSON：${errorMessage(error)}`);
      return;
    }

    let rawList = null;
    if (Array.isArray(parsed)) {
      // 非契约格式，但可以无损读入：当成版本列表。
      log('warn', '版本索引是顶层数组（旧格式），已按版本列表读取');
      rawList = parsed;
    } else if (parsed && typeof parsed === 'object') {
      if (Array.isArray(parsed.versions)) {
        rawList = parsed.versions;
      } else if (parsed.versions === undefined) {
        log('warn', '版本索引缺少 versions 数组，按空索引继续');
        return;
      }
    }
    if (rawList === null) {
      await recoverFromCorruption('索引结构非法（versions 不是数组）');
      return;
    }

    const seen = new Set();
    const good = [];
    let skipped = 0;
    for (const raw of rawList) {
      const record = normalizeRecord(raw);
      if (!record || seen.has(record.id)) {
        skipped += 1;
        continue;
      }
      seen.add(record.id);
      good.push(record);
    }
    versions = good;

    if (skipped > 0) {
      log('warn', `版本索引中有 ${skipped} 条记录不合法，已跳过（保留 ${good.length} 条）`);
      await backupIndex(`存在 ${skipped} 条不合法记录`);
      await persistQuiet();
      return;
    }
    log('info', `版本索引已加载：${good.length} 条（${indexPath}）`);
  }

  /** 幂等加载；加载异常也吞掉（按空索引继续），保证插件能启动。 */
  function ensureReady() {
    if (!readyPromise) {
      readyPromise = loadIndex().catch((error) => {
        versions = [];
        log('warn', `版本索引加载异常，按空索引继续：${errorMessage(error)}`);
      });
    }
    return readyPromise;
  }

  // ==========================================================================
  // 查询
  // ==========================================================================

  async function ready() {
    await ensureReady();
  }

  async function listVersions() {
    await ensureReady();
    return sortVersions(versions).map(cloneVersion);
  }

  async function getVersion(id) {
    await ensureReady();
    const key = id === null || id === undefined ? '' : String(id).trim();
    if (!key) return null;
    const found = versions.find((record) => record.id === key);
    return found ? cloneVersion(found) : null;
  }

  async function findByAppKey(appKey) {
    await ensureReady();
    const key = appKey === null || appKey === undefined ? '' : String(appKey);
    if (!key) return [];
    return sortVersions(versions.filter((record) => record.appKey === key)).map(cloneVersion);
  }

  // ==========================================================================
  // 写入
  // ==========================================================================

  /** 生成唯一 id：<Date.now()>-<yyyyMMddHHmmss>-<4 位 hex>。 */
  function reserveId() {
    for (let attempt = 0; attempt < MAX_ID_TRIES; attempt += 1) {
      const now = Date.now();
      const id = `${now}-${compactStamp(now)}-${randomHex(2)}`;
      if (reservedIds.has(id)) continue;
      if (versions.some((record) => record.id === id)) continue;
      if (existsSync(path.join(versionsDir, id))) continue;
      reservedIds.add(id);
      return id;
    }
    // 极端兜底：加长随机段，几乎不可能走到。
    const fallback = `${Date.now()}-${compactStamp()}-${randomHex(4)}`;
    reservedIds.add(fallback);
    return fallback;
  }

  /** stat 源文件；不存在 / 不是普通文件时抛带原因的 Error。 */
  async function statSource(sourcePath) {
    if (sourcePath === null || sourcePath === undefined || !String(sourcePath).trim()) {
      throw new Error('addVersion 缺少 sourcePath（要入库的源文件路径）');
    }
    const src = path.resolve(String(sourcePath).trim());
    let stat = null;
    try {
      stat = await fsp.stat(src);
    } catch (error) {
      throw new Error(`无法读取源文件（${src}）：${errorMessage(error)}`);
    }
    if (!stat.isFile()) throw new Error(`源路径不是普通文件（可能是目录）：${src}`);
    return { src, size: stat.size };
  }

  /**
   * 新增一个版本：复制源文件到 dataDir/versions/<id>/，记录索引。
   * 复制成功后才写索引；写索引失败会回滚内存记录并删掉刚建的目录，不留半成品。
   */
  async function addVersion(input = {}) {
    await ensureReady();
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('addVersion 需要一个参数对象');
    }
    const appKey = input.appKey === null || input.appKey === undefined ? '' : String(input.appKey).trim();
    if (!appKey) throw new Error('addVersion 缺少 appKey（同一应用的稳定标识）');
    const kind = normalizeKind(input.kind);
    const { src, size: sourceSize } = await statSource(input.sourcePath);

    const id = reserveId();
    const dir = path.join(versionsDir, id);
    let pushed = false;
    try {
      await fsp.mkdir(dir, { recursive: true });
      const fileName = safeFileName(src);
      const dest = path.join(dir, fileName);
      await withRetry(() => fsp.copyFile(src, dest), `复制版本文件 ${fileName}`);
      const copied = await fsp.stat(dest);
      if (copied.size !== sourceSize) {
        log('warn', `复制后大小与源文件不一致（源 ${sourceSize} / 目标 ${copied.size}）：${dest}`);
      }

      const now = Date.now();
      const trimmedName = input.name === null || input.name === undefined ? '' : String(input.name).trim();
      const format =
        input.format !== null && input.format !== undefined && String(input.format).trim()
          ? String(input.format).trim().toLowerCase().replace(/^\./, '')
          : path.extname(src).slice(1).toLowerCase() || null;
      const record = {
        id,
        appKey,
        kind,
        name: trimmedName || path.basename(src) || '未命名版本',
        format,
        arch: input.arch !== null && input.arch !== undefined && String(input.arch).trim() ? String(input.arch).trim() : null,
        packageName:
          input.packageName !== null && input.packageName !== undefined && String(input.packageName).trim()
            ? String(input.packageName).trim()
            : null,
        filePath: dest,
        size: copied.size,
        createdAt: now,
        lastUsedAt: now,
        marked: Boolean(input.marked),
        running: null,
        meta: sanitizeMeta(input.meta),
      };

      versions.push(record);
      pushed = true;
      await enqueueWrite();
      log('info', `应用版本已入库：${id}（${record.kind} / ${record.name} / ${formatSize(record.size)}）`);
      return cloneVersion(record);
    } catch (error) {
      if (pushed) {
        const at = versions.findIndex((record) => record.id === id);
        if (at >= 0) versions.splice(at, 1);
        await persistQuiet();
      }
      try {
        await fsp.rm(dir, { recursive: true, force: true });
      } catch {
        /* 清理失败不掩盖原始错误 */
      }
      throw error;
    } finally {
      reservedIds.delete(id);
    }
  }

  /** 把 patch 应用到记录的副本上（id / appKey 不可改；不认识的字段浅合并进记录）。 */
  function applyPatch(record, patch) {
    const next = cloneVersion(record);
    for (const [key, value] of Object.entries(patch)) {
      if (UNSAFE_KEYS.has(key)) continue;
      if (key === 'id' || key === 'appKey') continue;
      switch (key) {
        case 'kind':
          next.kind = normalizeKind(value);
          break;
        case 'meta':
          next.meta = sanitizeMeta(value);
          break;
        case 'running':
          next.running = normalizeRunning(value);
          break;
        case 'marked':
          next.marked = Boolean(value);
          break;
        case 'name':
          if (value !== null && value !== undefined && String(value).trim()) next.name = String(value).trim();
          break;
        case 'format':
        case 'arch':
        case 'packageName':
        case 'filePath':
          next[key] = value === null || value === undefined || String(value).trim() === '' ? null : String(value).trim();
          break;
        case 'size': {
          const num = Number(value);
          if (Number.isFinite(num) && num >= 0) next.size = num;
          break;
        }
        case 'createdAt': {
          const num = Number(value);
          if (Number.isFinite(num)) next.createdAt = num;
          break;
        }
        case 'lastUsedAt': {
          if (value === null) {
            next.lastUsedAt = null;
          } else {
            const num = Number(value);
            if (Number.isFinite(num)) next.lastUsedAt = num;
          }
          break;
        }
        default:
          next[key] = value;
      }
    }
    return next;
  }

  /** 浅合并更新；返回更新后的版本。写索引失败会回滚内存状态。 */
  async function updateVersion(id, patch) {
    await ensureReady();
    const key = id === null || id === undefined ? '' : String(id).trim();
    if (!key) throw new Error('updateVersion 缺少版本 id');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('updateVersion 的 patch 必须是对象');
    }
    const index = versions.findIndex((record) => record.id === key);
    if (index < 0) throw new Error(`版本不存在：${key}`);
    const previous = versions[index];
    const next = applyPatch(previous, patch);
    versions[index] = next;
    try {
      await enqueueWrite();
    } catch (error) {
      versions[index] = previous;
      throw error;
    }
    return cloneVersion(next);
  }

  /** 标记 / 取消标记（marked 缺省视为 true）。 */
  async function markVersion(id, marked) {
    return updateVersion(id, { marked: marked === undefined ? true : Boolean(marked) });
  }

  /** 记录运行中状态；running 非空时同时刷新 lastUsedAt。 */
  async function setRunning(id, running) {
    const normalized = normalizeRunning(running);
    const patch = { running: normalized };
    if (normalized) patch.lastUsedAt = Date.now();
    return updateVersion(id, patch);
  }

  /** 清除运行中状态。 */
  async function clearRunning(id) {
    return updateVersion(id, { running: null });
  }

  /** 只删 dataDir/versions/<id>/，且保证落在版本根目录内。 */
  async function removeVersionDir(id) {
    const dir = path.join(versionsDir, id);
    const relative = path.relative(versionsDir, dir);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      log('warn', `拒绝删除版本根目录之外的路径：${dir}`);
      return false;
    }
    if (!existsSync(dir)) return false;
    try {
      await withRetry(
        () => fsp.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
        '删除版本目录',
      );
    } catch (error) {
      log('warn', `删除版本目录失败（记录已删除，文件残留）：${dir} ${errorMessage(error)}`);
      return false;
    }
    return !existsSync(dir);
  }

  /**
   * 删除版本记录；deleteFile（默认 true）时连带删除该版本目录。
   * 记录不存在返回 { ok:false, deletedFile:false }，不抛错（便于 HTTP action 直接回包）。
   */
  async function deleteVersion(id, deleteOptions = {}) {
    await ensureReady();
    const key = id === null || id === undefined ? '' : String(id).trim();
    if (!key) return { ok: false, deletedFile: false, error: '缺少版本 id' };
    const deleteFile = deleteOptions && deleteOptions.deleteFile !== undefined ? Boolean(deleteOptions.deleteFile) : true;
    const index = versions.findIndex((record) => record.id === key);
    if (index < 0) return { ok: false, deletedFile: false, error: `版本不存在：${key}` };

    const [removed] = versions.splice(index, 1);
    try {
      await enqueueWrite();
    } catch (error) {
      versions.splice(index, 0, removed);
      throw new Error(`删除版本失败（索引写入失败）：${errorMessage(error)}`);
    }

    let deletedFile = false;
    if (deleteFile) deletedFile = await removeVersionDir(key);
    log('info', `已删除应用版本 ${key}${deleteFile ? (deletedFile ? '（含文件）' : '（文件删除失败，已残留）') : '（保留文件）'}`);
    return { ok: true, deletedFile };
  }

  /** 等待所有挂起写入落盘（写入队列可能被新写入拉长，因此循环到队尾稳定）。 */
  async function flush() {
    await ensureReady();
    for (let round = 0; round < 20; round += 1) {
      const pending = writeChain;
      await pending;
      if (writeChain === pending) return true;
    }
    return true;
  }

  return {
    ready,
    listVersions,
    getVersion,
    findByAppKey,
    addVersion,
    updateVersion,
    markVersion,
    setRunning,
    clearRunning,
    deleteVersion,
    flush,
  };
}
