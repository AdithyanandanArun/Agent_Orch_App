import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Explicit native acceptance: uses the current user's keyring with a disposable app identity.
// It writes only example session values, never reads an existing Mingle account/key file,
// and requires an unlocked supported OS keyring. Not part of headless CI.
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const electron = process.argv[2] ? resolve(process.argv[2]) : require('electron');
const scratch = await mkdtemp(join(tmpdir(), 'mingle-native-storage-'));
const userData = join(scratch, 'electron');
const workspace = join(scratch, 'workspace');
await mkdir(workspace);
const moduleUrl = (relative) => JSON.stringify(pathToFileURL(join(root, relative)).href);
const childFile = join(scratch, 'account-child.mjs');
await writeFile(childFile, `
import assert from 'node:assert/strict';
import { DesktopAccountStorage } from ${moduleUrl('apps/server/src/account/desktop-storage.ts')};
import { AccountVault } from ${moduleUrl('apps/server/src/account/vault.ts')};
const storage = new DesktopAccountStorage();
const result = await storage.request();
assert.equal(result.storage.status, 'available', 'Unlock a supported desktop keyring before running this native smoke.');
assert.ok(result.key);
const vault = new AccountVault(${JSON.stringify(workspace)}, result.key);
if (process.argv[2] === 'write') {
  vault.setItem('mingle-account-session', JSON.stringify({access_token:'example-native-access',refresh_token:'example-native-refresh'}));
} else {
  assert.equal(JSON.parse(vault.getItem('mingle-account-session')).refresh_token, 'example-native-refresh');
  vault.clear();
}
console.log('NATIVE_STORAGE_RESULT='+JSON.stringify({phase:process.argv[2],backend:result.storage.backend,persistent:vault.persistent}));
vault.close(); storage.close();
process.disconnect();
`);
await writeFile(join(scratch, 'package.json'), JSON.stringify({ name: 'mingle-storage-verification', version: '1.0.0', type: 'module', main: 'main.mjs' }));
await writeFile(join(scratch, 'main.mjs'), `
import {app,safeStorage} from 'electron';
import {fork} from 'node:child_process';
import {configureLinuxPasswordStore} from ${moduleUrl('apps/desktop/account-storage/linux-backend.mjs')};
import {createAccountKeyManager} from ${moduleUrl('apps/desktop/account-storage/account-key.mjs')};
import {createAccountKeyIpcHandler} from ${moduleUrl('apps/desktop/account-storage/account-key-ipc.mjs')};
app.setName('Mingle Storage Verification');
configureLinuxPasswordStore({app});
app.setPath('userData',${JSON.stringify(userData)});
app.whenReady().then(()=>{
const getAccountKey=createAccountKeyManager({userData:${JSON.stringify(userData)},workspaceDataDir:${JSON.stringify(workspace)},safeStorage});
const environment={...process.env,MINGLE_ACCOUNT_IPC:'1'};
delete environment.ELECTRON_RUN_AS_NODE;delete environment.NODE_OPTIONS;delete environment.NODE_PATH;
const child=fork(${JSON.stringify(childFile)},[process.env.MINGLE_SMOKE_PHASE],{
  execPath:${JSON.stringify(process.execPath)},execArgv:['--import',${JSON.stringify(join(root, 'apps/server/node_modules/tsx/dist/loader.mjs'))}],
  env:environment,stdio:['ignore','pipe','pipe','ipc']
});
child.on('message',createAccountKeyIpcHandler({getAccountKey,send:message=>new Promise((resolve,reject)=>child.send(message,error=>error?reject(error):resolve()))}));
child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
child.on('exit',code=>app.exit(code??1));
child.on('error',()=>app.exit(1));
app.on('before-quit',()=>{if(child.exitCode===null)child.kill('SIGTERM')});
}).catch(()=>app.exit(1));
`);

try {
  for (const phase of ['write', 'restore']) {
    const env = { ...process.env, MINGLE_SMOKE_PHASE: phase };
    delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; delete env.NODE_PATH;
    const result = await new Promise((resolvePromise, reject) => {
      const child = spawn(electron, [scratch], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-10000); });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Native storage smoke timed out; check whether the desktop keyring is locked.')); }, 30_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(`Native storage smoke failed (${code}): ${stderr}`));
        const line = stdout.split('\n').find(value => value.startsWith('NATIVE_STORAGE_RESULT='));
        if (!line) return reject(new Error('Native storage smoke returned no verification result.'));
        resolvePromise(JSON.parse(line.slice('NATIVE_STORAGE_RESULT='.length)));
      });
    });
    assert.equal(result.phase, phase);
    assert.equal(result.persistent, true);
    if (phase === 'write') {
      const encrypted = await readFile(join(workspace, 'account-session.enc'), 'utf8');
      assert.ok(!encrypted.includes('example-native-refresh'));
    }
    console.log(`Native ${phase} passed using ${result.backend ?? 'OS secure storage'} and private parent/child IPC.`);
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
