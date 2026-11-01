/**
 * dsh-live-preview — Host 通用工具。
 *
 * 无第三方依赖：日志环形缓冲、JSON 响应、请求体读取、进程树终止、URL 归一化、
 * 窗口置前（一次性 PowerShell，不属于窗口捕获后端）。
 */
import { spawn } from 'node:child_process';

/** 简单环形日志：保留最近 max 行，按自增 seq 增量读取。 */
export class RingLog {
  constructor(max = 3000) {
    this.max = max;
    this.entries = [];
    this.seq = 0;
  }

  /** 追加一行（超长行截断，防止日志面板被单行撑爆）。 */
  push(stream, text) {
    const value = String(text ?? '').replace(/\r$/, '');
    if (value === '') return;
    const clipped = value.length > 4000 ? `${value.slice(0, 4000)} …` : value;
    this.seq += 1;
    this.entries.push({ seq: this.seq, t: Date.now(), stream, text: clipped });
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
  }

  /** 取 seq 之后的增量。 */
  since(seq) {
    const from = Number(seq) || 0;
    return this.entries.filter((entry) => entry.seq > from);
  }

  /** 取最后 n 行。 */
  tail(n = 300) {
    return this.entries.slice(-Math.max(1, Math.min(n, this.max)));
  }

  get nextSeq() {
    return this.seq;
  }
}

/** 写 JSON 响应。 */
export function writeJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** 读请求体（上限 1 MiB），返回字符串。 */
export function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

/** 是否本机回环请求（与 DSH 其他插件一致：预览接口只服务本机页面）。 */
export function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** 把 0.0.0.0 / [::] 这类监听地址归一化成浏览器可访问的回环地址。 */
export function normalizeUrl(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1';
    if (url.hostname === '[::]' || url.hostname === '::') url.hostname = '127.0.0.1';
    return url.toString();
  } catch {
    return null;
  }
}

/** 终极大招：按 pid 杀整棵进程树（Windows 用 taskkill，其他平台用进程组）。 */
export function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) {
      resolve(false);
      return;
    }
    try {
      if (process.platform === 'win32') {
        const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        child.once('exit', () => resolve(true));
        child.once('error', () => resolve(false));
      } else {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          process.kill(pid, 'SIGKILL');
        }
        resolve(true);
      }
    } catch {
      resolve(false);
    }
  });
}

/** 把已知窗口置前（最小化则还原）。一次性 PowerShell，失败只返回 false。 */
export function activateWindow(hwnd) {
  const id = Number(hwnd);
  if (!Number.isFinite(id) || id <= 0) return Promise.resolve(false);
  const script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DshWin32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
}
'@
$h = [IntPtr]${id}
if ([DshWin32]::IsIconic($h)) { [void][DshWin32]::ShowWindow($h, 9) }
[void][DshWin32]::BringWindowToTop($h)
if ([DshWin32]::SetForegroundWindow($h)) { 'OK' } else { 'FAIL' }
`;
  return new Promise((resolve) => {
    try {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let out = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.once('error', () => resolve(false));
      child.once('exit', () => resolve(out.includes('OK')));
    } catch {
      resolve(false);
    }
  });
}

/** 安全地取错误消息。 */
export function errorMessage(error) {
  if (!error) return '未知错误';
  if (typeof error === 'string') return error;
  if (error.message) return String(error.message);
  return String(error);
}

/** 极简 sleep。 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
