/**
 * dsh-live-preview — DSH webServer 路由。
 *
 * 挂在 DSH 自己的 HTTP 服务上（同源），客户端用相对路径 fetch：
 *   GET  /live-preview/api/state
 *   GET  /live-preview/api/logs?since=N
 *   GET  /live-preview/api/frame?target=desk|android&_=ts
 *   GET  /live-preview/api/health
 *   POST /live-preview/api/action
 */
import { writeJson, readBody, isLoopback, errorMessage } from './util.js';
import { createReadStream, createWriteStream, promises as fsp } from 'node:fs';
import path from 'node:path';

const PREFIX = '/live-preview/api';
const APP_PREFIX = '/live-preview/app';

/** 导入网页包时按扩展名给出 content-type（覆盖常见前端产物）。 */
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8',
};

/** 去掉用户文件名里的路径与危险字符，只保留安全后缀。 */
function safeUploadName(name) {
  const base = path.basename(String(name || 'app.bin')).replace(/[^\w.\-]+/g, '_');
  return base.slice(-140) || 'app.bin';
}

/** 导入的网页包静态文件服务：token 由服务层校验，路径必须落在包目录内。 */
async function serveImportedApp(req, res, service, pathname) {
  if (!isLoopback(req)) {
    writeJson(res, 403, { ok: false, error: '预览接口仅接受本机请求' });
    return;
  }
  const rest = pathname.slice(APP_PREFIX.length).replace(/^\/+/, '');
  const slash = rest.indexOf('/');
  const token = slash === -1 ? rest : rest.slice(0, slash);
  let relative = slash === -1 ? '' : rest.slice(slash + 1);
  try {
    relative = decodeURIComponent(relative);
  } catch {
    writeJson(res, 400, { ok: false, error: '非法的应用路径' });
    return;
  }
  const root = service.webAppRoot(token);
  if (!root) {
    writeJson(res, 404, { ok: false, error: '导入的网页应用不存在或已失效' });
    return;
  }
  const target = path.resolve(root, relative || 'index.html');
  if (target !== root && !target.startsWith(root + path.sep)) {
    writeJson(res, 403, { ok: false, error: '越界路径' });
    return;
  }
  try {
    let stat = await fsp.stat(target);
    if (stat.isDirectory()) {
      const index = path.join(target, 'index.html');
      stat = await fsp.stat(index);
      target = index;
    }
    res.writeHead(200, {
      'content-type': MIME_TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': 'no-store',
    });
    createReadStream(target).pipe(res);
  } catch {
    writeJson(res, 404, { ok: false, error: '文件不存在' });
  }
}

/** 根据 PNG/JPEG 魔数给帧设置正确的 content-type。 */
function frameMediaType(buf) {
  if (!buf || buf.length < 4) return 'application/octet-stream';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  return 'application/octet-stream';
}

/** 当前打开的 MJPEG 连接（限制同时预览，避免解码/带宽浪费；按连接记账，防泄漏）。 */
const activeStreams = new Map();
const MAX_STREAMS = 8;
const STREAM_IDLE_MS = 12000;
let streamSeq = 0;
let streamReaper = null;

/** 回收「socket 看着还活着、但已经很久没成功写帧」的僵尸连接（浏览器丢弃 img 后没触发 close 的情况）。 */
function ensureStreamReaper(service) {
  if (streamReaper) return;
  streamReaper = setInterval(() => {
    const now = Date.now();
    for (const [id, state] of activeStreams) {
      const stale = now - state.lastWrite > STREAM_IDLE_MS;
      const dead = state.res.destroyed || state.res.writableEnded || !state.res.writable || state.closed;
      if (stale || dead) {
        service.logInfo?.(`[串流] 回收${dead ? '已断开' : '空闲'}连接 #${id}（当前 ${activeStreams.size}/${MAX_STREAMS}）`);
        try {
          state.reap();
        } catch {
          /* ignore */
        }
      }
    }
  }, 5000);
  if (streamReaper.unref) streamReaper.unref();
}

/**
 * 把 service 的高清帧源以 multipart/x-mixed-replace 推给浏览器 <img>。
 * 无新帧时每秒重发最后一帧，避免长连接被中间层判定为空闲。
 */
