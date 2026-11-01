/**
 * dsh-live-preview / host/importer.js
 *
 * 应用文件导入：识别文件类型 + 执行系统侧安装/启动。
 * 编排（state、日志、HTTP action）由 service.js 负责；本模块只做单步操作。
 *
 * 对外接口（严格按 CONTRACT 扩展，ESM，无第三方依赖）：
 *   detectAppFile(filePath)                       → { kind, format, size, arch?, machine?, entry?, reason?, detail? }
 *   prepareWebApp(filePath, destDir)              → { rootDir, entry }
 *   androidInstall({ adbPath, serial, filePath, onLog }) → { packageName, output }
 *   androidLaunch({ adbPath, serial, packageName, onLog }) → { output }
 *   launchWindowsApp(filePath, opts)              → { pid }
 *
 * 设计约束：
 *  - 只读文件头 / zip 中央目录，绝不把大文件（100MB+ APK）整体读进内存；
 *  - 所有外部命令都带超时、windowsHide，失败抛带输出尾部的 Error；
 *  - 不写用户工作区以外的路径（临时文件只在调用方给的 destDir 内产生）。
 */

import { closeSync, openSync, promises as fsp, readSync, statSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

const IS_WIN = process.platform === 'win32';

// ---- zip 常量 ----
const ZIP_LOCAL_SIG = 0x04034b50;
const ZIP_CENTRAL_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_EOCD_MIN = 22;
const EOCD_TAIL_BYTES = 66_000; // EOCD(22) + 最长注释(65535)
const ZIP_CD_MAX_BYTES = 32 * 1024 * 1024; // 中央目录上限（APK 通常 <5MB）
const STREAM_CHUNK = 1024 * 1024;
const STREAM_OVERLAP = 64;
const STREAM_SCAN_MAX_BYTES = 512 * 1024 * 1024;

// ---- 命令超时（毫秒） ----
const CMD_TIMEOUT_MS = 15_000;
const PM_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 600_000; // 大 APK 安装（118MB）留足时间
const MONKEY_TIMEOUT_MS = 45_000;
const EXTRACT_TIMEOUT_MS = 240_000;
const MAX_CAPTURED_BYTES = 8 * 1024 * 1024;
const ERROR_TAIL_CHARS = 1800;

// ---- 扩展名 / 机器类型 ----
const WINDOWS_EXE_EXTS = new Set(['.exe', '.dll', '.scr']);
const HTML_EXTS = new Set(['.html', '.htm']);
const PACKAGE_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/;

const PE_MACHINES = new Map([
  [0x8664, { arch: 'x64', machine: 'AMD64' }],
  [0xaa64, { arch: 'arm64', machine: 'ARM64' }],
  [0xa641, { arch: 'arm64', machine: 'ARM64EC' }],
  [0x014c, { arch: 'x86', machine: 'I386' }],
  [0x01c4, { arch: null, machine: 'ARMv7' }],
  [0x0200, { arch: null, machine: 'IA64' }],
  [0x5032, { arch: null, machine: 'RISCV64' }],
  [0x5064, { arch: null, machine: 'LOONGARCH64' }],
]);

// ============================================================================
// 通用小工具
// ============================================================================

function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

function tailOf(text, chars = ERROR_TAIL_CHARS) {
  const value = String(text ?? '').trim();
  return value.length > chars ? value.slice(-chars) : value;
}

/** stat 并保证是普通文件；不存在/无权限时抛带原因的 Error。 */
async function statFileOrThrow(file) {
  let st;
  try {
    st = await fsp.stat(file);
  } catch (error) {
    throw new Error(`无法读取文件（${file}）：${error && error.code ? error.code : error && error.message ? error.message : String(error)}`);
  }
  if (!st.isFile()) throw new Error(`不是文件（可能是目录）：${file}`);
  return st;
}

/** 从 fh 的指定位置读取 length 字节（容忍短读）。 */
async function readAt(fh, position, length) {
  const buf = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const result = await fh.read(buf, read, length - read, position + read);
    if (!result || !result.bytesRead) break;
    read += result.bytesRead;
  }
  return { buf: read === length ? buf : buf.subarray(0, read), read };
}

// ============================================================================
// PE（Windows 可执行文件）解析
// ============================================================================

function machineInfo(machine) {
  return PE_MACHINES.get(machine) || {
    arch: null,
    machine: `0x${(machine >>> 0).toString(16).toUpperCase()}`,
  };
}

/**
 * 解析 PE 头。peBuf 必须从 "PE\0\0" 签名开始，至少 24 字节（最好 26 字节含 optional magic）。
 * @returns {{valid:boolean, reason?:string, machine?:number, machineName?:string, arch?:string|null, sections?:number, peFormat?:string|null}}
 */
function parsePeHeader(peBuf) {
  if (!peBuf || peBuf.length < 24) return { valid: false, reason: 'PE 头不完整' };
  if (peBuf.readUInt32LE(0) !== 0x00004550) return { valid: false, reason: '缺少 "PE\\0\\0" 签名' };
  const machine = peBuf.readUInt16LE(4);
  const sections = peBuf.readUInt16LE(6);
  const optionalSize = peBuf.readUInt16LE(20);
  const characteristics = peBuf.readUInt16LE(22);
  if (machine === 0) return { valid: false, reason: 'PE Machine 字段为 0' };
  if (sections < 1 || sections > 96) return { valid: false, reason: `PE 节数异常（${sections}）` };
  if (optionalSize > 0x1000) return { valid: false, reason: `PE 可选头大小异常（${optionalSize}）` };
  const magic = peBuf.length >= 26 ? peBuf.readUInt16LE(24) : 0;
  if (optionalSize >= 2 && magic !== 0x10b && magic !== 0x20b) {
    return { valid: false, reason: `不是有效的 PE 映像（optional magic 0x${magic.toString(16)}）` };
  }
  const info = machineInfo(machine);
  return {
    valid: true,
    machine,
    machineName: info.machine,
    arch: info.arch,
    sections,
    characteristics,
    peFormat: magic === 0x20b ? 'PE32+' : magic === 0x10b ? 'PE32' : null,
  };
}

