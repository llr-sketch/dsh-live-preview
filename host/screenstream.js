// dsh-live-preview / host/screenstream.js
// 安卓高清串流后端：`adb exec-out screenrecord`(裸 H.264) → ffmpeg → MJPEG(JPEG) 帧源 + fps 统计。
//
// 契约见 ../CONTRACT-EMULATOR.md「host/screenstream.js」一节；由 service.js 通过
// createScreenStream({ dataDir, logger, ffmpegPath, getAdbPath, getSerial }) 装配。
//
// 设计约束：
//  - 无 ffmpeg → start() 返回 mode:'unavailable' + 中文 detail（服务层降级 screencap 轮询）；
//  - 无 adb / 未选设备 → mode:'error' + 中文 detail；
//  - screenrecord 有 180s 上限，正常退出后自动重启，不中断串流；
//  - 连续 5 次「启动失败」（子进程起不来，或没产出任何帧就退出）→ mode:'error' 并停止重试；
//  - stop() 结束 adb/ffmpeg 两个子进程并等待退出，清空监听器，不留悬挂句柄；
//  - 所有子进程事件（exit/error/stdout/stderr）都有监听，绝不产生 unhandled error；
//  - 帧解析处理跨 chunk 边界、坏帧丢弃、buffer 上限（避免内存爆）。
//
// 实测得到的两个 ffmpeg 必需兼容处理（否则老版本一条帧都出不来）：
//  1) `-analyzeduration 0 -probesize 32`：screenrecord 管道是永不 EOF 的实时流，
//     默认流信息分析会一直等数据，ffmpeg 卡在 avformat_find_stream_info 里不输出；
//  2) 首帧看门狗 + 前置参数档位：个别版本（实测 N-87130）`-fflags nobuffer` +
//     裸 H.264 管道会静默出 0 帧，3s 内解不出帧就自动退到不带 nobuffer 的档位。
// 这两步都只在需要时生效，默认仍是契约里的原始命令行。

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { killTree } from './util.js';

const IS_WIN = process.platform === 'win32';

/** fps 统计窗口：最近 1 秒内的帧数。 */
const FPS_WINDOW_MS = 1000;
/** 连续 N 次启动失败后进入 mode:'error'。 */
const MAX_CONSECUTIVE_START_FAILURES = 5;
/** 待解析缓冲上限（超过说明数据流异常，直接丢掉旧数据）。 */
const MAX_PENDING_BYTES = 8 * 1024 * 1024;
/** 单帧上限，超过仍无 EOI 视为坏帧（把游标推进到 SOI 之后继续找）。 */
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
/** 小于这个长度的「JPEG」必然是坏帧。 */
const MIN_FRAME_BYTES = 128;
/** 正常重启（screenrecord 180s 到期）的间隔。 */
const RESTART_DELAY_MS = 150;
/** 失败重试退避基数/上限。 */
const FAIL_BACKOFF_MS = 400;
const MAX_FAIL_BACKOFF_MS = 2000;
/** 终止子进程时等待退出（必要时二次强杀）的时长。 */
const KILL_WAIT_MS = 2000;
/** start() 等待第一轮子进程就绪的上限。 */
const FIRST_ATTEMPT_TIMEOUT_MS = 6000;
/** `ffmpeg -version` 探测超时。 */
const FFMPEG_PROBE_TIMEOUT_MS = 5000;
/** ffmpeg 版本探测缓存（避免每次 start 都跑一次）。 */
const FFMPEG_VERSION_CACHE_MS = 10 * 60 * 1000;
/** 首帧看门狗：子进程已起来、adb 也有数据，但 N 毫秒内一帧都没解出来 → 判定参数不兼容。 */
const FRAME_WATCHDOG_MS = 2500;
/** 一轮 screenrecord 跑够这么久之后的退出视为「正常轮换」，不计启动失败。 */
const MIN_NORMAL_RUN_MS = 3000;

const SCREENRECORD_TIME_LIMIT_S = 180;
const SCREENRECORD_BIT_RATE = 6_000_000;

// 帧同步/输入兼容档位：默认档严格按契约（含 -fflags nobuffer）；如果某版本 ffmpeg 在
// 裸 H.264 管道输入下用 nobuffer 一帧都不出（实测 2017 年的 N-87130 就是这样），
// 就自动退到不带 nobuffer 的档位，再不行连 low_delay 也去掉。
const FFMPEG_LEADING_VARIANTS = [
  ['-hide_banner', '-loglevel', 'error', '-fflags', 'nobuffer', '-flags', 'low_delay'],
  ['-hide_banner', '-loglevel', 'error', '-flags', 'low_delay'],
  ['-hide_banner', '-loglevel', 'error'],
];
// 必须显式关掉 avformat 的流信息分析：screenrecord 的管道是「永不 EOF 的实时流」，
// 默认 analyzeduration=5s/probesize=5MB 时 ffmpeg 会一直等在 avformat_find_stream_info
// 里读数据，一帧都不输出（实测：不加这两个选项，老版本 pipeline 输出恒为 0）。
const FFMPEG_INPUT_ARGS = ['-analyzeduration', '0', '-probesize', '32', '-f', 'h264', '-i', 'pipe:0'];
const FFMPEG_SCALE_FILTER = "scale='min(960,iw)':-2";
const FFMPEG_OUTPUT_ARGS = ['-f', 'mjpeg', '-q:v', '5', 'pipe:1'];

