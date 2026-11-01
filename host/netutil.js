/**
 * 下载兜底网络工具。
 *
 * 背景：DSH 宿主进程里的 Node fetch（undici）在部分 Windows 网络环境下对
 * dl.google.com 等地址会 UND_ERR_CONNECT_TIMEOUT（IPv6 黑洞 / 系统代理不生效），
 * 而系统自带 curl.exe 可以正常工作。这里提供 curl 兜底下载（带系统代理参数），
 * 让「一键安装安卓模拟器 / ffmpeg」在真实部署环境里更可靠。
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, promises as fsp } from 'node:fs';
import path from 'node:path';

let cachedProxy = undefined;

/** 读取 Windows 系统代理（IE/系统设置），返回 http://host:port 或 null。带缓存。 */
export function getSystemProxy() {
  if (cachedProxy !== undefined) return cachedProxy;
  cachedProxy = null;
  if (process.platform !== 'win32') return cachedProxy;
  try {
    const output = execFileSync(
      'reg.exe',
      [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v',
        'ProxyEnable',
      ],
      { windowsHide: true, encoding: 'utf8', timeout: 3000 },
    );
    if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(output)) return cachedProxy;
    const serverOut = execFileSync(
      'reg.exe',
      [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v',
        'ProxyServer',
      ],
      { windowsHide: true, encoding: 'utf8', timeout: 3000 },
    );
    const match = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(serverOut);
    if (!match) return cachedProxy;
    let server = match[1].trim();
    if (!/^https?:\/\//i.test(server)) server = `http://${server}`;
    cachedProxy = server;
    return cachedProxy;
  } catch {
    return cachedProxy;
  }
}

/** 系统 curl.exe 是否可用。 */
export function hasCurl() {
  return process.platform === 'win32' && existsSync('C:\\Windows\\System32\\curl.exe');
}

/**
 * 用系统 curl.exe 下载到 dest（调用方负责先删掉半成品）。
 * 通过轮询文件大小回报进度（total 未知时为 0）。
 *
 * @param {string} url
 * @param {string} dest
 * @param {{ label?: string, onProgress?: (received:number, total:number) => void, timeoutMs?: number }} [options]
 * @returns {Promise<{ received:number, proxy:string|null }>}
 */
export async function curlDownload(url, dest, options = {}) {
  const { label = 'curl 下载', onProgress, timeoutMs = 30 * 60 * 1000 } = options;
  if (!hasCurl()) throw new Error('系统未找到 curl.exe');
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const proxy = getSystemProxy();
  const args = [
    '-fL', // 失败退出 + 跟随重定向
    '--retry', '3',
    '--retry-delay', '1',
    '--connect-timeout', '20',
    '--max-time', String(Math.max(60, Math.round(timeoutMs / 1000))),
    '-o', dest,
  ];
  if (proxy) args.push('-x', proxy);
  args.push(url);

  return new Promise((resolve, reject) => {
    let stderr = '';
    const child = spawn('curl.exe', args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    const startedAt = Date.now();
    let lastReported = 0;
    const poll = setInterval(async () => {
      try {
        const stat = await fsp.stat(dest);
        if (stat.size !== lastReported) {
          lastReported = stat.size;
          onProgress?.(stat.size, 0);
        }
      } catch {
        /* 文件还没出现 */
      }
      if (Date.now() - startedAt > timeoutMs) {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      }
    }, 500);
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.once('error', (error) => {
      clearInterval(poll);
      reject(new Error(`${label}启动失败：${error.message}`));
    });
    child.once('exit', async (code) => {
      clearInterval(poll);
      if (code !== 0) {
        reject(new Error(`${label}失败（curl exit ${code}）：${stderr.trim() || '无错误输出'}`));
        return;
      }
      try {
        const stat = await fsp.stat(dest);
        if (stat.size <= 0) throw new Error('curl 下载内容为空');
        resolve({ received: stat.size, proxy });
      } catch (error) {
        reject(error);
      }
    });
  });
}
