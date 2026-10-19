import type { AppSettings, Provider, ProviderCatalog, ProviderInfo, Session } from '@relay/contracts';
import type { Logger, ProviderRuntime } from './types.ts';
import { errorMessage } from './util.ts';

const BOOTSTRAP_WAIT_MS = 4000;
const PROVIDERS: Array<{ id: Provider; name: string }> = [{ id: 'codex', name: 'Codex' }, { id: 'claude', name: 'Claude' }];

function placeholder(reason: string): ProviderInfo[] {
  return PROVIDERS.map((p) => ({ id: p.id, name: p.name, available: false, version: null, executable: null, reason, models: [] }));
}

/** Caches provider diagnostics; probes check CLI versions, login state and models without inference. */
export class ProviderService {
  private cache: ProviderInfo[] | null = null;
  private inflight: Promise<ProviderInfo[]> | null = null;
  private generation = 0;
  private readonly catalogs = new Map<string, { expires: number; value: ProviderCatalog }>();
  private readonly catalogInflight = new Map<string, Promise<ProviderCatalog>>();

  constructor(private readonly providers: ProviderRuntime, private readonly getSettings: () => AppSettings, private readonly log: Logger,
    private readonly onChange: () => void = () => {}) {}

  private probe(): Promise<ProviderInfo[]> {
    const generation = ++this.generation;
    const promise = this.providers.detectProviders(this.getSettings()).then(
      (result) => {
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
    return this.probe();
  }

  invalidate(): void {
    this.cache = null;
    this.catalogs.clear();
    this.catalogInflight.clear();
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

  /** Discover commands and skills without submitting a model prompt. Cache briefly per session configuration. */
  catalog(session: Session, force = false): Promise<ProviderCatalog> {
    const settings = this.getSettings();
    const key = JSON.stringify([session.id, session.provider, session.model, session.worktreePath, settings.codexExecutable, settings.claudeExecutable]);
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
