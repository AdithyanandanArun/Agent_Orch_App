import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, chmod, copyFile, cp, mkdir, readdir, readFile, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { dirname, join, relative, resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const pkg = JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8'));
const serverPackage = JSON.parse(await readFile(join(root, 'apps/server/package.json'), 'utf8'));
if (pkg.version !== serverPackage.version) throw new Error('Desktop and server versions must match before packaging.');
const runtime = JSON.parse(await readFile(join(root, 'packaging/node-runtime.json'), 'utf8'));
const target = `${process.platform}-${process.arch}`;
if (target !== 'linux-x64') throw new Error('Desktop release packaging currently supports Linux x86-64 only. Build on a Linux x86-64 machine.');
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(pkg.version)) throw new Error('Desktop version must be a semantic version.');
const name = `relay-workspace-${pkg.version}-${target}`;
const release = join(root, 'release');
const stage = join(release, name);
const cache = join(release, '.cache/node');
const nodeArchive = join(cache, `node-v${runtime.version}-${target}.tar.xz`);
const nodeDir = join(cache, `node-v${runtime.version}-${target}`);
const artifact = join(release, `${name}.tar.gz`);

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolvePromise() : reject(new Error(`${command} failed (${signal ?? code})`)));
  });
}
async function hash(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
async function present(path) { try { await access(path); return true; } catch { return false; } }

await access(join(root, 'apps/web/dist/index.html'));
await mkdir(cache, { recursive: true });
if (!(await present(nodeArchive))) {
  console.log(`Downloading pinned Node ${runtime.version} runtime…`);
  const response = await fetch(runtime[target].url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`Node download failed: HTTP ${response.status}`);
  const temporary = `${nodeArchive}.partial`;
  await writeFile(temporary, Buffer.from(await response.arrayBuffer()));
  if (await hash(temporary) !== runtime[target].sha256) { await rm(temporary); throw new Error('Node archive checksum mismatch.'); }
  await rename(temporary, nodeArchive);
}
if (await hash(nodeArchive) !== runtime[target].sha256) throw new Error('Cached Node archive checksum mismatch. Remove release/.cache/node and retry.');
await rm(nodeDir, { recursive: true, force: true });
await run('tar', ['-xJf', nodeArchive, '-C', cache]);
const node = join(nodeDir, 'bin/node');
const environment = { ...process.env, PATH: `${dirname(node)}${delimiter}${process.env.PATH ?? ''}`, NODE_ENV: 'production' };
delete environment.NODE_OPTIONS;
delete environment.NODE_PATH;
delete environment.ELECTRON_RUN_AS_NODE;

console.log(`Staging Relay ${pkg.version} for ${target}…`);
await rm(stage, { recursive: true, force: true });
const electron = require('electron');
await cp(dirname(electron), stage, { recursive: true, dereference: true });
await rename(join(stage, 'electron'), join(stage, 'relay-workspace'));
await rm(join(stage, 'resources/default_app.asar'), { force: true });
const appDir = join(stage, 'resources/app');
await mkdir(appDir, { recursive: true });
await copyFile(join(root, 'apps/desktop/main.mjs'), join(appDir, 'main.mjs'));
await writeFile(join(appDir, 'package.json'), JSON.stringify({
  name: 'relay-workspace', productName: 'Relay', version: pkg.version, type: 'module', main: 'main.mjs',
}, null, 2) + '\n');
const workspace = join(stage, 'resources/workspace');
const server = join(workspace, 'apps/server');
await mkdir(dirname(server), { recursive: true });
// Deploy from an isolated copy so pnpm's production metadata never changes the developer checkout.
const deployWorkspace = join(release, '.deploy-workspace');
await rm(deployWorkspace, { recursive: true, force: true });
await mkdir(deployWorkspace, { recursive: true });
for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) await copyFile(join(root, file), join(deployWorkspace, file));
for (const project of ['apps/server', 'apps/web', 'apps/desktop', 'packages/contracts']) {
  await mkdir(join(deployWorkspace, project), { recursive: true });
  await copyFile(join(root, project, 'package.json'), join(deployWorkspace, project, 'package.json'));
}
for (const project of ['apps/server', 'packages/contracts']) await cp(join(root, project, 'src'), join(deployWorkspace, project, 'src'), { recursive: true });
try {
  // No source-workspace install is needed: deploy installs the selected production graph directly.
  await run('pnpm', ['--config.verify-deps-before-run=false', '--dir', deployWorkspace, '--filter', '@relay/server', 'deploy', '--legacy', '--prod', server], { env: environment });
} finally { await rm(deployWorkspace, { recursive: true, force: true }); }
// Relay uses separately installed provider CLIs. Do not redistribute the optional native Claude CLI.
const virtualStore = join(server, 'node_modules/.pnpm');
// Legacy deploy hoists a self-reference to its source workspace. Keep that link inside the release.
const selfLink = join(virtualStore, 'node_modules/@relay/server');
await rm(selfLink, { force: true });
await symlink(relative(dirname(selfLink), server), selfLink);
for (const entry of await readdir(virtualStore)) {
  if (entry.startsWith('@anthropic-ai+claude-agent-sdk-linux-')) await rm(join(virtualStore, entry), { recursive: true, force: true });
}
// Remove dependency symlinks to the excluded optional CLI, retaining all JS SDK dependencies.
async function removeBrokenLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      if (!(await present(path))) {
        if (!(await readlink(path)).includes('claude-agent-sdk-linux-')) throw new Error(`Broken runtime dependency link: ${path}`);
        await rm(path);
      } else {
        const resolved = await realpath(path);
        const boundary = resolve(server) + '/';
        if (resolved !== resolve(server) && !resolved.startsWith(boundary)) throw new Error(`Runtime dependency escapes the release directory: ${path}`);
      }
    } else if (entry.isDirectory()) await removeBrokenLinks(path);
  }
}
await removeBrokenLinks(join(server, 'node_modules'));
// Installer bookkeeping and command shims are not runtime inputs and may contain builder paths.
for (const file of ['node_modules/.modules.yaml', 'node_modules/.pnpm-workspace-state-v1.json', 'node_modules/.pnpm/lock.yaml', 'node_modules/.bin', 'node_modules/.pnpm/node_modules/.bin']) {
  await rm(join(server, file), { recursive: true, force: true });
}
// Bundle our TypeScript and shared contracts; native modules and the provider SDK remain external.
await build({
  entryPoints: [join(root, 'apps/server/src/index.ts')], outfile: join(server, 'dist/index.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node26', packages: 'external',
  alias: { '@relay/contracts': join(root, 'packages/contracts/src/index.ts') },
  logLevel: 'info',
});
await rm(join(server, 'src'), { recursive: true, force: true });
await rm(join(server, 'tsconfig.json'), { force: true });
await cp(join(root, 'apps/web/dist'), join(workspace, 'apps/web/dist'), { recursive: true });
await mkdir(join(stage, 'resources/runtime/bin'), { recursive: true });
await copyFile(node, join(stage, 'resources/runtime/bin/node'));
await chmod(join(stage, 'resources/runtime/bin/node'), 0o755);
await copyFile(join(root, 'apps/web/public/relay.svg'), join(stage, 'relay-workspace.svg'));
await writeFile(join(stage, 'relay-workspace.desktop'), `[Desktop Entry]\nType=Application\nName=Relay\nComment=Local workspace for coding agent sessions\nExec=relay-workspace %U\nIcon=relay-workspace\nTerminal=false\nCategories=Development;IDE;\nStartupWMClass=relay-workspace\n`);

const licenses = join(stage, 'resources/licenses');
await mkdir(licenses, { recursive: true });
await copyFile(join(nodeDir, 'LICENSE'), join(licenses, 'Node-LICENSE'));
await copyFile(join(stage, 'LICENSE'), join(licenses, 'Electron-LICENSE'));
await writeFile(join(licenses, 'Relay-NOTICE'), 'Relay source: https://github.com/AdithyanandanArun/Agent_Orch_App\nThe project owner has not selected a license for Relay source code. This package does not grant a new license.\nThird-party components retain their own licenses, reproduced alongside their packages and in this directory.\n');
const inventory = [];
const inventoried = new Set();
async function inventoryPackage(packageDir) {
  const info = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
  const key = `${info.name}@${info.version}`;
  if (inventoried.has(key)) return;
  inventoried.add(key);
  const destination = join(licenses, key.replaceAll('/', '+'));
  const files = (await readdir(packageDir)).filter((file) => /^(licen[cs]e|notice|copying|thirdpartynotices)(\.|$)/i.test(file));
  await mkdir(destination, { recursive: true });
  for (const file of files) await cp(join(packageDir, file), join(destination, file), { recursive: true });
  inventory.push({ name: info.name, version: info.version, license: info.license ?? 'unspecified', files });
}
// Preserve notices for deployed backend dependencies.
for (const versioned of await readdir(virtualStore)) {
  const modules = join(virtualStore, versioned, 'node_modules');
  if (!(await present(modules))) continue;
  const names = [];
  for (const entry of await readdir(modules, { withFileTypes: true })) {
    if (entry.name.startsWith('@') && entry.isDirectory()) for (const child of await readdir(join(modules, entry.name))) names.push(`${entry.name}/${child}`);
    else names.push(entry.name);
  }
  for (const entry of names) {
    const packageDir = join(modules, entry);
    try {
      if (await realpath(packageDir) !== resolve(packageDir)) continue;
      await inventoryPackage(packageDir);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
// The UI bundles its dependency code, so its notices must accompany the binary too.
const visitedFrontend = new Set();
async function resolveDependency(from, name) {
  for (let current = from; ; current = dirname(current)) {
    const candidate = join(current, 'node_modules', name);
    if (await present(join(candidate, 'package.json'))) return realpath(candidate);
    if (current === dirname(current)) return null;
  }
}
async function frontendLicenses(packageDir, includePackage = true) {
  const resolved = await realpath(packageDir);
  if (visitedFrontend.has(resolved)) return;
  visitedFrontend.add(resolved);
  if (includePackage) await inventoryPackage(resolved);
  const info = JSON.parse(await readFile(join(resolved, 'package.json'), 'utf8'));
  for (const [name, optional] of [
    ...Object.keys(info.dependencies ?? {}).map((name) => [name, false]),
    ...Object.keys(info.optionalDependencies ?? {}).map((name) => [name, true]),
  ]) {
    const dependency = await resolveDependency(resolved, name);
    if (dependency) await frontendLicenses(dependency);
    else if (!optional) throw new Error(`Missing frontend dependency for license inventory: ${name}`);
  }
}
await frontendLicenses(join(root, 'apps/web'), false);
await writeFile(join(licenses, 'dependencies.json'), JSON.stringify(inventory.sort((a, b) => a.name.localeCompare(b.name)), null, 2) + '\n');
await writeFile(join(stage, 'resources/build-info.json'), JSON.stringify({ version: pkg.version, target, node: runtime.version, nodeArchiveSha256: runtime[target].sha256, electron: JSON.parse(await readFile(require.resolve('electron/package.json'), 'utf8')).version }, null, 2) + '\n');
// Stable metadata keeps archive ordering, owners and timestamps independent of the build machine.
const epoch = process.env.SOURCE_DATE_EPOCH ?? '0';
if (!/^\d+$/.test(epoch)) throw new Error('SOURCE_DATE_EPOCH must be a nonnegative integer.');
await run('tar', ['--sort=name', `--mtime=@${epoch}`, '--owner=0', '--group=0', '--numeric-owner', '-czf', artifact, '-C', release, name]);
const checksum = await hash(artifact);
await writeFile(`${artifact}.sha256`, `${checksum}  ${name}.tar.gz\n`);
console.log(`Desktop archive: ${artifact}\nSHA256: ${checksum}`);
