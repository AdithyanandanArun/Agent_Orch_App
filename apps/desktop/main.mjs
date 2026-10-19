import { app, BrowserWindow, dialog, shell } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = app.isPackaged ? join(process.resourcesPath, 'workspace') : fileURLToPath(new URL('../../', import.meta.url));
const runtimeNode = app.isPackaged ? join(process.resourcesPath, 'runtime/bin/node') : process.env.RELAY_NODE_EXECUTABLE || 'node';
const serverRoot = join(root, 'apps/server');
app.setName('Relay');
if (process.platform === 'linux') {
  app.setDesktopName('relay-workspace.desktop');
  app.commandLine.appendSwitch('class', 'relay-workspace');
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
    throw new Error(app.isPackaged ? 'The installed application is missing its UI files. Reinstall Relay.' : 'Build Relay first with pnpm build, then run pnpm desktop.');
  }
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const userData = app.getPath('userData');
  mkdirSync(userData, { recursive: true, mode: 0o700 });
  // Never inherit another Relay development server's paths, origins or host into the desktop runtime.
  const environment = {
    ...process.env, NODE_ENV: 'production', RELAY_HOST: '127.0.0.1',
    RELAY_PORT: String(port), PORT: String(port), RELAY_DATA_DIR: join(userData, 'workspace'),
    RELAY_WEB_DIST: join(root, 'apps/web/dist'), RELAY_ALLOWED_ORIGINS: '',
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  if (app.isPackaged) environment.PATH = [dirname(runtimeNode), process.env.PATH || '/usr/local/bin:/usr/bin:/bin'].join(delimiter);
  const serverArgs = app.isPackaged ? [join(serverRoot, 'dist/index.mjs')] : ['--import', join(serverRoot, 'node_modules/tsx/dist/loader.mjs'), join(serverRoot, 'src/index.ts')];
  backend = spawn(runtimeNode, serverArgs, {
    cwd: app.isPackaged ? userData : root,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let startupErrors = '';
  backend.stdout.on('data', chunk => process.stdout.write(chunk));
  backend.stderr.on('data', chunk => {
    startupErrors = (startupErrors + chunk.toString()).slice(-4000);
    process.stderr.write(chunk);
  });
  backend.on('error', error => {
    if (!quitting) {
      dialog.showErrorBox('Relay runtime failed', error.message);
      app.quit();
    }
  });
  backend.on('exit', () => {
    if (!quitting && BrowserWindow.getAllWindows().length) {
      dialog.showErrorBox('Relay runtime stopped', 'The local runtime stopped. Restart Relay to reconnect your workspace.');
      app.quit();
    }
  });
  try { await waitForBackend(url); }
  catch (error) { throw new Error(`${error.message}\n${startupErrors}`); }
  const window = new BrowserWindow({
    title: 'Relay', width: 1540, height: 1000, minWidth: 900, minHeight: 620,
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
    dialog.showErrorBox('Could not start Relay', error.message);
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
