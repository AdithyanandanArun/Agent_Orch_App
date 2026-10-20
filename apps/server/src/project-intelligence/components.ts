import path from 'node:path';
import type { ProjectContext } from '@mingle/contracts';
import { isSamplePath, readBoundedText } from './fileset.ts';
import type { Budget } from './limits.ts';
import { LIMITS } from './limits.ts';
import { cleanInline } from './extract.ts';

type Component = ProjectContext['components'][number];

interface PackageInfo {
  id: string; name: string; dir: string; ecosystem: 'node' | 'cargo' | 'python' | 'go'; version: string | null;
  /** dependency name → requested spec (node) or relative path (cargo). */
  declared: Map<string, string>;
}

const MANIFESTS = new Set(['package.json', 'Cargo.toml', 'pyproject.toml', 'go.mod']);
const MAX_MANIFEST_DEPTH = 4;
const ROOT_CONFIGS = /^(?:tsconfig(?:\.[\w-]+)?\.json|vite\.config\.\w+|vitest\.config\.\w+|webpack\.config\.\w+|eslint\.config\.\w+|\.eslintrc(?:\.\w+)?|Dockerfile|docker-compose\.ya?ml|compose\.ya?ml|Makefile|pnpm-workspace\.yaml|turbo\.json|nx\.json|justfile)$/;

const dirOf = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const dirComponentId = (dir: string) => `directory:${dir}`;
const packageId = (dir: string) => `package:${dir || '.'}`;

function parsePackageJson(text: string, dir: string): PackageInfo | null {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return null; }
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  const name = typeof record.name === 'string' && record.name ? record.name : path.posix.basename(dir) || 'package';
  const declared = new Map<string, string>();
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const entries = record[section];
    if (!entries || typeof entries !== 'object') continue;
    for (const [dep, spec] of Object.entries(entries as Record<string, unknown>)) if (typeof spec === 'string' && !declared.has(dep)) declared.set(dep, spec);
  }
  return { id: packageId(dir), name: cleanInline(name, 120), dir, ecosystem: 'node', version: typeof record.version === 'string' ? record.version : null, declared };
}

function parseCargo(text: string, dir: string): PackageInfo | null {
  let section = '';
  let name: string | null = null;
  let version: string | null = null;
  const declared = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) { section = header[1]!.trim(); continue; }
    if (section === 'package') {
      const field = /^(name|version)\s*=\s*"([^"]+)"/.exec(line);
      if (field?.[1] === 'name') name = field[2]!;
      else if (field?.[1] === 'version') version = field[2]!;
    } else if (/(^|\.)(dev-|build-)?dependencies$/.test(section)) {
      const dep = /^([\w-]+)\s*=\s*\{[^}]*\bpath\s*=\s*"([^"]+)"/.exec(line);
      if (dep) declared.set(dep[1]!, dep[2]!);
    }
  }
  if (!name) return null;
  return { id: packageId(dir), name: cleanInline(name, 120), dir, ecosystem: 'cargo', version, declared };
}

function parsePyproject(text: string, dir: string): PackageInfo | null {
  let inProject = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^\[.+\]$/.test(line)) { inProject = line === '[project]' || line === '[tool.poetry]'; continue; }
    const match = inProject ? /^name\s*=\s*"([^"]+)"/.exec(line) : null;
    if (match) return { id: packageId(dir), name: cleanInline(match[1]!, 120), dir, ecosystem: 'python', version: null, declared: new Map() };
  }
  return null;
}

function parseGoMod(text: string, dir: string): PackageInfo | null {
  const match = /^module\s+(\S+)/m.exec(text);
  return match ? { id: packageId(dir), name: cleanInline(match[1]!, 120), dir, ecosystem: 'go', version: null, declared: new Map() } : null;
}

/** Whether a package.json dependency spec demonstrably resolves to the local package (not a registry package of the same name). */
function resolvesLocally(spec: string, local: PackageInfo): boolean {
  if (/^(workspace|file|link|portal):/.test(spec)) return true;
  if (!local.version) return false;
  const requested = spec.trim().replace(/^[\^~=v\s]+/, '');
  const wanted = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(requested);
  const have = /^(\d+)\.(\d+)\.(\d+)/.exec(local.version);
  if (!wanted || !have) return false;
  if (spec.startsWith('^')) return wanted[1] === have[1] && (wanted[1] !== '0' || wanted[2] === undefined || wanted[2] === have[2]);
  if (spec.startsWith('~')) return wanted[1] === have[1] && (wanted[2] === undefined || wanted[2] === have[2]);
  return wanted[1] === have[1] && (wanted[2] ?? have[2]) === have[2] && (wanted[3] ?? have[3]) === have[3];
}

