/** Static-scan bounds. Anything beyond these is reported in ProjectContext.notices rather than silently ignored. */
export const LIMITS = {
  maxFiles: 20_000,
  maxWalkDirs: 4_000,
  maxWalkDepth: 12,
  maxDocs: 30,
  maxDocBytes: 256 * 1024,
  maxSourceFiles: 400,
  maxSourceBytes: 200 * 1024,
  maxSourceTotalBytes: 6 * 1024 * 1024,
  maxManifests: 40,
  maxManifestBytes: 256 * 1024,
  maxComponents: 80,
  maxChangedPaths: 200,
  maxCommits: 12,
  maxRepositoryTasks: 200,
  scanBudgetMs: 10_000,
  periodicIntervalMs: 30_000,
  debounceMs: 800,
} as const;

/** Directory names never entered: dependency, build output, cache and tooling state. */
export const EXCLUDED_DIRS = new Set([
  'node_modules', 'vendor', 'third_party', 'third-party', 'bower_components', 'dist', 'build', 'out', 'target', '.next', '.nuxt', '.svelte-kit',
  '.output', 'coverage', '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache', '.gradle', '.idea', '.vscode', 'pods',
  '.terraform', '.cache', '.turbo', '.parcel-cache', '.yarn', '.pnpm-store', 'site-packages', '.mingle', '.relay', '.git',
]);

/** Directories whose contents are examples or test data, so their TODO markers and checklists are not project work. */
export const SAMPLE_DIRS = new Set([
  'fixtures', 'fixture', '__fixtures__', 'testdata', 'test-data', 'examples', 'example', 'samples', 'sample', '__snapshots__', '__mocks__',
  'tests', 'test', '__tests__', 'spec', 'specs', 'e2e', 'mocks',
]);

/** Wall-clock budget shared by one scan; `stop` lets service shutdown end it early. */
export class Budget {
  private readonly deadline: number;
  constructor(ms: number, private readonly stop: () => boolean = () => false) { this.deadline = Date.now() + ms; }
  expired(): boolean { return Date.now() > this.deadline || this.stop(); }
  /** A Git command may use what is left of the budget, but never less than a few seconds or more than its own ceiling. */
  gitTimeout(ceilingMs: number): number { return Math.min(ceilingMs, Math.max(3_000, this.deadline - Date.now())); }
}