const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);
const NO_BYTES = Buffer.alloc(0);

// ---------------------------------------------------------------------------
// 纯函数工具
// ---------------------------------------------------------------------------

/**
 * 从 JPEG 的 SOF 段解析宽高（正确做法：跳过标记段，不假设 SOF 位置）。
 * @param {Buffer} buffer
 * @returns {{width:number,height:number}|null}
 */
function jpegDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      // 数据错位：向后找下一个标记
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // 无长度的标记：SOI/EOI/RSTn/TEM
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (offset + 4 > buffer.length) return null;
    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (segmentLength < 2) return null;
    // SOF0..SOF15（排除 DHT=C4、JPGA8? C8、DHT=CC）
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (offset + 9 > buffer.length) return null;
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (marker === 0xda) return null; // 已进入扫描数据，没有 SOF 可用
    offset += 2 + segmentLength;
  }
  return null;
}

/** 追加文本并保留尾部 max 字符（用于 error detail）。 */
function appendTail(current, chunk, max = 4000) {
  const text = `${current}${chunk.toString('utf8')}`;
  return text.length > max ? text.slice(-max) : text;
}

/** 取错误消息（不依赖 Error 类型）。 */
function formatError(error) {
  if (!error) return '未知错误';
  if (typeof error === 'string') return error;
  if (error.message) return String(error.message);
  return String(error);
}

/** 简单延时（不参与 stop 唤醒：仅用于进程退出等待）。 */
function waitMs(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/** 等待子进程 'spawn' 或 'error'：快速判断能否真正启动。 */
function spawnReady(child) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.once('spawn', () => finish({ ok: true }));
    child.once('error', (error) => finish({ ok: false, error: formatError(error) }));
  });
}

/** ffmpeg 是否明确拒绝了我们传入的帧同步选项（老/新版本差异兜底用）。 */
function looksLikeFpsOptionRejection(text) {
  if (!text) return false;
  const rejected = /(unrecognized option|unknown option|option .* not found|error parsing options|找不到选项)/i.test(
    text,
  );
  return rejected && /fps_mode|vsync/i.test(text);
}

// ---------------------------------------------------------------------------
// createScreenStream
// ---------------------------------------------------------------------------

/**
 * 创建高清串流后端。
 * @param {{
 *   dataDir?: string,
 *   logger?: any,
 *   ffmpegPath?: string | (() => string|null|Promise<string|null>),
 *   getAdbPath?: () => string|null,
 *   getSerial?: () => string|null,
 * }} [opts]
 */
