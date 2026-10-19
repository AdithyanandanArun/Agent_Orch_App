import { BrowserError } from './errors.ts';

export interface Actor { kind: 'agent' | 'human'; id: string }

/**
 * One owner per tab: the human viewer that took control (identified by its stream client id) or, when nobody
 * holds it, the agent. Writes run one at a time in arrival order. Each write remembers the epoch it was admitted
 * in; a hand-off bumps the epoch, so writes queued under the previous owner are rejected instead of running.
 * Reads (snapshots) never go through this queue.
 */
export class TabControl {
  private owner: string | null = null;
  private epoch = 0;
  private changing = false;
  private tail: Promise<unknown> = Promise.resolve();
  private handoffs: Promise<unknown> = Promise.resolve();

  get ownerId(): string | null {
    return this.owner;
  }

  /** Checks that `actor` may write right now. Synchronous so ordering matches the order callers arrive in. */
  authorize(actor: Actor): void {
    if (this.changing) throw new BrowserError(409, 'Control of this tab is changing hands. Wait a moment, take a fresh snapshot and retry.');
    if (actor.kind === 'agent') {
      if (this.owner !== null) throw new BrowserError(409, 'A person is controlling this tab right now, so the agent cannot act on it. Snapshots still work; wait for them to release control.');
      return;
    }
    if (this.owner !== actor.id) throw new BrowserError(403, 'Take control of the tab before sending input.');
  }

  /** Queues a write. The authorization failure surfaces as a rejected promise, never as a synchronous throw. */
  run<T>(actor: Actor, task: () => Promise<T>): Promise<T> {
    try { this.authorize(actor); } catch (error) { return Promise.reject(error); }
    const admittedIn = this.epoch;
    const result = this.tail.then(() => {
      if (this.epoch !== admittedIn) throw new BrowserError(409, 'Control of this tab changed while this action was queued, so it was not run. Take a fresh snapshot and retry.');
      return task();
    });
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** A human takes control. Fails if another person already holds it. */
  take(clientId: string, beforeSwitch?: () => Promise<void>): Promise<void> {
    return this.handoff(() => {
      if (this.owner === clientId) return null;
      if (this.owner !== null) throw new BrowserError(409, 'Another viewer is controlling this tab. They need to release control first.');
      return { next: clientId, beforeSwitch };
    });
  }

  /** Releases control back to the agent. Only the current owner may release. */
  release(clientId: string, beforeSwitch?: () => Promise<void>): Promise<void> {
    return this.handoff(() => {
      if (this.owner === null) return null;
      if (this.owner !== clientId) throw new BrowserError(403, 'Only the viewer that holds control can release it.');
      return { next: null, beforeSwitch };
    });
  }

  /** Releases control if `clientId` holds it; used when a viewer disconnects. */
  releaseIfOwner(clientId: string, beforeSwitch?: () => Promise<void>): Promise<void> {
    return this.handoff(() => (this.owner === clientId ? { next: null, beforeSwitch } : null));
  }

  private handoff(plan: () => { next: string | null; beforeSwitch?: (() => Promise<void>) | undefined } | null): Promise<void> {
    const run = async () => {
      const decision = plan();
      if (!decision) return;
      this.changing = true;
      this.epoch++;
      try {
        await this.tail;
        await decision.beforeSwitch?.().catch(() => undefined);
        this.owner = decision.next;
      } finally {
        this.changing = false;
      }
    };
    const result = this.handoffs.then(run);
    this.handoffs = result.catch(() => undefined);
    return result;
  }
}