/** 异步：用已打开的 fh 读取并解析 PE 头。 */
async function readPeFromHandle(fh, size, head) {
  if (size < 64) return { valid: false, reason: '文件过小，不是 PE 文件' };
  const lfanew = head.readInt32LE(0x3c);
  if (lfanew < 64 || lfanew + 24 > size) {
    return { valid: false, reason: `e_lfanew 越界（${lfanew}）` };
  }
  const readLen = Math.min(26, size - lfanew);
  const { buf, read } = await readAt(fh, lfanew, readLen);
  if (read < 24) return { valid: false, reason: 'PE 头读取不完整' };
  return parsePeHeader(buf);
}

/** 同步：detect 之外（launchWindowsApp）用，只读几十字节。 */
function readPeHeaderSync(file) {
  const size = statSync(file).size;
  if (size < 64) return { valid: false, reason: '文件过小，不是 PE 文件' };
  const fd = openSync(file, 'r');
  try {
    const head = Buffer.alloc(64);
    const got = readSync(fd, head, 0, 64, 0);
    if (got < 64) return { valid: false, reason: 'PE 头读取不完整' };
    const lfanew = head.readInt32LE(0x3c);
    if (lfanew < 64 || lfanew + 24 > size) {
      return { valid: false, reason: `e_lfanew 越界（${lfanew}）` };
    }
    const readLen = Math.min(26, size - lfanew);
    const peBuf = Buffer.alloc(readLen);
    const n = readSync(fd, peBuf, 0, readLen, lfanew);
    return parsePeHeader(n === readLen ? peBuf : peBuf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
}

// ============================================================================
// zip 解析（只读中央目录 / 分块搜索，绝不整文件入内存）
// ============================================================================

/** 在文件尾部 buffer 里倒序找 EOCD 签名。 */
function findEocd(buffer) {
  const start = buffer.length - ZIP_EOCD_MIN;
  for (let i = start; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === ZIP_EOCD_SIG) {
      const commentLen = buffer.readUInt16LE(i + 20);
      if (i + ZIP_EOCD_MIN + commentLen <= buffer.length) return i;
    }
  }
  return -1;
}

function normalizeEntryName(name) {
  return String(name || '').replace(/\\/g, '/');
}

function isRootManifest(name) {
  return normalizeEntryName(name).toLowerCase() === 'androidmanifest.xml';
}

/** 解析 zip 中央目录记录。 */
function parseCentralDirectory(buffer) {
  const entries = [];
  let off = 0;
  while (off + 46 <= buffer.length) {
    if (buffer.readUInt32LE(off) !== ZIP_CENTRAL_SIG) break;
    const flags = buffer.readUInt16LE(off + 8);
    const method = buffer.readUInt16LE(off + 10);
    const csize = buffer.readUInt32LE(off + 20);
    const usize = buffer.readUInt32LE(off + 24);
    const nameLen = buffer.readUInt16LE(off + 28);
    const extraLen = buffer.readUInt16LE(off + 30);
    const commentLen = buffer.readUInt16LE(off + 32);
    const localOffset = buffer.readUInt32LE(off + 42);
    const recordLen = 46 + nameLen + extraLen + commentLen;
    if (off + recordLen > buffer.length) break;
    let name = '';
    try {
      name = buffer.toString('utf8', off + 46, off + 46 + nameLen);
    } catch {
      name = '';
    }
    entries.push({
      name: normalizeEntryName(name),
      flags,
      method,
      csize,
      usize,
      localOffset,
      directory: /\/$/.test(normalizeEntryName(name)),
    });
    off += recordLen;
  }
  return entries;
}

/**
 * 读 zip 中央目录：EOCD（文件尾 66KB）→ 中央目录（上限 32MB）。
 * @returns {Promise<{ok:boolean, entries:Array|null, reason?:string}>}
 */
async function readZipEntries(fh, size) {
  if (size < ZIP_EOCD_MIN) return { ok: false, entries: null, reason: '文件过小，不是 zip' };
  const tailLen = Math.min(size, EOCD_TAIL_BYTES);
  const { buf: tail } = await readAt(fh, size - tailLen, tailLen);
  const eocd = findEocd(tail);
  if (eocd < 0) return { ok: false, entries: null, reason: '未找到 zip 目录结束标记（EOCD）' };
  const totalEntries = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    return { ok: false, entries: null, reason: 'zip64 中央目录暂不解析' };
  }
  if (totalEntries === 0 || cdSize === 0) return { ok: true, entries: [] };
  if (cdOffset + cdSize > size || cdSize < 46) {
    return { ok: false, entries: null, reason: 'zip 中央目录偏移非法' };
  }
  if (cdSize > ZIP_CD_MAX_BYTES) {
    return { ok: false, entries: null, reason: `zip 中央目录过大（${formatSize(cdSize)}）` };
  }
  const { buf: cd, read } = await readAt(fh, cdOffset, cdSize);
  if (read < cdSize) return { ok: false, entries: null, reason: 'zip 中央目录读取不完整' };
  return { ok: true, entries: parseCentralDirectory(cd) };
}