export function createScreenStream(opts = {}) {
  const options = opts || {};
  const logger = options.logger;
  const dataDir =
    options.dataDir && String(options.dataDir).trim()
      ? path.resolve(String(options.dataDir).trim())
      : null;
  const ffmpegPathOption = options.ffmpegPath;
  const getAdbPath = typeof options.getAdbPath === 'function' ? options.getAdbPath : null;
  const getSerial = typeof options.getSerial === 'function' ? options.getSerial : null;

  // ---- 对外状态 ----
  let mode = 'idle'; // idle | h264 | unavailable | error
  let running = false;
  let detail = null;
  let errors = 0;
  let frames = 0;
  let fps = 0;
  let lastFrameAt = null;
  let latest = null; // { data, width, height, ts }

  // ---- 内部状态 ----
  const listeners = new Set();
  const frameTimes = [];
  let pending = NO_BYTES;
  let corruptFrames = 0;
  let consecutiveFailures = 0;
  let generation = 0; // 递增代号：旧 supervisor/子进程回调据此失效
  let currentGen = null; // { adb, ffmpeg, detached, framesAtStart }
  let runPromise = null;
  let firstAttemptResolve = null;
  let wakeRestart = null;
  let lifecycle = Promise.resolve();
  let ffmpegVersion = null;
  let fpsArgsMode = 'auto'; // auto | fps_mode | vsync | none
  let inputVariant = 0; // FFMPEG_LEADING_VARIANTS 下标（nobuffer 兼容档位）
  let activeFfmpegExe = null; // 当前使用的 ffmpeg 路径（用于记住可用档位）

  const ffmpegVersionCache = new Map(); // exe -> { at, value }
  const variantCache = new Map(); // exe -> 该 ffmpeg 能出帧的档位（避免每次 start 重新试错）

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
      /* 日志失败不影响主流程 */
    }
  }

  // ---- 可被 stop() 唤醒的延时（重启等待期间 stop 不必干等） ----
  function interruptibleSleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        wakeRestart = null;
        resolve();
      }, ms);
      wakeRestart = () => {
        clearTimeout(timer);
        wakeRestart = null;
        resolve();
      };
    });
  }

  function wakeRestartSleep() {
    const wake = wakeRestart;
    if (wake) wake();
  }

  // ---- 依赖解析 ----
  async function resolveFfmpegPath() {
    let value = ffmpegPathOption;
    try {
      if (typeof value === 'function') value = value();
      value = await Promise.resolve(value);
    } catch (error) {
      log('warn', `解析 ffmpeg 路径失败：${formatError(error)}`);
      return null;
    }
    const raw = value == null ? '' : String(value).trim().replace(/^"|"$/g, '');
    if (raw) {
      if (path.isAbsolute(raw) || raw.includes('/') || raw.includes('\\')) {
        return existsSync(raw) ? raw : null;
      }
      // 裸命令名（例如 "ffmpeg"）交给 spawn 走 PATH
      return raw;
    }
    // 兜底：契约数据目录约定位置
    if (dataDir) {
      const candidate = path.join(dataDir, 'ffmpeg', IS_WIN ? 'ffmpeg.exe' : 'ffmpeg');
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  function resolveAdbPath() {
    if (!getAdbPath) return null;
    try {
      const value = getAdbPath();
      const raw = value == null ? '' : String(value).trim();
      return raw || null;
    } catch (error) {
      log('warn', `解析 adb 路径失败：${formatError(error)}`);
      return null;
    }
  }

  function resolveSerial() {
    if (!getSerial) return null;
    try {
      const value = getSerial();
      const raw = value == null ? '' : String(value).trim();
      return raw || null;
    } catch (error) {
      log('warn', `解析设备 serial 失败：${formatError(error)}`);
      return null;
    }
  }

  // ---- ffmpeg 版本 / 帧同步参数 ----
  // 裸 H.264 输入没有时间戳，ffmpeg 默认按 25fps(CFR) 处理输出会丢/补帧，
  // 达不到 30fps。必须显式透传帧：ffmpeg >= 5.1 用 -fps_mode passthrough，
  // 更老版本用 -vsync 0，仍不支持时退回默认（尽力而为）。
  function probeFfmpeg(exe) {
    const cached = ffmpegVersionCache.get(exe);
    if (cached && Date.now() - cached.at < FFMPEG_VERSION_CACHE_MS) return Promise.resolve(cached.value);
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(exe, ['-hide_banner', '-version'], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        log('debug', `探测 ffmpeg 版本失败：${formatError(error)}`);
        resolve(null);
        return;
      }
      let output = '';
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ffmpegVersionCache.set(exe, { at: Date.now(), value });
        resolve(value);
      };
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        finish(null);
      }, FFMPEG_PROBE_TIMEOUT_MS);
      child.stdout.on('data', (chunk) => {
        if (output.length < 8192) output += chunk.toString('utf8');
      });
      child.stderr.on('data', () => {});
      child.stdout.on('error', () => {});
      child.stderr.on('error', () => {});
      child.on('error', () => finish(null));
      child.on('close', () => {
        const match = /ffmpeg version\s+(\S+)/i.exec(output);
        if (!match) {
          finish(null);
          return;
        }
        const versionMatch = /(\d+)\.(\d+)/.exec(match[1]);
        finish(
          versionMatch
            ? { raw: match[1], major: Number(versionMatch[1]), minor: Number(versionMatch[2]) }
            : { raw: match[1], major: null, minor: null },
        );
      });
    });
  }

  function currentFpsArgs() {
    if (fpsArgsMode === 'fps_mode') return ['-fps_mode', 'passthrough'];
    if (fpsArgsMode === 'vsync') return ['-vsync', '0'];
    if (fpsArgsMode === 'none') return [];
    if (ffmpegVersion && Number.isFinite(ffmpegVersion.major)) {
      const supportsFpsMode =
        ffmpegVersion.major > 5 || (ffmpegVersion.major === 5 && ffmpegVersion.minor >= 1);
      return supportsFpsMode ? ['-fps_mode', 'passthrough'] : ['-vsync', '0'];
    }
    return ['-vsync', '0']; // 版本未知：老参数兼容面更广
  }

  /** 换一组帧同步参数；返回是否还有备选。 */
  function switchFpsArgs() {
    const used = currentFpsArgs();
    if (fpsArgsMode === 'none' || used.length === 0) return false;
    if (used[0] === '-fps_mode') {
      fpsArgsMode = 'vsync';
      return true;
    }
    fpsArgsMode = 'none';
    return true;
  }

  /** 换一档 ffmpeg 前置参数（去掉 -fflags nobuffer 等）；返回是否还有备选。 */
  function switchInputVariant() {
    if (inputVariant >= FFMPEG_LEADING_VARIANTS.length - 1) return false;
    inputVariant += 1;
    return true;
  }

  function describeInputVariant() {
    return inputVariant === 0 ? '默认参数（含 -fflags nobuffer）' : `兼容档位 #${inputVariant}（不含 -fflags nobuffer${inputVariant > 1 ? '、不含 -flags low_delay' : ''}）`;
  }

  function ffmpegArgs() {
    return [
      ...(FFMPEG_LEADING_VARIANTS[inputVariant] || FFMPEG_LEADING_VARIANTS[0]),
      ...FFMPEG_INPUT_ARGS,
      '-vf',
      FFMPEG_SCALE_FILTER,
      ...currentFpsArgs(),
      ...FFMPEG_OUTPUT_ARGS,
    ];
  }

  function adbArgs(serial) {
    return [
      '-s',
      serial,
      'exec-out',
      'screenrecord',
      '--output-format=h264',
      '--time-limit',
      String(SCREENRECORD_TIME_LIMIT_S),
      '--bit-rate',
      String(SCREENRECORD_BIT_RATE),
      '-',
    ];
  }

  // ---- 帧解析（FFD8 … FFD9） ----
  function handleJpeg(buffer) {
    const ts = Date.now();
    // 第一帧就证明当前参数档位可用：立刻记住，之后 start()/重启直接复用，避免再次探测。
    if (activeFfmpegExe && variantCache.get(activeFfmpegExe) !== inputVariant) {
      variantCache.set(activeFfmpegExe, inputVariant);
      log('info', `ffmpeg 解码参数已确认：${describeInputVariant()}（已缓存，重启不再探测）`);
    }
    const dims = jpegDimensions(buffer);
    const frame = {
      data: buffer,
      width: dims ? dims.width : null,
      height: dims ? dims.height : null,
      ts,
    };
    latest = frame;
    frames += 1;
    lastFrameAt = ts;
    frameTimes.push(ts);
    while (frameTimes.length > 0 && frameTimes[0] < ts - FPS_WINDOW_MS) frameTimes.shift();
    fps = frameTimes.length;
    if (detail) detail = null; // 出帧即恢复健康，清掉临时错误
    // 同步通知订阅者；单个监听器抛错必须隔离，不能影响其他订阅者/解析循环。
    if (listeners.size > 0) {
      for (const listener of Array.from(listeners)) {
        try {
          listener(frame);
        } catch (error) {
          log('warn', `帧监听器抛错（已隔离）：${formatError(error)}`);
        }
      }
    }
    if (corruptFrames > 0 && corruptFrames % 100 === 0) {
      log('debug', `已丢弃 ${corruptFrames} 个坏帧`);
    }
  }

  function onFfmpegStdout(chunk) {
    if (!running || !Buffer.isBuffer(chunk) || chunk.length === 0) return;
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    let cursor = 0;
    for (;;) {
      const soi = pending.indexOf(JPEG_SOI, cursor);
      if (soi < 0) {
        // 没有新帧头：保留尾部单个 0xFF（可能是被切开的 SOI 首字节）
        cursor = pending.length - (pending.length > 0 && pending[pending.length - 1] === 0xff ? 1 : 0);
        break;
      }
      const eoi = pending.indexOf(JPEG_EOI, soi + 2);
      if (eoi < 0) {
        if (pending.length - soi > MAX_FRAME_BYTES) {
          corruptFrames += 1; // 超大且无结尾：坏帧，推进游标找下一个 SOI
          cursor = soi + 2;
          continue;
        }
        cursor = soi; // 半帧：留着等后续 chunk
        break;
      }
      if (eoi + 2 - soi < MIN_FRAME_BYTES) {
        corruptFrames += 1;
        cursor = eoi + 2;
        continue;
      }
      // 复制一份，避免持有整个 chunk 的内存（帧本身可能只占很小一段）
      const data = Buffer.from(pending.subarray(soi, eoi + 2));
      cursor = eoi + 2;
      handleJpeg(data);
    }
    pending = cursor >= pending.length ? NO_BYTES : pending.subarray(cursor);
    if (pending.length > MAX_PENDING_BYTES) {
      corruptFrames += 1;
      pending = pending.subarray(pending.length - MAX_FRAME_BYTES);
    }
  }

  // ---- 子进程生命周期 ----
  function detachGeneration(gen) {
    if (!gen || gen.detached) return;
    gen.detached = true;
    const { adb, ffmpeg } = gen;
    try {
      if (adb && adb.stdout && ffmpeg && ffmpeg.stdin) adb.stdout.unpipe(ffmpeg.stdin);
    } catch {
      /* ignore */
    }
    try {
      if (ffmpeg && ffmpeg.stdout) ffmpeg.stdout.removeListener('data', gen.onStdout);
    } catch {
      /* ignore */
    }
    for (const stream of [
      adb && adb.stdout,
      adb && adb.stderr,
      ffmpeg && ffmpeg.stdin,
      ffmpeg && ffmpeg.stdout,
      ffmpeg && ffmpeg.stderr,
    ]) {
      try {
        if (stream && typeof stream.destroy === 'function') stream.destroy();
      } catch {
        /* ignore */
      }
    }
  }

  async function terminateChild(child, label) {
    if (!child) return;
    const exited = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once('exit', () => resolve());
    });
    if (child.exitCode === null && child.signalCode === null) {
      if (IS_WIN) {
        // Windows：必须先 taskkill /T /F —— 父进程先死会让子进程被重新挂到别的父进程上，
        // 之后 /T 的进程树快照就找不到它们了（adb/ffmpeg 可能还有子进程）。
        await killTree(child.pid).catch(() => {});
      }
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
    let state = await Promise.race([exited.then(() => 'exit'), waitMs(KILL_WAIT_MS).then(() => 'timeout')]);
    if (state === 'timeout') {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      if (IS_WIN) await killTree(child.pid).catch(() => {});
      state = await Promise.race([exited.then(() => 'exit'), waitMs(KILL_WAIT_MS).then(() => 'timeout')]);
      if (state === 'timeout') log('warn', `${label || '子进程'} 未在限定时间内退出（pid=${child.pid ?? '?'}）`);
    }
  }

  async function cleanupGeneration(gen) {
    if (!gen) return;
    detachGeneration(gen);
    // 两个子进程并行收尾：换档/重启路径上能省掉一次串行等待（首帧延迟里很值钱）
    await Promise.all([terminateChild(gen.adb, 'adb'), terminateChild(gen.ffmpeg, 'ffmpeg')]);
    if (currentGen === gen) currentGen = null;
  }

  /**
   * 启动一轮 adb + ffmpeg。成功条件：两个子进程都真正 spawn 出来。
   * @returns {Promise<{gen:object, ok:boolean, error?:string}>}
   */
  async function launchGeneration(ffmpegExe, adbExe, serial, runId) {
    const gen = {
      adb: null,
      ffmpeg: null,
      detached: false,
      framesAtStart: frames,
      stdoutAdbBytes: 0,
      stderrAdb: '',
      stderrFfmpeg: '',
      startedAt: Date.now(),
      onStdout: onFfmpegStdout,
    };
    pending = NO_BYTES;

    const argsFf = ffmpegArgs();
    try {
      gen.ffmpeg = spawn(ffmpegExe, argsFf, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      return { gen, ok: false, error: `无法启动 ffmpeg：${formatError(error)}` };
    }
    const ffmpegReady = spawnReady(gen.ffmpeg);
    gen.ffmpeg.on('error', (error) => {
      if (runId === generation) log('warn', `ffmpeg 进程错误：${formatError(error)}`);
    });
    gen.ffmpeg.stdout.on('data', gen.onStdout);
    gen.ffmpeg.stdout.on('error', () => {});
    gen.ffmpeg.stdin.on('error', (error) => {
      if (error && error.code !== 'EPIPE') log('debug', `ffmpeg stdin 错误：${formatError(error)}`);
    });
    gen.ffmpeg.stderr.on('data', (chunk) => {
      gen.stderrFfmpeg = appendTail(gen.stderrFfmpeg, chunk);
      const text = chunk.toString('utf8').trim();
      if (text && runId === generation) log('warn', `ffmpeg: ${text.slice(0, 400)}`);
    });
    gen.ffmpeg.stderr.on('error', () => {});

    try {
      gen.adb = spawn(adbExe, adbArgs(serial), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      await terminateChild(gen.ffmpeg, 'ffmpeg');
      return { gen, ok: false, error: `无法启动 adb：${formatError(error)}` };
    }
    const adbReady = spawnReady(gen.adb);
    gen.adb.on('error', (error) => {
      if (runId === generation) log('warn', `adb 进程错误：${formatError(error)}`);
    });
    gen.adb.stdout.on('error', () => {});
    gen.adb.stderr.on('data', (chunk) => {
      gen.stderrAdb = appendTail(gen.stderrAdb, chunk);
      const text = chunk.toString('utf8').trim();
      if (text && runId === generation) log('debug', `adb: ${text.slice(0, 400)}`);
    });
    gen.adb.stderr.on('error', () => {});
    gen.adb.stdout.on('data', (chunk) => {
      gen.stdoutAdbBytes += chunk.length;
    });

    const [ffmpegState, adbState] = await Promise.all([ffmpegReady, adbReady]);
    if (!ffmpegState.ok || !adbState.ok) {
      const reason = !ffmpegState.ok
        ? `无法启动 ffmpeg：${ffmpegState.error || '未知原因'}`
        : `无法启动 adb：${adbState.error || '未知原因'}`;
      await cleanupGeneration(gen);
      return { gen, ok: false, error: reason };
    }
    if (runId !== generation) {
      await cleanupGeneration(gen);
      return { gen, ok: false, error: '启动过程中已被停止' };
    }

    // 核心管道：adb stdout(H.264) → ffmpeg stdin（二进制透传，不做任何转码/缓冲改写）
    try {
      gen.adb.stdout.pipe(gen.ffmpeg.stdin, { end: true });
    } catch (error) {
      await cleanupGeneration(gen);
      return { gen, ok: false, error: `连接 adb→ffmpeg 管道失败：${formatError(error)}` };
    }
    currentGen = gen;
    return { gen, ok: true };
  }

  /** 等本轮结束（adb 或 ffmpeg 任一退出/出错）。 */
  function waitGeneration(gen) {
    return new Promise((resolve) => {
      let settled = false;
      const cleanups = [];
      const finish = (value) => {
        if (settled) return;
        settled = true;
        for (const fn of cleanups) {
          try {
            fn();
          } catch {
            /* ignore */
          }
        }
        resolve(value);
      };
      const attach = (child, kind) => {
        if (settled || !child) return;
        if (child.exitCode !== null || child.signalCode !== null) {
          finish({ ended: kind, code: child.exitCode, signal: child.signalCode, alreadyExited: true });
          return;
        }
        const onExit = (code, signal) => finish({ ended: kind, code, signal });
        const onError = (error) =>
          finish({ ended: kind, code: null, signal: null, error: `${kind} 运行错误：${formatError(error)}` });
        child.once('exit', onExit);
        child.once('error', onError);
        cleanups.push(() => {
          child.removeListener('exit', onExit);
          child.removeListener('error', onError);
        });
      };
      attach(gen.adb, 'adb');
      attach(gen.ffmpeg, 'ffmpeg');
    });
  }

  function settleFirstAttempt(value) {
    const resolve = firstAttemptResolve;
    if (!resolve) return;
    firstAttemptResolve = null;
    resolve(value);
  }

  function describeEnd(outcome) {
    const parts = [];
    if (outcome.error) parts.push(outcome.error);
    if (outcome.ended === 'adb') {
      parts.push(
        `screenrecord 退出（code=${outcome.code == null ? 'null' : outcome.code}${
          outcome.signal ? `, signal=${outcome.signal}` : ''
        }）`,
      );
    } else if (outcome.ended === 'ffmpeg') {
      parts.push(
        `ffmpeg 退出（code=${outcome.code == null ? 'null' : outcome.code}${
          outcome.signal ? `, signal=${outcome.signal}` : ''
        }）`,
      );
    } else {
      parts.push('子进程提前退出');
    }
    const stderrTail = `${outcome.stderrAdb || ''}${outcome.stderrFfmpeg || ''}`.trim();
    if (stderrTail) parts.push(stderrTail.slice(-300));
    return parts.join('；');
  }

  /** 监督循环：失败计数、自动重启、fps 参数兼容退避、连续失败进入 error。 */
  async function supervise(runId, ffmpegExe, adbExe, serial) {
    try {
      while (running && runId === generation) {
        const launch = await launchGeneration(ffmpegExe, adbExe, serial, runId);
        if (runId !== generation || !running) {
          if (launch.gen) await cleanupGeneration(launch.gen);
          break;
        }

        if (!launch.ok) {
          settleFirstAttempt({
            ok: false,
            mode: 'error',
            detail: `${launch.error}（连续失败 ${consecutiveFailures + 1}/${MAX_CONSECUTIVE_START_FAILURES}）`,
          });
          consecutiveFailures += 1;
          errors += 1;
          const reason = launch.error || '子进程未能启动';
          detail = `高清串流启动失败（连续 ${consecutiveFailures}/${MAX_CONSECUTIVE_START_FAILURES}）：${reason}`;
          log('warn', detail);
          if (consecutiveFailures >= MAX_CONSECUTIVE_START_FAILURES) {
            mode = 'error';
            running = false;
            detail = `连续 ${MAX_CONSECUTIVE_START_FAILURES} 次启动高清串流失败，已停止重试：${reason}（面板将降级为 screencap 轮询）`;
            log('error', detail);
            break;
          }
          await interruptibleSleep(Math.min(FAIL_BACKOFF_MS * consecutiveFailures, MAX_FAIL_BACKOFF_MS));
          continue;
        }

        // 子进程都起来了：先让 start() 返回
        settleFirstAttempt({ ok: true, mode: 'h264', detail: `高清串流已启动：${serial}` });

        // 首帧看门狗：adb 已经在吐数据、子进程也活着，却一直解不出帧 → 大概率是 ffmpeg
        // 版本/参数不兼容（实测 2017 年的 N-87130 在 `-fflags nobuffer` + 裸 H.264 管道下
        // 一帧都不出）。先杀掉本轮，再换一档兼容参数重试。
        const gen = launch.gen;
        const watchdog = setTimeout(() => {
          if (runId !== generation || !running || gen.watchdogFired) return;
          if (frames - gen.framesAtStart > 0) return;
          if (gen.stdoutAdbBytes <= 0) return;
          gen.watchdogFired = true;
          log(
            'warn',
            `ffmpeg 在 ${FRAME_WATCHDOG_MS}ms 内没有解出任何帧（adb 已输出 ${gen.stdoutAdbBytes} 字节），尝试兼容参数`,
          );
          terminateChild(gen.adb, 'adb').catch(() => {});
          terminateChild(gen.ffmpeg, 'ffmpeg').catch(() => {});
        }, FRAME_WATCHDOG_MS);

        const outcome = await waitGeneration(gen);
        clearTimeout(watchdog);
        await cleanupGeneration(gen);
        if (runId !== generation || !running) break;

        const producedFrames = frames - gen.framesAtStart > 0;
        const stderrAll = `${gen.stderrAdb || ''}${gen.stderrFfmpeg || ''}`;

        // 老/新 ffmpeg 的帧同步参数不兼容 → 换一组重试，不计失败
        if (!producedFrames && looksLikeFpsOptionRejection(stderrAll) && switchFpsArgs()) {
          detail = `ffmpeg 不支持当前帧同步参数，已自动切换为 ${currentFpsArgs().join(' ') || '默认'}`;
          log('warn', detail);
          await interruptibleSleep(RESTART_DELAY_MS);
          continue;
        }

        // 首帧看门狗触发：输入参数档位不兼容 → 换档重试，不计失败
        if (!producedFrames && gen.watchdogFired && switchInputVariant()) {
          detail = `正在探测 ffmpeg 解码参数（第 ${inputVariant + 1}/${FFMPEG_LEADING_VARIANTS.length} 档：${describeInputVariant()}）`;
          log('warn', detail);
          await interruptibleSleep(RESTART_DELAY_MS);
          continue;
        }

        // 一旦出过帧，立刻记住这套 ffmpeg 能用的档位（下次 start/重启直接用，不再重新探测）
        if (producedFrames && activeFfmpegExe) {
          variantCache.set(activeFfmpegExe, inputVariant);
        }

        const ranMs = Date.now() - gen.startedAt;
        const cleanExit = outcome.code === 0 && !outcome.error;
        const adbSilent = !producedFrames && gen.stdoutAdbBytes === 0;

        // 运行足够久之后的退出（screenrecord 180s 上限、设备旋转、被系统回收等）属于
        // 「正常轮换」：立即重启、清零失败计数，绝不能记成「启动失败」。
        // 只有启动后短时间内退出（< MIN_NORMAL_RUN_MS）才计失败。
        if (ranMs >= MIN_NORMAL_RUN_MS && !adbSilent) {
          consecutiveFailures = 0;
          const framesThisRound = frames - gen.framesAtStart;
          detail = cleanExit
            ? 'screenrecord 到时轮换（180s 上限），正在重启高清串流'
            : `screenrecord 运行 ${(ranMs / 1000).toFixed(1)}s 后退出（code=${outcome.code ?? '-'}），已自动重启高清串流`;
          log(
            cleanExit ? 'info' : 'warn',
            `screenrecord 本轮结束：运行 ${(ranMs / 1000).toFixed(1)}s，${framesThisRound} 帧，` +
              `code=${outcome.code ?? '-'}${outcome.signal ? ` signal=${outcome.signal}` : ''}，` +
              (cleanExit ? '到时轮换，自动重启高清串流' : '已自动重启高清串流'),
          );
          await interruptibleSleep(RESTART_DELAY_MS);
          continue;
        }

        // 启动后短时间就退出（或 adb 完全没输出）→ 记一次启动失败
        consecutiveFailures += 1;
        errors += 1;
        const reason = describeEnd({ ...outcome, stderrAdb: gen.stderrAdb, stderrFfmpeg: gen.stderrFfmpeg });
        const reasonWithWatchdog = gen.watchdogFired
          ? `${reason}；ffmpeg ${FRAME_WATCHDOG_MS}ms 内未解出帧`
          : `${reason}；本轮仅运行 ${ranMs}ms`;
        detail = `高清串流启动失败（连续 ${consecutiveFailures}/${MAX_CONSECUTIVE_START_FAILURES}）：${reasonWithWatchdog}`;
        log('warn', detail);
        if (consecutiveFailures >= MAX_CONSECUTIVE_START_FAILURES) {
          mode = 'error';
          running = false;
          detail = `连续 ${MAX_CONSECUTIVE_START_FAILURES} 次启动高清串流失败，已停止重试：${reasonWithWatchdog}（面板将降级为 screencap 轮询）`;
          log('error', detail);
          break;
        }
        await interruptibleSleep(Math.min(FAIL_BACKOFF_MS * consecutiveFailures, MAX_FAIL_BACKOFF_MS));
      }
    } catch (error) {
      if (runId === generation) {
        mode = 'error';
        running = false;
        detail = `高清串流监督循环异常终止：${formatError(error)}`;
        log('error', detail);
      }
      settleFirstAttempt({ ok: false, mode: 'error', detail: `高清串流启动异常：${formatError(error)}` });
    }
  }

  // ---- 对外 API ----
  async function doStart() {
    if (running) {
      return { ok: true, mode: 'h264', detail: '高清串流已在运行', already: true };
    }
    const ffmpegExe = await resolveFfmpegPath();
    if (!ffmpegExe) {
      running = false;
      mode = 'unavailable';
      detail = '未找到 ffmpeg，高清串流不可用：请先点击「安装高清串流组件」（约 110MB），安装完成后会自动重试';
      log('warn', detail);
      return { ok: false, mode: 'unavailable', detail };
    }
    const adbExe = resolveAdbPath();
    if (!adbExe) {
      running = false;
      mode = 'error';
      detail = '未找到 adb，无法启动高清串流：请先安装 platform-tools（约 8MB）或设置 Android SDK 路径';
      log('warn', detail);
      return { ok: false, mode: 'error', detail };
    }
    if ((adbExe.includes('/') || adbExe.includes('\\')) && !existsSync(adbExe)) {
      running = false;
      mode = 'error';
      detail = `adb 路径不存在，无法启动高清串流：${adbExe}`;
      log('warn', detail);
      return { ok: false, mode: 'error', detail };
    }
    const serial = resolveSerial();
    if (!serial) {
      running = false;
      mode = 'error';
      detail = '未选择安卓设备，无法启动高清串流：请先选择一台设备（serial）';
      log('warn', detail);
      return { ok: false, mode: 'error', detail };
    }

    ffmpegVersion = await probeFfmpeg(ffmpegExe).catch(() => null);
    // 复用该 ffmpeg 上次验证过能出帧的参数档位（例如某版本必须去掉 -fflags nobuffer）
    const knownVariant = variantCache.get(ffmpegExe);
    inputVariant = Math.min(knownVariant ?? 0, FFMPEG_LEADING_VARIANTS.length - 1);
    activeFfmpegExe = ffmpegExe;

    // 复位状态
    generation += 1;
    const runId = generation;
    running = true;
    mode = 'h264';
    // 从未验证过该 ffmpeg 的参数档位时，先告诉面板「正在探测解码参数」
    detail =
      knownVariant == null
        ? `正在探测 ffmpeg 解码参数（第 ${inputVariant + 1}/${FFMPEG_LEADING_VARIANTS.length} 档：${describeInputVariant()}）`
        : null;
    errors = 0;
    frames = 0;
    fps = 0;
    lastFrameAt = null;
    latest = null;
    pending = NO_BYTES;
    corruptFrames = 0;
    consecutiveFailures = 0;
    frameTimes.length = 0;
    ffmpegVersionCache.set(ffmpegExe, { at: Date.now(), value: ffmpegVersion });

    log(
      'info',
      `启动高清串流：${serial}（adb ${adbExe} → ffmpeg ${ffmpegExe}${
        ffmpegVersion && ffmpegVersion.raw ? `，${ffmpegVersion.raw}` : ''
      }）${inputVariant > 0 ? ` [${describeInputVariant()}]` : ''}`,
    );

    const firstAttempt = new Promise((resolve) => {
      firstAttemptResolve = resolve;
    });
    runPromise = supervise(runId, ffmpegExe, adbExe, serial).finally(() => {
      if (runId === generation) runPromise = null;
    });

    const settled = await Promise.race([
      firstAttempt,
      waitMs(FIRST_ATTEMPT_TIMEOUT_MS).then(() => null),
    ]);
    if (!settled) {
      running = false;
      generation += 1; // 让 supervisor 退出
      mode = 'error';
      detail = `启动高清串流超时（${FIRST_ATTEMPT_TIMEOUT_MS}ms 内子进程未就绪）`;
      log('error', detail);
      await stopChildrenAndSupervisor();
      return { ok: false, mode: 'error', detail };
    }
    return settled;
  }

  /** 杀掉当前子进程并等 supervisor 收敛（供 stop / start 超时共用）。 */
  async function stopChildrenAndSupervisor() {
    wakeRestartSleep();
    const gen = currentGen;
    currentGen = null;
    if (gen) {
      detachGeneration(gen);
      await Promise.all([terminateChild(gen.adb, 'adb'), terminateChild(gen.ffmpeg, 'ffmpeg')]);
    }
    const pendingRun = runPromise;
    if (pendingRun) {
      // supervisor 本身也可能在清理同一批子进程；给它一个收敛窗口，避免悬挂
      await Promise.race([pendingRun.catch(() => {}), waitMs(3000)]);
    }
    runPromise = null;
  }

  async function doStop() {
    const wasRunning = running;
    running = false;
    generation += 1; // 使旧 supervisor / 子进程回调失效
    wakeRestartSleep();
    settleFirstAttempt({ ok: false, mode: 'error', detail: '高清串流已停止' });
    await stopChildrenAndSupervisor();
    pending = NO_BYTES;
    frameTimes.length = 0;
    fps = 0;
    latest = null;
    listeners.clear(); // 契约要求：stop 清空监听器
    if (mode === 'h264') mode = 'idle';
    if (wasRunning) log('info', '已停止高清串流');
  }

  function start() {
    const run = lifecycle.then(() => doStart());
    lifecycle = run.catch(() => {});
    return run;
  }

  function stop() {
    const run = lifecycle.then(() => doStop());
    lifecycle = run.catch(() => {});
    return run;
  }

  function stats() {
    const now = Date.now();
    while (frameTimes.length > 0 && frameTimes[0] < now - FPS_WINDOW_MS) frameTimes.shift();
    fps = frameTimes.length;
    return { mode, running, fps, frames, lastFrameAt, errors, detail };
  }

  function getFrame() {
    if (!latest) return null;
    return { data: latest.data, width: latest.width, height: latest.height, ts: latest.ts };
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  async function dispose() {
    try {
      await stop();
    } catch (error) {
      log('warn', `dispose 出错（已忽略）：${formatError(error)}`);
    }
    listeners.clear();
    ffmpegVersionCache.clear();
    latest = null;
  }

  return { start, stop, stats, getFrame, subscribe, dispose };
}
