/**
 * dsh-live-preview — 命令进程管理。
 *
 * 负责启动开发命令、收集 stdout/stderr、从输出里探测本地 URL、整树停止。
 * 不依赖 shell 之外的任何库。
 */
import { spawn } from 'node:child_process';
import { killTree, normalizeUrl } from './util.js';

/** 从一段文本里嗅探本地服务地址（localhost / 127.0.0.1 / 0.0.0.0 / [::1]）。 */
const URL_PATTERN = /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{2,5})?(?:\/[^\s"'`<>)]*)?)/gi;

export function findLocalUrl(text) {
  if (typeof text !== 'string' || text === '') return null;
  URL_PATTERN.lastIndex = 0;
  let match;
  let found = null;
  while ((match = URL_PATTERN.exec(text)) !== null) {
    let candidate = match[1].replace(/[.,;:!?、。，；：）)】\]】"'`]+$/, '');
    const normalized = normalizeUrl(candidate);
    if (normalized) {
      found = normalized;
      break;
    }
  }
  return found;
}

/**
 * 创建命令运行器。
 * @param {object} options
 * @param {(stream: string, text: string) => void} options.onLog
 * @param {(url: string) => void} options.onUrl
 * @param {() => void} [options.onChange]
 */
export function createRunner({ onLog, onUrl, onChange }) {
  const state = {
    id: null,
    status: 'idle',
    command: null,
    cwd: null,
    pid: null,
    startedAt: null,
    endedAt: null,
    exitCode: null,
    url: null,
  };

  let child = null;
  let stopping = false;
  let runCounter = 0;
  let pendingLine = '';

  const emit = (stream, text) => {
    try {
      onLog(stream, text);
    } catch {
      /* 日志失败不影响运行 */
    }
  };

  function flushLine(extra = '') {
    pendingLine += extra;
    const lines = pendingLine.split(/\r?\n/);
    pendingLine = lines.pop() ?? '';
    for (const line of lines) {
      if (line === '') continue;
      emit('stdout', line);
      const url = findLocalUrl(line);
      if (url) reportUrl(url);
    }
  }

  function reportUrl(url) {
    if (state.url === url) return;
    state.url = url;
    try {
      onUrl(url);
    } catch {
      /* ignore */
    }
  }

  /** 启动一条命令。 */
  async function start({ command, cwd }) {
    if (!command || typeof command !== 'string' || command.trim() === '') {
      throw new Error('启动命令不能为空');
    }
    await stop(true);
    runCounter += 1;
    const id = `r${runCounter}`;
    pendingLine = '';
    stopping = false;
    state.id = id;
    state.status = 'starting';
    state.command = command.trim();
    state.cwd = cwd || process.cwd();
    state.startedAt = Date.now();
    state.endedAt = null;
    state.exitCode = null;
    state.url = null;
    emit('system', `[运行] ${state.command}  (cwd: ${state.cwd})`);
    try {
      child = spawn(state.command, {
        cwd: state.cwd,
        shell: true,
        windowsHide: true,
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', BROWSER: 'none' },
      });
    } catch (error) {
      state.status = 'exited';
      state.endedAt = Date.now();
      throw error;
    }
    child.once('spawn', () => {
      state.pid = child.pid ?? null;
      state.status = 'running';
      emit('system', `[运行] 进程已启动 pid=${state.pid}`);
      onChange?.();
    });
    child.stdout?.on('data', (chunk) => flushLine(chunk.toString('utf8')));
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        if (!line) continue;
        emit('stderr', line);
        const url = findLocalUrl(line);
        if (url) reportUrl(url);
      }
    });
    child.once('error', (error) => {
      state.status = 'exited';
      state.endedAt = Date.now();
      emit('stderr', `[运行] 启动失败: ${error.message}`);
      onChange?.();
    });
    child.once('exit', (code, signal) => {
      if (pendingLine) flushLine('\n');
      state.status = stopping ? 'stopped' : 'exited';
      state.exitCode = code;
      state.endedAt = Date.now();
      state.pid = null;
      emit('system', `[运行] 进程结束 code=${code ?? 'null'}${signal ? ` signal=${signal}` : ''}`);
      child = null;
      onChange?.();
    });
    return { id, pid: child?.pid ?? null, status: state.status, cwd: state.cwd, command: state.command };
  }

  /** 停止当前命令（默认会记录“已停止”）。 */
  async function stop(silent = false) {
    const current = child;
    if (!current) {
      if (state.status === 'running' || state.status === 'starting') {
        state.status = 'idle';
        onChange?.();
      }
      return false;
    }
    stopping = true;
    const pid = current.pid;
    try {
      await killTree(pid);
    } catch {
      /* 已经退出也无所谓 */
    }
    child = null;
    state.status = 'stopped';
    state.endedAt = state.endedAt ?? Date.now();
    if (!silent) emit('system', `[运行] 已停止（pid=${pid ?? '?'}）`);
    onChange?.();
    return true;
  }

  return { state, start, stop };
}
