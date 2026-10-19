/**
 * Tracks which Relay session owns each tab of an externally controlled browser, keyed by the browser endpoint
 * and the native CDP target id, so two sessions attached to the same Chrome never share a tab. Several sessions
 * can create pages concurrently; `beginCreate` lets observers wait until a freshly created page has been claimed.
 */
export class TargetRegistry {
  private readonly claims = new Map<string, string>();
  private readonly creating = new Map<string, number>();
  private readonly waiters = new Map<string, Array<() => void>>();

  private static key(endpoint: string, targetId: string): string {
    return `${endpoint}\u0000${targetId}`;
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
    this.creating.set(endpoint, (this.creating.get(endpoint) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const left = (this.creating.get(endpoint) ?? 1) - 1;
      if (left > 0) return void this.creating.set(endpoint, left);
      this.creating.delete(endpoint);
      for (const wake of this.waiters.get(endpoint) ?? []) wake();
      this.waiters.delete(endpoint);
    };
  }

  /** Resolves when no session is in the middle of creating a page on `endpoint`. */
  idle(endpoint: string): Promise<void> {
    if (!this.creating.has(endpoint)) return Promise.resolve();
    return new Promise((resolve) => {
      const list = this.waiters.get(endpoint) ?? [];
      list.push(resolve);
      this.waiters.set(endpoint, list);
    });
  }
}