/** 中央目录不可用时的兜底：1MB 分块流式搜索条目名（带重叠，不整文件入内存）。 */
async function streamScanZip(fh, size) {
  const found = { manifest: false, index: false };
  const manifestNeedle = Buffer.from('AndroidManifest.xml', 'latin1');
  const max = Math.min(size, STREAM_SCAN_MAX_BYTES);
  let position = 0;
  let carry = Buffer.alloc(0);
  while (position < max && !(found.manifest && found.index)) {
    const len = Math.min(STREAM_CHUNK, max - position);
    const { buf, read } = await readAt(fh, position, len);
    if (!read) break;
    const hay = carry.length ? Buffer.concat([carry, buf]) : buf;
    if (!found.manifest && hay.indexOf(manifestNeedle) >= 0) found.manifest = true;
    if (!found.index) {
      const text = hay.toString('latin1').toLowerCase();
      if (text.includes('index.html')) found.index = true;
    }
    carry = Buffer.from(hay.subarray(Math.max(0, hay.length - STREAM_OVERLAP)));
    position += read;
  }
  return found;
}

/** 从条目集合中挑层级最浅的 index.html（同层取路径最短的）。 */
function pickIndexEntry(entries) {
  let best = null;
  for (const entry of entries) {
    if (entry.directory) continue;
    const name = normalizeEntryName(entry.name);
    const base = name.slice(name.lastIndexOf('/') + 1).toLowerCase();
    if (base !== 'index.html') continue;
    const depth = name.split('/').length - 1;
    if (!best || depth < best.depth || (depth === best.depth && name.length < best.entry.length)) {
      best = { entry: name, depth };
    }
  }
  return best ? best.entry : null;
}

/**
 * 读出 zip 中某个条目的原始内容（需解压时用 inflateRawSync）。
 * 仅用于很小的条目（APK 的 AndroidManifest.xml），上限 8MB。
 */
async function readZipEntryData(fh, entry, maxBytes = 8 * 1024 * 1024) {
  if (!entry || entry.directory) return null;
  if (!(entry.csize > 0) || entry.csize > maxBytes) return null;
  const { buf: local, read: localRead } = await readAt(fh, entry.localOffset, 30);
  if (localRead < 30 || local.readUInt32LE(0) !== ZIP_LOCAL_SIG) return null;
  const nameLen = local.readUInt16LE(26);
  const extraLen = local.readUInt16LE(28);
  const dataStart = entry.localOffset + 30 + nameLen + extraLen;
  const { buf: data, read } = await readAt(fh, dataStart, entry.csize);
  if (read <= 0) return null;
  const raw = read === entry.csize ? data : data.subarray(0, read);
  if (entry.method === 0) return raw; // stored
  if (entry.method === 8) {
    try {
      return inflateRawSync(raw);
    } catch {
      return null;
    }
  }
  return null;
}

// ============================================================================
// 二进制 AndroidManifest.xml（AXML）→ 包名
// 仅在「安装前后包列表无差集」（覆盖安装）时兜底，正常路径不触发。
// ============================================================================

function readAxmlStringPool(buf, off) {
  const headerSize = buf.readUInt16LE(off + 2);
  const chunkSize = buf.readUInt32LE(off + 4);
  const stringCount = buf.readUInt32LE(off + 8);
  const flags = buf.readUInt32LE(off + 16);
  const stringsStart = buf.readUInt32LE(off + 20);
  if (!(stringCount >= 0) || stringCount > 200_000) return null;
  if (off + chunkSize > buf.length) return null;
  const utf8 = (flags & 0x100) !== 0;
  const base = off + stringsStart;
  const strings = new Array(stringCount);
  for (let i = 0; i < stringCount; i += 1) {
    const stringOffset = buf.readUInt32LE(off + headerSize + i * 4);
    let p = base + stringOffset;
    if (p <= 0 || p >= buf.length) {
      strings[i] = '';
      continue;
    }
    if (utf8) {
      let charLen = buf[p];
      p += 1;
      if (charLen & 0x80) {
        charLen = ((charLen & 0x7f) << 8) | buf[p];
        p += 1;
      }
      let byteLen = buf[p];
      p += 1;
      if (byteLen & 0x80) {
        byteLen = ((byteLen & 0x7f) << 8) | buf[p];
        p += 1;
      }
      const end = Math.min(buf.length, p + byteLen);
      strings[i] = buf.toString('utf8', p, end);
    } else {
      let charLen = buf.readUInt16LE(p);
      p += 2;
      if (charLen & 0x8000) {
        charLen = ((charLen & 0x7fff) << 16) | buf.readUInt16LE(p);
        p += 2;
      }
      const end = Math.min(buf.length, p + charLen * 2);
      strings[i] = buf.toString('utf16le', p, end);
    }
  }
  return strings;
}

