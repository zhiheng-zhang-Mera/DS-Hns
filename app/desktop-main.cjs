const { app, BrowserWindow, dialog, shell } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const HARNESS_URL = 'http://127.0.0.1:3080/';
const DSH_ENTRY = path.join(__dirname, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const STARTUP_TIMEOUT_MS = 90_000;

let mainWindow;
let harnessProcess;
let shuttingDown = false;
let harnessUrl;
let resolveHarnessUrl;
let rejectHarnessUrl;

app.setName('DeepSeek Harness');
app.setPath('userData', path.join(ROOT, 'data', 'desktop-shell'));

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

/**
 * 解析用于启动 Harness 服务的 Node.js 可执行文件，优先级：
 *   1) 环境变量 DSH_NODE_EXE（显式指定，若存在）；
 *   2) 安装根目录 runtime\ 下的自带运行时（如 node-v24.14.1-win-x64\node.exe）；
 *   3) 系统 PATH 中的 node。
 */
function resolveNodeExe() {
  if (process.env.DSH_NODE_EXE && fs.existsSync(process.env.DSH_NODE_EXE)) {
    return process.env.DSH_NODE_EXE;
  }
  const runtimeDir = path.join(ROOT, 'runtime');
  const candidates = [];
  if (fs.existsSync(runtimeDir)) {
    for (const entry of fs.readdirSync(runtimeDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const exe = path.join(runtimeDir, entry.name, 'node.exe');
      if (fs.existsSync(exe)) candidates.push(exe);
    }
  }
  if (candidates.length > 0) {
    candidates.sort(); // 存在多个版本时取目录名排序后的最后一个
    return candidates[candidates.length - 1];
  }
  return 'node'; // 回退到 PATH
}

function ensureRuntimeDirs() {
  fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'temp'), { recursive: true });
}

function requestHarness(url) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: 1_500 }, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 400);
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

async function waitForHarness() {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (harnessUrl && await requestHarness(harnessUrl)) return harnessUrl;
    if (harnessProcess?.exitCode !== null) {
      throw new Error(`Harness 服务提前退出，代码 ${harnessProcess.exitCode}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`Harness 服务在 ${STARTUP_TIMEOUT_MS / 1000} 秒内未就绪`);
}

function startHarness() {
  const urlPromise = new Promise((resolve, reject) => {
    resolveHarnessUrl = resolve;
    rejectHarnessUrl = reject;
  });
  ensureRuntimeDirs();
  const nodeExe = resolveNodeExe();
  harnessProcess = spawn(nodeExe, [DSH_ENTRY, 'web', '--no-open'], {
    cwd: ROOT,
    env: {
      ...process.env,
      DSH_HOME: path.join(ROOT, 'data'),
      npm_config_cache: path.join(ROOT, 'cache', 'npm'),
      TEMP: path.join(ROOT, 'temp'),
      TMP: path.join(ROOT, 'temp'),
      PATH: `${path.dirname(nodeExe)};${process.env.PATH || ''}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const log = fs.createWriteStream(path.join(ROOT, 'logs', 'desktop-runtime.log'), { flags: 'a' });
  harnessProcess.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    const match = text.match(/http:\/\/127\.0\.0\.1:3080\/\?token=[^\s]+/);
    if (match && !harnessUrl) {
      harnessUrl = match[0];
      resolveHarnessUrl(harnessUrl);
    }
    log.write(text.replace(/(\?token=)[^\s]+/g, '$1[REDACTED]'));
  });
  harnessProcess.stderr.on('data', (chunk) => log.write(chunk));
  harnessProcess.once('error', (error) => {
    const hint = error && error.code === 'ENOENT'
      ? `\n[desktop] 找不到可用的 Node.js：请确认 ${path.join(ROOT, 'runtime')} 下存在自带运行时，或将 Node.js 加入 PATH。`
      : '';
    log.write(`\n[desktop] ${error.stack || error}${hint}\n`);
    rejectHarnessUrl(error);
  });
  harnessProcess.once('exit', (code) => {
    if (!harnessUrl) rejectHarnessUrl(new Error(`Harness 服务提前退出，代码 ${code}`));
  });
  return urlPromise;
}

function stopHarness() {
  if (!harnessProcess || harnessProcess.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(harnessProcess.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    harnessProcess.kill('SIGTERM');
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    title: 'DeepSeek Harness',
    backgroundColor: '#0b0f14',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1:3080/')) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('http://127.0.0.1:3080/')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  createWindow();
  try {
    if (await requestHarness(HARNESS_URL)) {
      throw new Error('端口 3080 已被其他 Harness 实例占用，请先关闭旧实例');
    }
    await Promise.race([
      startHarness(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('未收到 Harness 访问令牌')), STARTUP_TIMEOUT_MS)),
    ]);
    const readyUrl = await waitForHarness();
    await mainWindow.loadURL(readyUrl);
  } catch (error) {
    await dialog.showMessageBox({
      type: 'error',
      title: 'DeepSeek Harness 启动失败',
      message: '无法启动本地 Harness 服务',
      detail: String(error.stack || error),
    });
    app.quit();
  }
});

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  if (shuttingDown) return;
  shuttingDown = true;
  stopHarness();
});

process.on('exit', stopHarness);
