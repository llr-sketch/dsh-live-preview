// host/windows.js - persistent PowerShell-backed Windows window capture client.
//
// Implements the interface required by CONTRACT.md:
//   createWindowsCapture({ logger? }) -> {
//     list()                   -> [{ hwnd, title, pid, className, rect: [x, y, w, h] }]
//     capture(hwnd, o?)        -> Buffer (JPEG); o: { maxWidth = 1600, quality = 72 }
//     info(hwnd)               -> { hwnd, title, pid, className, rect, minimized }
//     dispose()                -> kill the persistent PowerShell process
//   }
//
// The backend is one long-lived `powershell.exe -File host/windows.ps1`, spoken to
// over stdin/stdout with a one-line-per-command protocol (see windows.ps1). All
// calls are serialized on a promise queue; each request has a 5s timeout; if the
// child process dies unexpectedly it is automatically restarted (once in a row -
// two consecutive crashes surface an error instead of crash-looping).

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DEFAULT_MAX_WIDTH = 1600;
const DEFAULT_QUALITY = 72;
const REQUEST_TIMEOUT_MS = 5000;
const MAX_CONSECUTIVE_CRASHES = 2;
const STDERR_TAIL_LINES = 12;
const PS1_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'windows.ps1');

function normalizeLogger(logger) {
  if (!logger) return null;
  if (typeof logger === 'function') {
    return { info: logger, warn: logger, error: logger, debug: logger };
  }
  const out = {};
  for (const level of ['info', 'warn', 'error', 'debug']) {
    out[level] = typeof logger[level] === 'function' ? logger[level].bind(logger) : null;
  }
  return out;
}

function toPositiveInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const r = Math.round(n);
  if (r < min) return min;
  if (r > max) return max;
  return r;
}

