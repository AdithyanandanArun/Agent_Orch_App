/**
 * Identity of a browser endpoint independent of how it was reached: the port plus the browser's WebSocket path
 * (which embeds the browser's unique id). `127.0.0.1`, `localhost` and `[::1]` therefore name the same browser.
 * Anything that does not parse falls back to the raw string.
 */
export function canonicalEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    if (url.port && url.pathname.length > 1) return `${url.port}${url.pathname.toLowerCase()}`;
  } catch { /* use the raw value */ }
  return endpoint;
}

/**
 * Tracks which Relay session owns each tab of an externally controlled browser, keyed by the canonical browser
 * endpoint and the native CDP target id, so two sessions attached to the same Chrome never share a tab. Several
 * sessions can create pages concurrently; `beginCreate` lets observers wait until a freshly created page has been claimed.
 */
export class TargetRegistry {
  private readonly claims = new Map<string, string>();
  private readonly creating = new Map<string, number>();
  private readonly waiters = new Map<string, Array<() => void>>();

  private static key(endpoint: string, targetId: string): string {
    return `${canonicalEndpoint(endpoint)}\u0000${targetId}`;
  }

  /** Claims a tab for `sessionId`; false when another session already owns it. */
  claim(endpoint: string, targetId: string, sessionId: string): boolean {
    const key = TargetRegistry.key(endpoint, targetId);
    const owner = this.claims.get(key);
    if (owner !== undefined && owner !== sessionId) return false;
    this.claims.set(key, sessionId);
    return true;
  }

  release(endpoint: string, targetId: string, sessionId: string): void {
    const key = TargetRegistry.key(endpoint, targetId);
    if (this.claims.get(key) === sessionId) this.claims.delete(key);
  }

  releaseSession(sessionId: string): void {
    for (const [key, owner] of this.claims) if (owner === sessionId) this.claims.delete(key);
  }

  /** Marks that a session is about to create a page on `endpoint`; call the returned function once it is claimed. */
  beginCreate(endpoint: string): () => void {
    const id = canonicalEndpoint(endpoint);
    this.creating.set(id, (this.creating.get(id) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const left = (this.creating.get(id) ?? 1) - 1;
      if (left > 0) return void this.creating.set(id, left);
      this.creating.delete(id);
      for (const wake of this.waiters.get(id) ?? []) wake();
      this.waiters.delete(id);
    };
  }

  /** Resolves when no session is in the middle of creating a page on `endpoint` (re-checked after every wake-up). */
  async idle(endpoint: string): Promise<void> {
    const id = canonicalEndpoint(endpoint);
    while (this.creating.has(id)) {
      await new Promise<void>((resolve) => {
        const list = this.waiters.get(id) ?? [];
        list.push(resolve);
        this.waiters.set(id, list);
      });
    }
  }
}
