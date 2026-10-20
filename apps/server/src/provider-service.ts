import type { AppSettings, Provider, ProviderCatalog, ProviderInfo, ProviderUsage, Session } from '@relay/contracts';
import type { Logger, ProviderRuntime } from './types.ts';
import { errorMessage, redactSecrets, truncate } from './util.ts';
import { providerExecutable, providerName } from './provider-config.ts';

const BOOTSTRAP_WAIT_MS = 4000;
const USAGE_CACHE_MS = 60_000;
const USAGE_REFRESH_MIN_MS = 15_000;
const PROVIDERS: Provider[] = ['codex', 'claude', 'antigravity', 'opencode'];

function placeholder(reason: string): ProviderInfo[] {
  return PROVIDERS.map((id) => ({ id, name: providerName(id), available: false, version: null, executable: null, reason, models: [] }));
}

function completeProviderList(result: ProviderInfo[], reason: string): ProviderInfo[] {
  const byId = new Map(result.map((row) => [row.id, row]));
  return PROVIDERS.map((id) => byId.get(id) ?? {
    id, name: providerName(id), available: false, version: null, executable: null,
    reason: `${providerName(id)} detection did not report this provider. ${reason}`, models: [],
  });
}

/** Caches provider diagnostics; probes check CLI versions, login state and models without inference. */
export class ProviderService {
  private cache: ProviderInfo[] | null = null;
  private inflight: Promise<ProviderInfo[]> | null = null;
  private generation = 0;
  private readonly catalogs = new Map<string, { expires: number; value: ProviderCatalog }>();
  private readonly catalogInflight = new Map<string, Promise<ProviderCatalog>>();
  private readonly usageCache = new Map<string, { receivedAt: number; expires: number; value: ProviderUsage }>();
  private readonly usageInflight = new Map<string, Promise<ProviderUsage>>();

  constructor(private readonly providers: ProviderRuntime, private readonly getSettings: () => AppSettings, private readonly log: Logger,
    private readonly onChange: () => void = () => {}) {}

  private probe(): Promise<ProviderInfo[]> {
    const generation = ++this.generation;
    const promise = this.providers.detectProviders(this.getSettings()).then(
      (detected) => {
        const result = completeProviderList(detected, 'Refresh providers to see current availability.');
        if (generation === this.generation) { this.cache = result; this.onChange(); }
        return result;
      },
      (error) => {
        this.log('error', 'Provider detection failed', error);
        const failed = placeholder(`Provider detection failed: ${errorMessage(error)}`);
        if (generation === this.generation) { this.cache = failed; this.onChange(); }
        return failed;
      },
    ).finally(() => {
      if (this.inflight === promise) this.inflight = null;
    });
    this.inflight = promise;
    return promise;
  }

  /** Starts detection in the background if nothing is cached. */
  warm(): void {
    if (!this.cache && !this.inflight) void this.probe();
  }

  /** Forces a fresh probe (after settings change or explicit refresh). */
  refresh(): Promise<ProviderInfo[]> {
    this.usageCache.clear();
    this.catalogs.clear();
    this.catalogInflight.clear();
    return this.probe();
  }

  invalidate(): void {
    this.cache = null;
    this.catalogs.clear();
    this.catalogInflight.clear();
    this.usageCache.clear();
    this.usageInflight.clear();
    this.generation++;
    this.inflight = null;
    void this.probe();
  }

  async list(): Promise<ProviderInfo[]> {
    if (this.cache) return this.cache;
    return this.inflight ?? this.probe();
  }

  /** For bootstrap: never blocks longer than a few seconds on slow probes. */
  async snapshot(): Promise<ProviderInfo[]> {
    if (this.cache) return this.cache;
    const pending = this.inflight ?? this.probe();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<ProviderInfo[]>((resolve) => { timer = setTimeout(() => resolve(placeholder('Provider detection is still running; refresh to see results.')), BOOTSTRAP_WAIT_MS); timer.unref(); });
    try {
      return await Promise.race([pending, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  cached(): ProviderInfo[] | null {
    return this.cache;
  }

  /** Quota reporting never starts a model turn or redeems earned resets. */
  usage(session: Session, force = false): Promise<ProviderUsage> {
    const settings = this.getSettings();
    const key = JSON.stringify([session.provider, session.model, session.worktreePath, providerExecutable(session.provider, settings)]);
    const now = Date.now();
    const cached = this.usageCache.get(key);
    if (cached && (cached.expires > now && !force || now - cached.receivedAt < USAGE_REFRESH_MIN_MS)) return Promise.resolve(cached.value);
    const inflight = this.usageInflight.get(key);
    if (inflight) return inflight;
    const unavailable = (notice: string): ProviderUsage => ({ provider: session.provider, fetchedAt: new Date().toISOString(),
      status: 'unavailable', plan: null, windows: [], credits: null, resets: null, notices: [notice] });
    if (!this.providers.getUsage) return Promise.resolve(unavailable('This provider runtime does not expose account usage.'));
    const generation = this.generation;
    const pending = Promise.resolve().then(() => this.providers.getUsage!(session, settings)).catch((error) =>
      unavailable(`Usage could not be read: ${truncate(redactSecrets(errorMessage(error)), 400)}`),
    ).then((value) => {
      if (generation === this.generation) {
        if (this.usageCache.size >= 100) this.usageCache.delete(this.usageCache.keys().next().value!);
        const receivedAt = Date.now();
        this.usageCache.set(key, { receivedAt, expires: receivedAt + (value.status === 'unavailable' ? USAGE_REFRESH_MIN_MS : USAGE_CACHE_MS), value });
      }
      return value;
    }).finally(() => { if (this.usageInflight.get(key) === pending) this.usageInflight.delete(key); });
    this.usageInflight.set(key, pending);
    return pending;
  }

  /** Discover commands and skills without submitting a model prompt. Cache briefly per session configuration. */
  catalog(session: Session, force = false): Promise<ProviderCatalog> {
    const settings = this.getSettings();
    const key = JSON.stringify([session.id, session.provider, session.model, session.worktreePath, providerExecutable(session.provider, settings)]);
    const cached = this.catalogs.get(key);
    if (!force && cached && cached.expires > Date.now()) return Promise.resolve(cached.value);
    const inflight = this.catalogInflight.get(key);
    if (inflight) return inflight;
    if (!this.providers.getCatalog) return Promise.resolve({ commands: [], skills: [], warnings: ['This provider runtime does not expose a command or skill catalog.'] });
    const generation = this.generation;
    const pending = this.providers.getCatalog(session, settings).then((value) => {
      if (generation === this.generation) {
        // Bound metadata cache growth as the user opens sessions and changes models.
        if (this.catalogs.size >= 100) this.catalogs.delete(this.catalogs.keys().next().value!);
        this.catalogs.set(key, { value, expires: Date.now() + 30_000 });
      }
      return value;
    }).finally(() => { if (this.catalogInflight.get(key) === pending) this.catalogInflight.delete(key); });
    this.catalogInflight.set(key, pending);
    return pending;
  }
}