function streamMjpeg(req, res, service) {
  if (service.androidStreamMode() !== 'h264') {
    writeJson(res, 409, { ok: false, error: '高清串流未启动' });
    return;
  }
  if (activeStreams.size >= MAX_STREAMS) {
    // 浏览器对 multipart <img> 的取消并不可靠：热更新/切页可能留下已无人看的僵尸连接。
    // 到上限时回收最旧的一条（它多半已经无人消费），而不是把新预览拒之门外。
    while (activeStreams.size >= MAX_STREAMS) {
      const oldest = Array.from(activeStreams.values()).sort((a, b) => a.id - b.id)[0];
      if (!oldest) break;
      service.logInfo?.(`[串流] 连接数已满（${activeStreams.size}/${MAX_STREAMS}），回收最旧连接 #${oldest.id}`);
      try {
        oldest.reap();
      } catch {
        /* ignore */
      }
      if (activeStreams.has(oldest.id)) activeStreams.delete(oldest.id);
    }
  }
  ensureStreamReaper(service);
  const streamId = ++streamSeq;
  const state = { id: streamId, res, closed: false, lastWrite: Date.now(), reap: () => {} };
  activeStreams.set(streamId, state);
  service.logInfo?.(`[串流] MJPEG 连接打开 #${streamId}（当前 ${activeStreams.size}/${MAX_STREAMS}）`);
  const boundary = 'dshframe';
  res.writeHead(200, {
    'content-type': `multipart/x-mixed-replace; boundary=${boundary}`,
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
  });
  let closed = false;
  let draining = false;
  let lastFrame = null;
  let framesSinceTick = 0;
  let keepAlive = null;
  let unsubscribe = () => {};

  function cleanup() {
    if (closed) {
      return;
    }
    closed = true;
    state.closed = true;
    activeStreams.delete(streamId);
    service.logInfo?.(`[串流] MJPEG 连接关闭 #${streamId}（当前 ${activeStreams.size}/${MAX_STREAMS}）`);
    if (keepAlive) clearInterval(keepAlive);
    try {
      unsubscribe();
    } catch {
      /* ignore */
    }
    try {
      res.end();
    } catch {
      /* ignore */
    }
  }
  state.reap = cleanup;

  const writeImagePart = (frame) => {
    if (closed || draining) return;
    if (res.destroyed || res.writableEnded || !res.writable) {
      cleanup();
      return;
    }
    const head = `--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.data.length}\r\n\r\n`;
    let ok = false;
    try {
      ok = res.write(head) && res.write(frame.data) && res.write('\r\n');
    } catch {
      cleanup();
      return;
    }
    state.lastWrite = Date.now();
    framesSinceTick += 1;
    if (!ok) {
      draining = true;
      res.once('drain', () => {
        draining = false;
        state.lastWrite = Date.now();
      });
    }
  };

  unsubscribe = service.subscribeAndroidFrames((frame) => {
    if (!frame || !frame.data) return;
    lastFrame = frame;
    writeImagePart(frame);
  });

  // 静态画面时 screenrecord 不会立刻出新帧：先把宿主缓存里的最后一帧推给浏览器，
  // 否则刚打开面板会是一片空白（要等用户滚动屏幕才出现画面）。
  try {
    const initial = service.androidFrame ? service.androidFrame() : null;
    if (initial && initial.data && initial.data.length > 0) {
      lastFrame = initial;
      writeImagePart(initial);
    }
  } catch {
    /* 首帧推送失败不影响后续 */
  }

  // 静态画面时 screenrecord 可能长时间不出帧：每秒补发最后一帧保活；
  // 同时借这个定时器回收已经被浏览器丢弃、但没触发 close 的僵尸连接。
  keepAlive = setInterval(() => {
    if (closed) return;
    if (res.destroyed || res.writableEnded || !res.writable) {
      cleanup();
      return;
    }
    if (framesSinceTick === 0 && lastFrame) writeImagePart(lastFrame);
    framesSinceTick = 0;
  }, 1000);

  req.once('close', cleanup);
  req.once('aborted', cleanup);
  res.once('close', cleanup);
  res.once('error', cleanup);
  if (res.socket) {
    res.socket.once('close', cleanup);
    res.socket.once('error', cleanup);
  }
}

/**
 * @param {{ register: Function }} webServer ctx.webServer
 * @param {object} service createPreviewService 的返回值
 * @param {{ version?: string }} [options]
 * @returns {() => void} disposer
 */
