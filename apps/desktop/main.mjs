import { app, BrowserWindow, dialog, shell, safeStorage } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { dirname, delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = app.isPackaged ? join(process.resourcesPath, 'workspace') : fileURLToPath(new URL('../../', import.meta.url));
const serverRoot = join(root, 'apps/server');
app.setName('Mingle');
const mingleUserData = app.getPath('userData');
const legacyUserData = join(dirname(mingleUserData), 'Relay');
const mingleWorkspace = join(mingleUserData, 'workspace');
const legacyWorkspace = join(legacyUserData, 'workspace');
const hasDatabase = (directory) => existsSync(join(directory, 'relay.sqlite'));
// Keep the existing Electron profile together with the workspace it belongs to. If both roots
// have a database, the legacy root wins so an earlier first-launch cannot mask the old workspace.
const userData = hasDatabase(legacyWorkspace) ? legacyUserData
  : hasDatabase(mingleWorkspace) ? mingleUserData
    : existsSync(legacyWorkspace) || existsSync(legacyUserData) ? legacyUserData
      : mingleUserData;
mkdirSync(userData, { recursive: true, mode: 0o700 });
app.setPath('userData', userData);
app.setPath('sessionData', userData);
const runtimeNodeOverride = process.env.MINGLE_NODE_EXECUTABLE !== undefined ? process.env.MINGLE_NODE_EXECUTABLE : process.env.RELAY_NODE_EXECUTABLE;
const runtimeNode = app.isPackaged ? join(process.resourcesPath, 'runtime/bin/node') : runtimeNodeOverride?.trim() || 'node';
if (process.platform === 'linux') {
  app.setDesktopName('mingle.desktop');
  app.commandLine.appendSwitch('class', 'mingle');
}
let backend;
let quitting = false;
let shutdownPending = false;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') return reject(new Error('Could not reserve a local port'));
      probe.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForBackend(url) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (backend?.exitCode !== null) throw new Error('Local runtime exited before it was ready.');
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch { /* The child is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('The local runtime did not become ready within 15 seconds.');
}

async function openWorkspace() {
  if (!existsSync(join(root, 'apps/web/dist/index.html'))) {
    throw new Error(app.isPackaged ? 'The installed application is missing its UI files. Reinstall Mingle.' : 'Build Mingle first with pnpm build, then run pnpm desktop.');
  }
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  mkdirSync(userData, { recursive: true, mode: 0o700 });
  const dataOverride = process.env.MINGLE_DATA_DIR !== undefined ? process.env.MINGLE_DATA_DIR : process.env.RELAY_DATA_DIR;
  const workspaceDataDir = dataOverride?.trim() || join(userData, 'workspace');
  // Refuse Chromium's plaintext fallback. Unsupported/locked keyrings use memory-only sessions.
  let accountKey = null;
  try {
    if (safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || !['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend()))) {
      const scope = createHash('sha256').update(workspaceDataDir).digest('hex').slice(0, 16);
      const keyFile = join(userData, `account-key-${scope}.enc`);
      if (existsSync(keyFile)) accountKey = safeStorage.decryptString(readFileSync(keyFile));
      else {
        accountKey = randomBytes(32).toString('base64');
        const temporary = `${keyFile}.tmp`;
        try { writeFileSync(temporary, safeStorage.encryptString(accountKey), { mode: 0o600, flag: 'wx' }); renameSync(temporary, keyFile); }
        finally { rmSync(temporary, { force: true }); }
      }
    }
  } catch { accountKey = null; }
  // Canonical values override any legacy environment inherited from another local server.
  const environment = {
    ...process.env, NODE_ENV: 'production', MINGLE_HOST: '127.0.0.1',
    MINGLE_PORT: String(port), PORT: String(port), MINGLE_DATA_DIR: workspaceDataDir,
    MINGLE_WEB_DIST: join(root, 'apps/web/dist'), MINGLE_ALLOWED_ORIGINS: '',
    MINGLE_ACCOUNT_IPC: '1',
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  if (app.isPackaged) environment.PATH = [dirname(runtimeNode), process.env.PATH || '/usr/local/bin:/usr/bin:/bin'].join(delimiter);
  const serverArgs = app.isPackaged ? [join(serverRoot, 'dist/index.mjs')] : ['--import', join(serverRoot, 'node_modules/tsx/dist/loader.mjs'), join(serverRoot, 'src/index.ts')];
  backend = spawn(runtimeNode, serverArgs, {
    cwd: app.isPackaged ? userData : root,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const keyReceiver = (message) => {
    if (message?.type !== 'mingle.account-key.request' || !backend?.connected) return;
    backend.off('message', keyReceiver);
    backend.send({ type: 'mingle.account-key', key: accountKey });
    accountKey = null;
  };
  backend.on('message', keyReceiver);
  backend.once('exit', () => { accountKey = null; });
  let startupErrors = '';
  backend.stdout.on('data', chunk => process.stdout.write(chunk));
  backend.stderr.on('data', chunk => {
    startupErrors = (startupErrors + chunk.toString()).slice(-4000);
    process.stderr.write(chunk);
  });
  backend.on('error', error => {
    if (!quitting) {
      dialog.showErrorBox('Mingle runtime failed', error.message);
      app.quit();
    }
  });
  backend.on('exit', () => {
    if (!quitting && BrowserWindow.getAllWindows().length) {
      dialog.showErrorBox('Mingle runtime stopped', 'The local runtime stopped. Restart Mingle to reconnect your workspace.');
      app.quit();
    }
  });
  try { await waitForBackend(url); }
  catch (error) { throw new Error(`${error.message}\n${startupErrors}`); }
  const window = new BrowserWindow({
    title: 'Mingle', icon: app.isPackaged ? join(root, 'apps/web/dist/mingle-icon.png') : join(root, 'apps/web/public/mingle-icon.png'),
    width: 1540, height: 1000, minWidth: 900, minHeight: 620,
    backgroundColor: '#0a0a0a', autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  });
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(target)) void shell.openExternal(target);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin !== url) {
      event.preventDefault();
      if (/^https?:\/\//i.test(target)) void shell.openExternal(target);
    }
  });
  await window.loadURL(url);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window) { if (window.isMinimized()) window.restore(); window.focus(); }
  });
  app.whenReady().then(openWorkspace).catch(error => {
    dialog.showErrorBox('Could not start Mingle', error.message);
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    quitting = true;
    if (backend && backend.exitCode === null) {
      event.preventDefault();
      if (shutdownPending) return;
      shutdownPending = true;
      const child = backend;
      const forceKill = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 38_000);
      child.once('exit', () => {
        clearTimeout(forceKill);
        backend = undefined;
        app.quit();
      });
      child.kill('SIGTERM');
    }
  });
}