export function createWindowsCapture(opts = {}) {
  const log = normalizeLogger(opts && opts.logger);
  const logAt = (level, msg) => {
    const fn = log && log[level];
    if (!fn) return;
    try { fn('[live-preview][windows] ' + msg); } catch { /* logger must never break capture */ }
  };

  /** @type {{ proc: import('node:child_process').ChildProcess, expected: boolean, stderrTail: string[] } | null} */
  let child = null;
  /** @type {{ id: number, timer: NodeJS.Timeout, resolve: (v: any) => void, reject: (e: Error) => void } | null} */
  let pending = null;
  let stdoutBuf = '';
  let queueChain = Promise.resolve();
  let disposed = false;
  let requestSeq = 0;
  let consecutiveCrashes = 0;
  let lastCrashMessage = '';

  function readStderr(info, chunk) {
    for (const raw of String(chunk).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      info.stderrTail.push(line);
      if (info.stderrTail.length > STDERR_TAIL_LINES) info.stderrTail.shift();
      logAt('debug', 'stderr: ' + line);
    }
  }

  function rejectPending(error) {
    if (!pending) return;
    const p = pending;
    pending = null;
    clearTimeout(p.timer);
    p.reject(error);
  }

  function killChild(reason) {
    if (!child) return;
    const info = child;
    child = null;
    info.expected = true;
    logAt('debug', 'killing PowerShell capture process' + (reason ? ' (' + reason + ')' : ''));
    try { info.proc.kill(); } catch { }
  }

  function onStdoutLine(line) {
    const text = line.replace(/\r$/, '');
    if (!text) return;

    // FRAME <id> <base64>  (the <id> token is echoed from the "#<id>" request prefix)
    if (text.startsWith('FRAME ')) {
      const rest = text.slice(6).trim();
      let id = null;
      let b64 = rest;
      const sp = rest.indexOf(' ');
      if (sp > 0) {
        const maybeId = rest.slice(0, sp);
        if (/^\d+$/.test(maybeId)) {
          id = Number(maybeId);
          b64 = rest.slice(sp + 1).trim();
        }
      }
      const p = pending;
      if (!p) { logAt('debug', 'stray FRAME line ignored'); return; }
      if (id !== null && id !== p.id) { logAt('debug', 'late FRAME for request ' + id + ' ignored'); return; }
      pending = null;
      clearTimeout(p.timer);
      try {
        const buf = Buffer.from(b64, 'base64');
        if (!buf.length) throw new Error('backend returned an empty frame');
        consecutiveCrashes = 0;
        p.resolve(buf);
      } catch (err) {
        p.reject(err instanceof Error ? err : new Error(String(err)));
      }
      return;
    }

    // ERR <id> <message>; an id-less ERR is an init failure emitted before the
    // command loop started.
    if (text === 'ERR' || text.startsWith('ERR ')) {
      const rest = text.slice(3).trim();
      let id = null;
      let message = rest;
      const sp = rest.indexOf(' ');
      if (sp > 0) {
        const maybeId = rest.slice(0, sp);
        if (/^\d+$/.test(maybeId)) {
          id = Number(maybeId);
          message = rest.slice(sp + 1).trim();
        }
      }
      if (!message) message = 'unknown capture backend error';
      const p = pending;
      if (!p) {
        if (id === null) { lastCrashMessage = message; logAt('warn', 'backend error: ' + message); }
        else logAt('debug', 'late ERR for request ' + id + ' ignored');
        return;
      }
      if (id !== null && id !== p.id) { logAt('debug', 'late ERR for request ' + id + ' ignored'); return; }
      pending = null;
      clearTimeout(p.timer);
      p.reject(new Error(message));
      return;
    }

    if (text.startsWith('{')) {
      let obj;
      try { obj = JSON.parse(text); } catch { logAt('warn', 'unparsable JSON line: ' + text.slice(0, 200)); return; }
      // The unsolicited startup line {"ok":true,"ready":true,...} is NEVER a response,
      // even if a request is already pending (the command may have been written to
      // stdin before the child finished Add-Type compilation).
      if (obj && obj.ready) {
        logAt('debug', 'backend ready pid=' + obj.pid);
        return;
      }
      const p = pending;
      if (!p) {
        if (obj && obj.ok === false) {
          const message = typeof obj.error === 'string' && obj.error ? obj.error : 'capture backend error';
          lastCrashMessage = message;
          logAt('warn', 'backend error: ' + message);
        }
        return;
      }
      if (obj && obj.id !== undefined && Number(obj.id) !== p.id) {
        logAt('debug', 'late JSON response for request ' + obj.id + ' ignored');
        return;
      }
      pending = null;
      clearTimeout(p.timer);
      if (obj && obj.ok === false) {
        const message = typeof obj.error === 'string' && obj.error ? obj.error : 'capture backend error';
        p.reject(new Error(message));
      } else {
        consecutiveCrashes = 0;
        p.resolve(obj);
      }
      return;
    }
    logAt('debug', 'unexpected backend line: ' + text.slice(0, 200));
  }

  function onStdoutData(chunk) {
    stdoutBuf += chunk;
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, idx);
      stdoutBuf = stdoutBuf.slice(idx + 1);
      onStdoutLine(line);
    }
    // Guard against a runaway line if the backend protocol ever desyncs.
    if (stdoutBuf.length > 32 * 1024 * 1024) {
      stdoutBuf = '';
      logAt('warn', 'stdout buffer overflow, dropped');
      rejectPending(new Error('windows capture protocol desynchronized'));
      killChild('protocol desync');
    }
  }

  function startChild() {
    if (disposed) throw new Error('windows capture backend is disposed');
    if (consecutiveCrashes >= MAX_CONSECUTIVE_CRASHES) {
      throw new Error('windows capture backend crashed repeatedly' + (lastCrashMessage ? ': ' + lastCrashMessage : ''));
    }
    if (!PS1_PATH || !path.isAbsolute(PS1_PATH)) throw new Error('windows capture script path is invalid');
    logAt('debug', 'starting PowerShell capture process');
    const proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1_PATH],
      { cwd: path.dirname(PS1_PATH), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const info = { proc, expected: false, stderrTail: [] };
    child = info;
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', onStdoutData);
    proc.stderr.on('data', (chunk) => readStderr(info, chunk));
    // A write after the child died must not become an unhandled stream 'error'.
    proc.stdin.on('error', (err) => {
      logAt('debug', 'stdin error: ' + (err && err.message ? err.message : String(err)));
    });
    proc.on('error', (err) => {
      if (child === info) child = null;
      const message = 'failed to start PowerShell capture process: ' + (err && err.message ? err.message : String(err));
      lastCrashMessage = message;
      logAt('error', message);
      rejectPending(new Error(message));
    });
    proc.on('exit', (code, signal) => {
      if (child !== info) return;
      child = null;
      const tail = info.stderrTail.join(' | ');
      if (info.expected) {
        logAt('debug', 'PowerShell capture process exited (expected)');
      } else {
        consecutiveCrashes += 1;
        lastCrashMessage = 'PowerShell capture process exited (code=' + code + (signal ? ', signal=' + signal : '') + ')'
          + (tail ? ' stderr: ' + tail : '');
        logAt('warn', lastCrashMessage);
        rejectPending(new Error(lastCrashMessage));
      }
      if (pending) rejectPending(new Error('PowerShell capture process exited'));
    });
    return info;
  }

  function ensureChild() {
    if (child) return child;
    return startChild();
  }

  function sendCommand(command) {
    return new Promise((resolve, reject) => {
      if (disposed) { reject(new Error('windows capture backend is disposed')); return; }
      let info;
      try {
        info = ensureChild();
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (pending) { reject(new Error('internal error: concurrent capture request')); return; }
      const id = ++requestSeq;
      const label = command.split(' ')[0];
      const timer = setTimeout(() => {
        if (!pending || pending.id !== id) return;
        pending = null;
        logAt('warn', 'request timed out: ' + label);
        killChild('request timeout');
        reject(new Error('windows capture request timed out after ' + REQUEST_TIMEOUT_MS + 'ms: ' + label));
      }, REQUEST_TIMEOUT_MS);
      pending = { id, timer, resolve, reject };
      try {
        // "#<id> " lets the backend echo the id and lets us ignore the startup
        // ready line / any late response from a previous timed-out request.
        info.proc.stdin.write('#' + id + ' ' + command + '\n');
      } catch (err) {
        pending = null;
        clearTimeout(timer);
        killChild('write failed');
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  // All public calls are serialized: windows.ps1 handles exactly one command at a time.
  function enqueue(fn) {
    const run = queueChain.then(fn, fn);
    queueChain = run.then(() => undefined, () => undefined);
    return run;
  }

  function parseHwnd(hwnd) {
    const n = Number(hwnd);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      throw new Error('invalid hwnd: ' + String(hwnd));
    }
    return n;
  }

  async function list() {
    return enqueue(async () => {
      const res = await sendCommand('LIST');
      const windows = res && Array.isArray(res.windows) ? res.windows : [];
      return windows.map((w) => ({
        hwnd: Number(w.hwnd),
        title: typeof w.title === 'string' ? w.title : '',
        pid: Number(w.pid) || 0,
        className: typeof w.className === 'string' ? w.className : '',
        rect: Array.isArray(w.rect) ? w.rect.map((n) => Number(n) || 0) : [0, 0, 0, 0],
      }));
    });
  }

  async function info(hwnd) {
    const id = parseHwnd(hwnd);
    return enqueue(async () => {
      const res = await sendCommand('INFO ' + id);
      const w = (res && res.window) || {};
      return {
        hwnd: Number(w.hwnd) || id,
        title: typeof w.title === 'string' ? w.title : '',
        pid: Number(w.pid) || 0,
        className: typeof w.className === 'string' ? w.className : '',
        rect: Array.isArray(w.rect) ? w.rect.map((n) => Number(n) || 0) : [0, 0, 0, 0],
        minimized: !!w.minimized,
      };
    });
  }

  async function capture(hwnd, o = {}) {
    const id = parseHwnd(hwnd);
    const options = o && typeof o === 'object' ? o : {};
    const maxWidth = toPositiveInt(options.maxWidth, DEFAULT_MAX_WIDTH, 1, 8192);
    const quality = toPositiveInt(options.quality, DEFAULT_QUALITY, 1, 100);
    return enqueue(async () => {
      const buf = await sendCommand('CAPTURE ' + id + ' ' + maxWidth + ' ' + quality);
      if (!Buffer.isBuffer(buf) || buf.length === 0) throw new Error('capture backend returned no frame');
      return buf;
    });
  }

  // Not part of CONTRACT.md's required set; offered as a convenience for desk.activate.
  async function activate(hwnd) {
    const id = parseHwnd(hwnd);
    return enqueue(async () => {
      const res = await sendCommand('ACTIVATE ' + id);
      return { ok: !!(res && res.ok), hwnd: id };
    });
  }

  /** 最小化窗口（用于模拟器/命令提示符等不该盖住 DSH 的窗口）。 */
  async function minimize(hwnd) {
    const id = parseHwnd(hwnd);
    return enqueue(async () => {
      const res = await sendCommand('MINIMIZE ' + id);
      return { ok: !!(res && res.ok), hwnd: id };
    });
  }

  /**
   * 把窗口移到屏幕外（保持可见，PrintWindow 仍可捕获）。
   * 用于“在插件里预览、但不覆盖 DSH 界面”的应用窗口——最小化会让 PrintWindow 黑屏。
   */
  async function offscreen(hwnd) {
    const id = parseHwnd(hwnd);
    return enqueue(async () => {
      const res = await sendCommand('OFFSCREEN ' + id);
      return { ok: !!(res && res.ok), hwnd: id };
    });
  }

  /** 把被移到屏幕外的窗口拿回屏幕并置前。 */
  async function onscreen(hwnd) {
    const id = parseHwnd(hwnd);
    return enqueue(async () => {
      const res = await sendCommand('ONSCREEN ' + id);
      return { ok: !!(res && res.ok), hwnd: id };
    });
  }

  async function dispose() {
    disposed = true;
    if (pending) rejectPending(new Error('windows capture backend is disposed'));
    const info = child;
    child = null;
    stdoutBuf = '';
    if (info) {
      info.expected = true;
      try { info.proc.stdin.write('EXIT\n'); } catch { }
      try { info.proc.kill(); } catch { }
    }
    // Let queued-but-not-started calls fail fast instead of hanging.
    queueChain = Promise.resolve();
  }

  return { list, capture, info, activate, minimize, offscreen, onscreen, dispose };
}

export default createWindowsCapture;