/** 在 START_ELEMENT 块里找 <manifest package="...">。 */
function readAxmlStartElementPackage(buf, off, strings) {
  const chunkSize = buf.readUInt32LE(off + 4);
  const chunkEnd = Math.min(buf.length, off + chunkSize);
  const nameIndex = buf.readUInt32LE(off + 20);
  const tagName = strings[nameIndex] || '';
  if (!/^manifest$/i.test(tagName)) return null;
  const attributeStart = buf.readUInt16LE(off + 24);
  const attributeSize = buf.readUInt16LE(off + 26) || 20;
  const attributeCount = buf.readUInt16LE(off + 28);
  if (attributeSize < 20) return null;
  let attrOff = off + 16 + attributeStart;
  for (let i = 0; i < attributeCount && attrOff + attributeSize <= chunkEnd; i += 1) {
    const attrName = strings[buf.readUInt32LE(attrOff + 4)] || '';
    if (attrName === 'package') {
      const rawValue = buf.readUInt32LE(attrOff + 8);
      const dataType = buf.readUInt8(attrOff + 15);
      const dataValue = buf.readUInt32LE(attrOff + 16);
      let value = null;
      if (rawValue !== 0xffffffff && rawValue < strings.length) value = strings[rawValue];
      if (!value && dataType === 0x03 && dataValue < strings.length) value = strings[dataValue];
      if (value) return value;
    }
    attrOff += attributeSize;
  }
  return null;
}

/** 解析二进制 AndroidManifest.xml 的包名，失败返回 null（绝不抛）。 */
function parseAxmlManifestPackage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return null;
  if (buf.readUInt16LE(0) !== 0x0003) return null; // RES_XML_TYPE
  const fileHeaderSize = buf.readUInt16LE(2);
  const declaredSize = buf.readUInt32LE(4);
  const fileSize = Math.min(buf.length, declaredSize > 8 ? declaredSize : buf.length);
  let off = fileHeaderSize >= 8 ? fileHeaderSize : 8;
  let strings = null;
  while (off + 8 <= fileSize) {
    const chunkType = buf.readUInt16LE(off);
    const chunkSize = buf.readUInt32LE(off + 4);
    if (chunkSize < 8 || off + chunkSize > buf.length) break;
    if (chunkType === 0x0001) {
      try {
        strings = readAxmlStringPool(buf, off);
      } catch {
        strings = null;
      }
    } else if (chunkType === 0x0102 && strings) {
      try {
        const packageName = readAxmlStartElementPackage(buf, off, strings);
        if (packageName) return packageName;
      } catch {
        /* 继续尝试后续元素 */
      }
    }
    off += chunkSize;
  }
  return null;
}