export function attachPreviewRoutes(webServer, service, options = {}) {
  const version = options.version ?? '0.1.0';

  const handler = async (req, res) => {
    try {
      if (!isLoopback(req)) {
        writeJson(res, 403, { ok: false, error: '预览接口仅接受本机请求' });
        return;
      }
      const url = new URL(req.url ?? '/', 'http://preview.local');
      const pathname = url.pathname;
      if (!pathname.startsWith(PREFIX)) {
        writeJson(res, 404, { ok: false, error: 'not found' });
        return;
      }
      const route = pathname.slice(PREFIX.length) || '/';

      if (req.method === 'GET' && (route === '/health' || route === '/health/')) {
        writeJson(res, 200, { ok: true, version });
        return;
      }

      if (req.method === 'GET' && (route === '/state' || route === '/state/')) {
        const snapshot = await service.snapshot();
        writeJson(res, 200, snapshot);
        return;
      }

      if (req.method === 'GET' && (route === '/logs' || route === '/logs/')) {
        const since = Number(url.searchParams.get('since') ?? 0);
        const lines = service.logsSince(Number.isFinite(since) ? since : 0);
        writeJson(res, 200, {
          ok: true,
          nextSeq: lines.length > 0 ? lines[lines.length - 1].seq : since,
          lines,
        });
        return;
      }

      if (req.method === 'GET' && (route === '/frame' || route === '/frame/')) {
        const target = url.searchParams.get('target') ?? 'desk';
        let frame = null;
        if (target === 'desk') frame = await service.deskFrame();
        else if (target === 'android') frame = service.androidFrame();
        else {
          writeJson(res, 400, { ok: false, error: `未知 target：${target}` });
          return;
        }
        const data = frame && frame.data ? frame.data : frame;
        if (!data || data.length === 0) {
          res.writeHead(204, { 'cache-control': 'no-store' });
          res.end();
          return;
        }
        res.writeHead(200, {
          'content-type': frameMediaType(data),
          'cache-control': 'no-store',
          'content-length': data.length,
        });
        res.end(data);
        return;
      }

      if (req.method === 'GET' && (route === '/stream' || route === '/stream/')) {
        const target = url.searchParams.get('target') ?? 'android';
        if (target !== 'android') {
          writeJson(res, 400, { ok: false, error: `未知 stream target：${target}` });
          return;
        }
        streamMjpeg(req, res, service);
        return;
      }

      if (req.method === 'POST' && (route === '/import' || route === '/import/')) {
        const original = url.searchParams.get('name') || 'app.bin';
        const sessionId = url.searchParams.get('sessionId') || undefined;
        const safe = safeUploadName(original);
        const dir = path.join(service.config.dataDir, 'imports');
        const destination = path.join(dir, `upload-${Date.now()}-${safe}`);
        try {
          await fsp.mkdir(dir, { recursive: true });
          await new Promise((resolve, reject) => {
            const sink = createWriteStream(destination);
            let settled = false;
            const finish = (error) => {
              if (settled) return;
              settled = true;
              if (error) reject(error);
              else resolve();
            };
            req.on('error', finish);
            req.on('aborted', () => finish(new Error('上传被中断')));
            sink.on('error', finish);
            sink.on('finish', () => finish());
            req.pipe(sink);
          });
          const stat = await fsp.stat(destination);
          if (stat.size <= 0) throw new Error('上传内容为空');
          const result = await service.importAppFile(destination, { name: original, origin: 'upload', sessionId });
          writeJson(res, 200, result);
        } catch (error) {
          writeJson(res, 500, { ok: false, error: errorMessage(error) });
        }
        return;
      }

      if (req.method === 'POST' && (route === '/action' || route === '/action/')) {
        const raw = await readBody(req);
        let payload;
        try {
          payload = raw ? JSON.parse(raw) : {};
        } catch {
          writeJson(res, 400, { ok: false, error: 'JSON 解析失败' });
          return;
        }
        try {
          const result = await service.action(payload);
          writeJson(res, 200, result);
        } catch (error) {
          writeJson(res, 500, { ok: false, error: errorMessage(error) });
        }
        return;
      }

      writeJson(res, 404, { ok: false, error: 'not found' });
    } catch (error) {
      try {
        writeJson(res, 500, { ok: false, error: errorMessage(error) });
      } catch {
        /* 响应可能已经开始 */
      }
    }
  };

  const appHandler = async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://preview.local');
      await serveImportedApp(req, res, service, url.pathname);
    } catch (error) {
      try {
        writeJson(res, 500, { ok: false, error: errorMessage(error) });
      } catch {
        /* ignore */
      }
    }
  };

  const disposeApi = webServer.register({ kind: 'prefix', path: PREFIX, handler });
  const disposeApp = webServer.register({ kind: 'prefix', path: APP_PREFIX, handler: appHandler });
  return () => {
    try {
      disposeApi();
    } catch {
      /* ignore */
    }
    try {
      disposeApp();
    } catch {
      /* ignore */
    }
  };
}
