import type { AppSettings, Provider, ProviderInfo } from '@relay/contracts';
import type { Logger, ProviderRuntime } from './types.ts';
import { errorMessage } from './util.ts';

const BOOTSTRAP_WAIT_MS = 4000;
const PROVIDERS: Array<{ id: Provider; name: string }> = [{ id: 'codex', name: 'Codex' }, { id: 'claude', name: 'Claude' }];

function placeholder(reason: string): ProviderInfo[] {
  return PROVIDERS.map((p) => ({ id: p.id, name: p.name, available: false, version: null, executable: null, reason, models: [] }));
}

/** Caches provider diagnostics; probing is read-only (version checks), never a model call. */
export class ProviderService {
  private cache: ProviderInfo[] | null = null;
  private inflight: Promise<ProviderInfo[]> | null = null;
  private generation = 0;

  constructor(private readonly providers: ProviderRuntime, private readonly getSettings: () => AppSettings, private readonly log: Logger) {}

  private probe(): Promise<ProviderInfo[]> {
    const generation = ++this.generation;
    const promise = this.providers.detectProviders(this.getSettings()).then(
      (result) => {
        if (generation === this.generation) this.cache = result;
        return result;
      },
      (error) => {
        this.log('error', 'Provider detection failed', error);
        const failed = placeholder(`Provider detection failed: ${errorMessage(error)}`);
        if (generation === this.generation) this.cache = failed;
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
}