/** 打开 APK 读取 AndroidManifest.xml 并解析包名；失败返回 null。 */
async function readApkPackageName(filePath) {
  let fh = null;
  try {
    const st = await fsp.stat(filePath);
    fh = await fsp.open(filePath, 'r');
    const index = await readZipEntries(fh, st.size);
    if (!index.ok || !index.entries) return null;
    const manifestEntry = index.entries.find((entry) => !entry.directory && isRootManifest(entry.name));
    if (!manifestEntry) return null;
    const data = await readZipEntryData(fh, manifestEntry);
    if (!data) return null;
    const packageName = parseAxmlManifestPackage(data);
    return packageName && PACKAGE_RE.test(packageName) ? packageName : null;
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

// ============================================================================
// 外部命令执行
// ============================================================================

function makeCommandError(label, result) {
  const tail = tailOf(result.errText || result.text || '');
  const error = new Error(`${label} 失败（exit ${result.code}）${tail ? `：${tail}` : ''}`);
  error.exitCode = result.code;
  error.stdout = result.stdout;
  error.stderr = result.stderr;
  error.output = `${result.text}\n${result.errText}`.trim();
  return error;
}

/** cmd.exe 参数转义（仅用于 .cmd/.bat 兼容路径；正式 adb 都是 .exe，不会走到这里）。 */
function quoteCmdArg(value) {
  const text = String(value);
  if (text === '') return '""';
  if (!/[\s"&|<>^]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

/** spawn 包装：.cmd/.bat 在 Windows 上需要经 cmd.exe 执行（Node 的 shell:true 已弃用且不转义参数）。 */
function spawnCommand(exe, argv, spawnOptions) {
  if (IS_WIN && /\.(cmd|bat)$/i.test(exe)) {
    const comspec = process.env.ComSpec || 'cmd.exe';
    const command = `"${exe}" ${argv.map(quoteCmdArg).join(' ')}`.trim();
    // windowsVerbatimArguments：/c 后的整串交给 cmd 自己解析（与 Node 内部 shell:true 相同的处理方式）。
    return spawn(comspec, ['/d', '/s', '/c', `"${command}"`], {
      ...spawnOptions,
      windowsVerbatimArguments: true,
    });
  }
  return spawn(exe, argv, spawnOptions);
}

/**
 * 执行命令：windowsHide、超时、按行回传 onLine、输出上限 8MB。
 * 非 0 退出码 reject 带输出尾部的 Error（error.stdout/stderr 保留原始 Buffer）。
 */
function runCommand(exe, args, options = {}) {
  const timeout =
    Number.isFinite(Number(options.timeout)) && Number(options.timeout) > 0
      ? Number(options.timeout)
      : CMD_TIMEOUT_MS;
  const argv = (Array.isArray(args) ? args : []).map((value) => String(value));
  const label = `${path.basename(String(exe))} ${argv.join(' ')}`.slice(0, 300);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnCommand(String(exe), argv, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(new Error(`无法执行 ${path.basename(String(exe))}：${error && error.message ? error.message : String(error)}`));
      return;
    }

    const outChunks = [];
    const errChunks = [];
    let outBytes = 0;
    let errBytes = 0;
    let outLine = '';
    let errLine = '';
    let settled = false;
    let timer = null;

    const emitLine = (line) => {
      if (!line || typeof options.onLine !== 'function') return;
      try {
        options.onLine(line);
      } catch {
        /* 日志回调异常不影响命令执行 */
      }
    };
    const feed = (isErr, chunk) => {
      if (!chunk || !chunk.length) return;
      if (typeof options.onLine === 'function') {
        const text = chunk.toString('utf8');
        let buffer = (isErr ? errLine : outLine) + text;
        const parts = buffer.split(/\r?\n/);
        buffer = parts.pop() ?? '';
        if (isErr) errLine = buffer;
        else outLine = buffer;
        for (const part of parts) emitLine(part);
      }
      if (isErr) {
        if (errBytes < MAX_CAPTURED_BYTES) {
          const take = chunk.subarray(0, Math.max(0, MAX_CAPTURED_BYTES - errBytes));
          errChunks.push(take);
          errBytes += take.length;
        }
      } else if (outBytes < MAX_CAPTURED_BYTES) {
        const take = chunk.subarray(0, Math.max(0, MAX_CAPTURED_BYTES - outBytes));
        outChunks.push(take);
        outBytes += take.length;
      }
    };

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      }
      reject(new Error(`命令超时（${timeout}ms）：${label}`));
    }, timeout);

    child.stdout.on('data', (chunk) => feed(false, chunk));
    child.stderr.on('data', (chunk) => feed(true, chunk));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(new Error(`无法执行 ${path.basename(String(exe))}：${error && error.message ? error.message : String(error)}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (outLine) emitLine(outLine);
      if (errLine) emitLine(errLine);
      const stdout = Buffer.concat(outChunks);
      const stderr = Buffer.concat(errChunks);
      const result = {
        code: Number.isFinite(code) ? code : -1,
        stdout,
        stderr,
        text: stdout.toString('utf8'),
        errText: stderr.toString('utf8'),
        label,
      };
      if (result.code !== 0) reject(makeCommandError(label, result));
      else resolve(result);
    });
  });
}

function emitLog(onLog, line) {
  if (typeof onLog !== 'function') return;
  try {
    onLog(String(line));
  } catch {
    /* ignore */
  }
}

function adbBaseArgs(serial) {
  const value = serial === undefined || serial === null ? '' : String(serial).trim();
  return value ? ['-s', value] : [];
}

/** `adb shell pm list packages -3` → 保序包名数组。 */
async function listThirdPartyPackages(adbPath, baseArgs, onLog) {
  const result = await runCommand(adbPath, [...baseArgs, 'shell', 'pm', 'list', 'packages', '-3'], {
    timeout: PM_TIMEOUT_MS,
    onLine: (line) => emitLog(onLog, line),
  });
  const packages = [];
  const text = `${result.text}\n${result.errText}`;
  for (const rawLine of text.split(/\r?\n/)) {
    const match = /^package:([^\s]+)\s*$/.exec(rawLine.trim());
    if (match) packages.push(match[1]);
  }
  return packages;
}

// ============================================================================
// 1) 识别
// ============================================================================

/**
 * 识别应用文件类型（只读文件头 / zip 目录，不执行文件）。
 * 文件不存在或不是普通文件时抛 Error；无法识别的类型返回 kind:'unsupported'。
 *
 * @param {string} filePath
 * @returns {Promise<{kind:'android'|'windows'|'web'|'unsupported', format:'apk'|'exe'|'msi'|'html'|'zip'|null, size:number, arch?:'x64'|'arm64'|'x86'|null, machine?:string, entry?:string, reason?:string, detail?:string}>}
 */
export async function detectAppFile(filePath) {
  if (!filePath || !String(filePath).trim()) throw new Error('detectAppFile 缺少文件路径');
  const file = path.resolve(String(filePath));
  const st = await statFileOrThrow(file);
  const size = st.size;
  const ext = path.extname(file).toLowerCase();

  if (size === 0) {
    return { kind: 'unsupported', format: null, size, reason: '文件为空（0 字节）', detail: '空文件，无法识别' };
  }
  // 单文件网页：扩展名即可判定（不读大文件）
  if (HTML_EXTS.has(ext)) {
    return { kind: 'web', format: 'html', size, detail: `网页（单文件 ${ext}，${formatSize(size)}）` };
  }
  // MSI：扩展名优先；OLE 头作为补充证据
  if (ext === '.msi') {
    return { kind: 'windows', format: 'msi', size, detail: `Windows 安装包（MSI，${formatSize(size)}）` };
  }

  let fh = null;
  try {
    fh = await fsp.open(file, 'r');
    const headLen = Math.min(size, 64);
    const { buf: head, read: headRead } = await readAt(fh, 0, headLen);
    if (headRead < 4) {
      return { kind: 'unsupported', format: null, size, reason: '文件头太短', detail: '文件头太短，无法识别' };
    }
    const isMz = head[0] === 0x4d && head[1] === 0x5a;
    const isZip =
      head[0] === 0x50 &&
      head[1] === 0x4b &&
      (head[2] === 0x03 || head[2] === 0x05 || head[2] === 0x07);
    const isOle =
      head.length >= 8 && head.readUInt32LE(0) === 0xe011cfd0 && head.readUInt32LE(4) === 0xe11ab1a1;

    // ---- PE（.exe/.dll/.scr 且 MZ+PE 合法） ----
    if (isMz) {
      const pe = await readPeFromHandle(fh, size, head);
      if (!pe.valid) {
        const reason = `可执行文件头（MZ）无效：${pe.reason}`;
        return { kind: 'unsupported', format: null, size, reason, detail: reason };
      }
      if (!WINDOWS_EXE_EXTS.has(ext)) {
        const reason = `PE 可执行文件，但扩展名 ${ext || '(无)'} 不是 .exe/.dll/.scr`;
        return { kind: 'unsupported', format: null, size, reason, detail: reason };
      }
      const archLabel = pe.arch ? `${pe.machineName} / ${pe.arch}` : pe.machineName;
      return {
        kind: 'windows',
        format: 'exe',
        size,
        arch: pe.arch,
        machine: pe.machineName,
        detail: `Windows 可执行文件（${archLabel}，${pe.peFormat || 'PE'}，${formatSize(size)}）`,
      };
    }

    // ---- zip：APK / 网页包 / 未知压缩包 ----
    if (isZip) {
      const zip = await readZipEntries(fh, size);
      let entries = zip.ok ? zip.entries : null;
      let manifestFound = false;
      let indexEntry = null;
      if (entries) {
        manifestFound = entries.some((entry) => !entry.directory && isRootManifest(entry.name));
        indexEntry = pickIndexEntry(entries);
      } else {
        // 中央目录不可用（zip64/异常）：分块搜索条目名兜底
        const scan = await streamScanZip(fh, size);
        manifestFound = scan.manifest;
        indexEntry = scan.index ? 'index.html' : null;
      }
      if (manifestFound) {
        return {
          kind: 'android',
          format: 'apk',
          size,
          detail: `Android 安装包（压缩包内找到 AndroidManifest.xml，${formatSize(size)}）`,
        };
      }
      if (ext === '.apk') {
        return {
          kind: 'android',
          format: 'apk',
          size,
          detail: `Android 安装包（APK 扩展名，${formatSize(size)}）`,
        };
      }
      if (ext === '.zip') {
        if (indexEntry) {
          return {
            kind: 'web',
            format: 'zip',
            size,
            entry: indexEntry,
            detail: `网页包（ZIP，入口 ${indexEntry}，${formatSize(size)}）`,
          };
        }
        const reason = 'ZIP 里没有 index.html 入口，也不是 APK';
        return { kind: 'unsupported', format: null, size, reason, detail: reason };
      }
      const reason = `压缩包（扩展名 ${ext || '(无)'}）既不是 APK，也不是网页包`;
      return { kind: 'unsupported', format: null, size, reason, detail: reason };
    }

    if (isOle) {
      const reason = `OLE 复合文档（扩展名 ${ext || '(无)'}），不是可执行程序或 APK`;
      return { kind: 'unsupported', format: null, size, reason, detail: reason };
    }

    const reason = ext ? `不支持的文件类型（扩展名 ${ext}）` : '无法识别的文件类型（没有扩展名）';
    return { kind: 'unsupported', format: null, size, reason, detail: reason };
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

// ============================================================================
// 2) 网页包准备
// ============================================================================

function psQuote(value) {
  return String(value).replace(/'/g, "''");
}

/** 用 PowerShell Expand-Archive（非 Windows 回退 unzip）解压。 */
async function extractZip(zipPath, destDir) {
  if (IS_WIN) {
    const script =
      `$ErrorActionPreference='Stop'; ` +
      `Expand-Archive -LiteralPath '${psQuote(zipPath)}' -DestinationPath '${psQuote(destDir)}' -Force`;
    const result = await runCommand(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: EXTRACT_TIMEOUT_MS },
    );
    return result;
  }
  const result = await runCommand('unzip', ['-o', zipPath, '-d', destDir], { timeout: EXTRACT_TIMEOUT_MS });
  return result;
}

/** 递归找层级最浅的 index.html，返回相对 rootDir 的 posix 路径。 */
async function findShallowestIndex(rootDir) {
  let best = null;
  let visited = 0;
  const LIMIT = 200_000;
  async function walk(dir, depth) {
    if (depth > 16 || visited > LIMIT) return;
    let dirents;
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      visited += 1;
      if (visited > LIMIT) return;
      const full = path.join(dir, dirent.name);
      if (dirent.isSymbolicLink()) continue;
      if (dirent.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!dirent.isFile()) continue;
      if (dirent.name.toLowerCase() !== 'index.html') continue;
      const rel = path.relative(rootDir, full).split(path.sep).join('/');
      const entryDepth = rel.split('/').length - 1;
      if (!best || entryDepth < best.depth || (entryDepth === best.depth && rel.length < best.entry.length)) {
        best = { entry: rel, depth: entryDepth };
      }
    }
  }
  await walk(rootDir, 0);
  return best ? best.entry : null;
}

/**
 * 把网页文件准备到 destDir：
 *  - 单文件 .html/.htm 复制为 destDir/index.html；
 *  - .zip 用 PowerShell Expand-Archive 解压，返回解压后层级最浅的 index.html。
 *
 * @param {string} filePath
 * @param {string} destDir 调用方提供的（建议新建/空的）目标目录
 * @returns {Promise<{rootDir:string, entry:string}>} rootDir 为绝对路径，entry 为相对 posix 路径
 */
export async function prepareWebApp(filePath, destDir) {
  if (!filePath || !String(filePath).trim()) throw new Error('prepareWebApp 缺少文件路径');
  if (!destDir || !String(destDir).trim()) throw new Error('prepareWebApp 缺少目标目录 destDir');
  const file = path.resolve(String(filePath));
  const dest = path.resolve(String(destDir));
  const detected = await detectAppFile(file);

  if (detected.kind === 'android') {
    throw new Error('这是安卓安装包（APK），请使用「安装到安卓设备」，不能作为网页预览');
  }
  if (detected.kind === 'windows') {
    throw new Error(`不是网页文件（${detected.format === 'msi' ? 'Windows 安装包' : 'Windows 可执行文件'}）`);
  }
  if (detected.kind === 'unsupported') {
    throw new Error(`不是可预览的网页文件：${detected.reason || detected.detail || '无法识别'}`);
  }

  await fsp.mkdir(dest, { recursive: true });

  if (detected.format === 'html') {
    const target = path.join(dest, 'index.html');
    await fsp.copyFile(file, target);
    return { rootDir: dest, entry: 'index.html' };
  }

  if (detected.format !== 'zip') {
    throw new Error(`不支持的网页格式：${detected.format || detected.detail || '未知'}`);
  }

  try {
    await extractZip(file, dest);
  } catch (error) {
    throw new Error(`解压网页包失败：${error && error.message ? error.message : String(error)}`);
  }
  const entry = await findShallowestIndex(dest);
  if (!entry) {
    throw new Error('解压完成，但压缩包里没有找到 index.html 入口页');
  }
  return { rootDir: dest, entry };
}

// ============================================================================
// 3) Android 安装 / 启动
// ============================================================================

/**
 * 安装 APK 并返回包名。
 * 包名获取顺序：安装前后 `pm list packages -3` 差集（多个取输出顺序最后一个）→
 * 无差集（覆盖安装）时解析 APK 内 AndroidManifest.xml（AXML）兜底。
 *
 * @param {{adbPath:string, serial?:string, filePath:string, onLog?:(line:string)=>void}} options
 * @returns {Promise<{packageName:string, output:string}>}
 */
export async function androidInstall({ adbPath, serial, filePath, onLog } = {}) {
  if (!adbPath || !String(adbPath).trim()) {
    throw new Error('androidInstall 缺少 adbPath（请先安装 platform-tools 或设置 Android SDK 路径）');
  }
  if (!filePath || !String(filePath).trim()) throw new Error('androidInstall 缺少 filePath');
  const adb = String(adbPath);
  const apk = path.resolve(String(filePath));
  const st = await statFileOrThrow(apk);
  if (st.size === 0) throw new Error(`APK 文件为空：${apk}`);
  const base = adbBaseArgs(serial);

  emitLog(onLog, `[importer] 读取安装前第三方应用列表…（${formatSize(st.size)} 的 APK）`);
  let before = [];
  try {
    before = await listThirdPartyPackages(adb, base, onLog);
  } catch (error) {
    emitLog(onLog, `[importer] 读取安装前包列表失败（继续安装）：${error.message}`);
  }

  emitLog(onLog, `[importer] adb install -r -g ${apk}`);
  let installResult;
  try {
    installResult = await runCommand(adb, [...base, 'install', '-r', '-g', apk], {
      timeout: INSTALL_TIMEOUT_MS,
      onLine: (line) => emitLog(onLog, line),
    });
  } catch (error) {
    throw new Error(`APK 安装失败：${error.message}`);
  }

  const output = `${installResult.text}\n${installResult.errText}`.trim();
  if (!/Success/i.test(output)) {
    throw new Error(`APK 安装失败（adb 未报告 Success）：${tailOf(output)}`);
  }

  emitLog(onLog, '[importer] 安装完成，读取安装后第三方应用列表…');
  let after = [];
  try {
    after = await listThirdPartyPackages(adb, base, onLog);
  } catch (error) {
    emitLog(onLog, `[importer] 读取安装后包列表失败：${error.message}`);
  }

  const beforeSet = new Set(before);
  const fresh = after.filter((pkg) => !beforeSet.has(pkg));
  let packageName = null;
  if (fresh.length === 1) {
    packageName = fresh[0];
    emitLog(onLog, `[importer] 从包列表差集得到包名：${packageName}`);
  } else if (fresh.length > 1) {
    packageName = fresh[fresh.length - 1];
    emitLog(
      onLog,
      `[importer] 检测到 ${fresh.length} 个新包：${fresh.join(', ')}；按 adb 输出顺序取最后一个 ${packageName}`,
    );
  } else {
    emitLog(onLog, '[importer] 包列表没有差集（可能是覆盖安装），改为解析 APK 的 AndroidManifest.xml…');
    packageName = await readApkPackageName(apk);
    if (packageName) emitLog(onLog, `[importer] 从 APK Manifest 解析到包名：${packageName}`);
  }

  if (!packageName) {
    throw new Error(
      'APK 安装成功，但无法确定包名：设备第三方应用列表没有新增（可能是覆盖安装），且 APK Manifest 解析失败。请手动确认应用包名后启动。',
    );
  }
  return { packageName, output };
}

/**
 * 通过 monkey 启动已安装应用（LAUNCHER category）。
 * @param {{adbPath:string, serial?:string, packageName:string, onLog?:(line:string)=>void}} options
 * @returns {Promise<{output:string}>}
 */
export async function androidLaunch({ adbPath, serial, packageName, onLog } = {}) {
  if (!adbPath || !String(adbPath).trim()) {
    throw new Error('androidLaunch 缺少 adbPath（请先安装 platform-tools 或设置 Android SDK 路径）');
  }
  const pkg = String(packageName ?? '').trim();
  if (!PACKAGE_RE.test(pkg)) throw new Error(`androidLaunch 包名不合法：${String(packageName)}`);
  const adb = String(adbPath);
  const base = adbBaseArgs(serial);

  emitLog(onLog, `[importer] monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
  let result;
  try {
    result = await runCommand(
      adb,
      [...base, 'shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'],
      { timeout: MONKEY_TIMEOUT_MS, onLine: (line) => emitLog(onLog, line) },
    );
  } catch (error) {
    throw new Error(`启动应用失败（${pkg}）：${error.message}`);
  }
  const output = `${result.text}\n${result.errText}`.trim();
  if (!/Events injected/i.test(output) && /No activities found|monkey aborted|Error:/i.test(output)) {
    throw new Error(`启动应用失败（${pkg}）：${tailOf(output)}`);
  }
  return { output };
}

// ============================================================================
// 4) Windows 程序启动
// ============================================================================

/**
 * 后台启动 Windows 可执行文件（detached，不等待退出）。
 * arm64 程序在 x64 主机上直接抛错；x86/x64 在 x64 主机可运行。
 *
 * @param {string} filePath
 * @param {{cwd?:string, args?:string[], arch?:string|null, env?:NodeJS.ProcessEnv}} [opts]
 * @returns {{pid:number}}
 */
export function launchWindowsApp(filePath, opts = {}) {
  if (!filePath || !String(filePath).trim()) throw new Error('launchWindowsApp 缺少文件路径');
  const exe = path.resolve(String(filePath));
  let size;
  try {
    size = statSync(exe).size;
  } catch (error) {
    throw new Error(`无法读取文件（${exe}）：${error && error.code ? error.code : error && error.message ? error.message : String(error)}`);
  }
  const ext = path.extname(exe).toLowerCase();
  if (ext === '.msi') {
    throw new Error('这是 MSI 安装包，请走 Windows 安装流程（msiexec），不能用 launchWindowsApp 直接启动');
  }
  if (ext === '.dll') {
    throw new Error('DLL 是动态链接库，不能直接启动；请传入对应的 .exe');
  }

  let arch = opts.arch ? String(opts.arch) : null;
  let machine = null;
  if (!arch) {
    const pe = readPeHeaderSync(exe);
    if (pe.valid) {
      arch = pe.arch || null;
      machine = pe.machineName || null;
    }
  }
  if (arch === 'arm64' && process.arch === 'x64') {
    throw new Error(
      `该程序是 ARM64 架构${machine ? `（${machine}）` : ''}，当前 x64 Windows 无法直接运行；请换用 x64 版本或在 ARM64 Windows 上运行`,
    );
  }

  const cwd = opts.cwd && String(opts.cwd).trim() ? path.resolve(String(opts.cwd)) : path.dirname(exe);
  const args = Array.isArray(opts.args) ? opts.args.map((value) => String(value)) : [];
  const child = spawn(exe, args, {
    cwd,
    env: opts.env ?? process.env,
    detached: true,
    windowsHide: false,
    stdio: 'ignore',
  });
  // spawn 的失败（ENOENT/EACCES）异步通过 error 事件抛出；这里挂个监听避免未处理错误让宿主崩溃。
  let spawnError = null;
  child.once('error', (error) => {
    spawnError = error;
  });
  child.unref();
  const pid = child.pid;
  if (pid) return { pid };

  // CreateProcess 被拒（EACCES）的常见原因：安装器的 manifest 要求提权、或带「以管理员身份运行」
  // 兼容性标记。先按 Explorer 的方式用 ShellExecute 普通启动（需要时系统自己弹 UAC），
  // 仍失败再用 runas 强制提权，最后给出可读原因。
  let shellError = null;
  try {
    return { pid: launchWindowsViaShell(exe, cwd, false), shell: true };
  } catch (error) {
    shellError = error;
  }
  try {
    return { pid: launchWindowsViaShell(exe, cwd, true), shell: true, elevated: true };
  } catch (error) {
    const direct = spawnError ? `${spawnError.code || ''} ${spawnError.message || ''}`.trim() : '';
    const shellReason = shellError && shellError.message ? shellError.message : String(shellError);
    const elevateReason = error && error.message ? error.message : String(error);
    throw new Error(
      `启动失败：无法创建进程（${exe}，${formatSize(size)}）${direct ? `；直接启动：${direct}` : ''}；ShellExecute：${shellReason}；提权启动：${elevateReason}`
    );
  }
}

/** PowerShell 字符串字面量转义。 */
/**
 * ShellExecute 启动（与资源管理器双击等价）；runas=true 时强制以管理员身份启动（会弹 UAC）。
 * @returns {number} 新进程 pid
 */
function launchWindowsViaShell(exe, cwd, runas) {
  const literal = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const verb = runas ? ' -Verb runas' : '';
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$p = Start-Process -FilePath ${literal(exe)} -WorkingDirectory ${literal(cwd)}${verb} -PassThru`,
    'if ($p) { Write-Output $p.Id } else { Write-Output 0 }',
  ].join('; ');
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 180000 }
    );
    const parts = String(out).trim().split(/\s+/).filter(Boolean);
    const pid = Number(parts[parts.length - 1]);
    if (!Number.isFinite(pid) || pid <= 0) throw new Error('没有返回进程号');
    return pid;
  } catch (error) {
    const text = `${(error && error.stdout) || ''}${(error && error.stderr) || ''}`.trim();
    if (/cancel|canceled|拒绝|取消|0x800704C7/i.test(`${text} ${error && error.message}`)) {
      throw new Error('程序需要管理员权限，UAC 授权被取消');
    }
    throw new Error(text ? tailOf(text) : (error && error.message) || 'ShellExecute 启动失败');
  }
}