export interface ComponentAnalysis { components: Component[]; notices: string[]; partial: boolean }

/** Top-level directories, discovered manifests and root configuration as navigable components. Dependencies are only verified local packages. */
export async function analyseComponents(root: string, files: string[], budget: Budget): Promise<ComponentAnalysis> {
  const notices: string[] = [];
  let partial = false;

  const manifests = files.filter((rel) => MANIFESTS.has(rel.slice(rel.lastIndexOf('/') + 1)) && rel.split('/').length - 1 <= MAX_MANIFEST_DEPTH && !isSamplePath(rel));
  const packages: PackageInfo[] = [];
  let read = 0;
  for (const rel of manifests) {
    if (read >= LIMITS.maxManifests || budget.expired()) { partial = true; break; }
    read++;
    const outcome = await readBoundedText(root, rel, LIMITS.maxManifestBytes);
    if (!('text' in outcome)) continue;
    const dir = dirOf(rel);
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    const info = base === 'package.json' ? parsePackageJson(outcome.text, dir) : base === 'Cargo.toml' ? parseCargo(outcome.text, dir) : base === 'pyproject.toml' ? parsePyproject(outcome.text, dir) : parseGoMod(outcome.text, dir);
    // A directory is represented by one package even when several ecosystems share it (the first manifest wins).
    if (info && !packages.some((existing) => existing.dir === info.dir)) packages.push(info);
  }
  if (manifests.length > LIMITS.maxManifests) notices.push(`Only the first ${LIMITS.maxManifests} package manifests were read.`);

  const byNodeName = new Map(packages.filter((p) => p.ecosystem === 'node').map((p) => [p.name, p]));
  const byCargoDir = new Map(packages.filter((p) => p.ecosystem === 'cargo').map((p) => [p.dir, p]));
  const countUnder = (dir: string) => (dir ? files.reduce((n, rel) => n + (rel.startsWith(`${dir}/`) ? 1 : 0), 0) : files.length);

  const components: Component[] = [];
  const packageDirs = new Set(packages.map((p) => p.dir));
  for (const info of packages) {
    const dependencies = new Set<string>();
    for (const [dep, spec] of info.declared) {
      if (info.ecosystem === 'node') {
        const local = byNodeName.get(dep);
        if (local && local.id !== info.id && resolvesLocally(spec, local)) dependencies.add(local.id);
      } else if (info.ecosystem === 'cargo') {
        const target = byCargoDir.get(path.posix.normalize(path.posix.join(info.dir || '.', spec)).replace(/^\.$/, ''));
        if (target && target.id !== info.id) dependencies.add(target.id);
      }
    }
    components.push({ id: info.id, name: info.name, path: info.dir || '.', kind: 'package', fileCount: countUnder(info.dir), dependencies: [...dependencies].sort() });
  }

  const topCounts = new Map<string, number>();
  for (const rel of files) {
    const slash = rel.indexOf('/');
    if (slash > 0) topCounts.set(rel.slice(0, slash), (topCounts.get(rel.slice(0, slash)) ?? 0) + 1);
  }
  for (const [dir, fileCount] of [...topCounts].sort(([a], [b]) => a.localeCompare(b))) {
    if (packageDirs.has(dir) || (dir.startsWith('.') && dir !== '.github')) continue;
    components.push({ id: dir === '.github' ? `config:${dir}` : dirComponentId(dir), name: dir, path: dir, kind: dir === '.github' ? 'config' : 'directory', fileCount, dependencies: [] });
  }
  for (const rel of files) {
    if (!rel.includes('/') && ROOT_CONFIGS.test(rel)) components.push({ id: `config:${rel}`, name: rel, path: rel, kind: 'config', fileCount: 1, dependencies: [] });
  }

  const order = { package: 0, directory: 1, config: 2 } as const;
  components.sort((a, b) => order[a.kind] - order[b.kind] || a.path.localeCompare(b.path));
  if (components.length > LIMITS.maxComponents) {
    notices.push(`Only the first ${LIMITS.maxComponents} of ${components.length} components are listed.`);
    components.length = LIMITS.maxComponents;
    const kept = new Set(components.map((component) => component.id));
    for (const component of components) component.dependencies = component.dependencies.filter((id) => kept.has(id));
  }
  return { components, notices, partial };
}
