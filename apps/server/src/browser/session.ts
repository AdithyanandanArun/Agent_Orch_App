import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { AppSettings, BrowserSessionState, BrowserTab } from '@relay/contracts';
import type { Logger } from '../types.ts';
import { truncate } from '../util.ts';
import { refreshViewport, runAction } from './actions.ts';
import type { Actor } from './control.ts';
import { BrowserError, toBrowserError, withTimeout } from './errors.ts';
import {
  CONNECT_TIMEOUT_MS, DEFAULT_VIEWPORT, DETACH_TIMEOUT_MS, LAUNCH_TIMEOUT_MS, MAX_DIALOG_MESSAGE, MAX_NOTICES, MAX_TABS_GLOBAL, MAX_TABS_PER_SESSION,
} from './limits.ts';
import { diagnoseConnectError, diagnoseLaunchError, loadPlaywright, resolveManagedExecutable } from './playwright.ts';
import type { Browser, BrowserContext, Page } from './playwright.ts';
import { TabEntry } from './tab.ts';
import type { TargetRegistry } from './targets.ts';
import { isEligibleTabUrl, normalizeNavigationUrl } from './url-policy.ts';
import type { BrowserAction } from '@relay/contracts';

export interface ExistingTarget {
  wsUrl: string;
  /** Where the endpoint came from; only changes the wording of connection errors. */
  kind: 'source' | 'endpoint';
  label: string;
}

export interface SessionDeps {
  sessionId: string;
  dataDir: string;
  getSettings: () => AppSettings;
  notify: () => void;
  targets: TargetRegistry;
  /** Tabs tracked across all sessions, for the global limit. */
  totalTabs: () => number;
  log: Logger;
}

type Mode = 'managed' | 'existing';

/** One Relay session's browser: a private Chromium it launched, or a user-approved attachment to an existing one. */
export class BrowserSessionRuntime {
  private status: BrowserSessionState['status'] = 'disconnected';
  private mode: Mode | null = null;
  private error: string | null = null;
  private notices: string[] = [];
  private skippedForLimit = 0;
  private skippedOwned = 0;
  private activeTabId: string | null = null;
  private readonly tabs = new Map<string, TabEntry>();
  private readonly pages = new Map<Page, TabEntry>();
  private readonly adopting = new Map<Page, Promise<TabEntry | null>>();
  private readonly watched = new WeakSet<Page>();
  private context: BrowserContext | null = null;
  private browser: Browser | null = null;
  private endpoint: string | null = null;
  private generation = 0;
  private connecting: Promise<void> | null = null;
  private localCreates = 0;

  constructor(private readonly deps: SessionDeps) {}

  get tabCount(): number {
    return this.tabs.size;
  }

  get isConnected(): boolean {
    return this.status === 'connected';
  }

  state(): BrowserSessionState {
    const notices = [...this.notices];
    if (this.skippedForLimit) notices.push(`${this.skippedForLimit} open tab(s) were not shared because of the tab limit (${MAX_TABS_PER_SESSION} per session, ${MAX_TABS_GLOBAL} overall).`);
    if (this.skippedOwned) notices.push(`${this.skippedOwned} open tab(s) are already used by another Relay session and were skipped.`);
    return {
      sessionId: this.deps.sessionId, status: this.status, mode: this.mode, tabs: [...this.tabs.values()].map((tab) => tab.describe()),
      activeTabId: this.activeTabId, error: this.error, notices,
    };
  }

  tab(tabId: string): TabEntry | null {
    return this.tabs.get(tabId) ?? null;
  }

  requireTab(tabId: string): TabEntry {
    const entry = this.tabs.get(tabId);
    if (!entry) throw new BrowserError(404, 'That tab is not open in this session. Open a tab or take a fresh status.');
    return entry;
  }

  requireConnected(): BrowserContext {
    if (this.status === 'connecting') throw new BrowserError(409, 'The browser is still connecting for this session.');
    if (this.status !== 'connected' || !this.context) throw new BrowserError(409, this.error ?? 'No browser is connected for this session.');
    return this.context;
  }

  /** Connects (or reuses) the session's browser. `prepare` resolves the existing-browser endpoint while status is "connecting". */
  async connect(mode: Mode, prepare: () => Promise<ExistingTarget | null>): Promise<void> {
    if (this.connecting) {
      if (this.mode === mode) return this.connecting;
      throw new BrowserError(409, 'A different browser connection is already in progress for this session.');
    }
    if (this.status === 'connected') {
      if (this.mode === mode) return;
      await this.disconnect();
    }
    const generation = ++this.generation;
    this.status = 'connecting';
    this.mode = mode;
    this.error = null;
    this.notices = [];
    this.skippedForLimit = 0;
    this.skippedOwned = 0;
    this.deps.notify();
    const run = (async () => {
      try {
        const target = await prepare();
        if (mode === 'managed') await this.launchManaged(generation);
        else await this.attachExisting(target!, generation);
        if (generation !== this.generation) throw new BrowserError(409, 'The browser was disconnected while connecting.');
        this.status = 'connected';
      } catch (error) {
        const failure = error instanceof BrowserError ? error : toBrowserError(error);
        if (generation === this.generation) {
          this.generation++;
          await this.teardown(true);
          this.status = 'error';
          this.mode = null;
          this.error = failure.message;
          this.notices = [];
        }
        throw failure;
      } finally {
        this.connecting = null;
        this.deps.notify();
      }
    })();
    this.connecting = run;
    return run;
  }

  /** Detaches from the browser. A managed Chromium is closed; a user's browser is only disconnected, never closed or emptied. */
  async disconnect(): Promise<void> {
    const pending = this.connecting;
    this.generation++;
    await this.teardown(true);
    this.status = 'disconnected';
    this.mode = null;
    this.error = null;
    this.notices = [];
    this.skippedForLimit = 0;
    this.skippedOwned = 0;
    this.deps.notify();
    await pending?.catch(() => undefined);
  }

  async open(url?: string): Promise<BrowserTab> {
    const context = this.requireConnected();
    const target = url ? normalizeNavigationUrl(url) : undefined;
    let entry = [...this.tabs.values()].find((tab) => tab.reusable && tab.page.url() === 'about:blank' && tab.control.ownerId === null && !tab.dialog) ?? null;
    if (!entry) {
      if (this.tabs.size >= MAX_TABS_PER_SESSION) throw new BrowserError(409, `This session already has ${MAX_TABS_PER_SESSION} tabs open. Close one first.`);
      if (this.deps.totalTabs() >= MAX_TABS_GLOBAL) throw new BrowserError(409, `Relay already has ${MAX_TABS_GLOBAL} browser tabs open across sessions. Close one first.`);
      entry = await this.createTab(context);
    }
    this.activeTabId = entry.id;
    if (target && target !== 'about:blank') {
      const tab = entry;
      try { await tab.control.run({ kind: 'agent', id: 'open' }, () => runAction(tab, { type: 'navigate', url: target })); } catch (error) {
        const failure = toBrowserError(error);
        throw new BrowserError(failure.status, `Opened tab ${tab.id}, but loading the page failed: ${failure.message}`);
      }
    }
    this.deps.notify();
    return entry.describe();
  }

  async act(entry: TabEntry, action: BrowserAction, actor: Actor): Promise<unknown> {
    this.requireConnected();
    try {
      return await entry.control.run(actor, () => runAction(entry, action));
    } catch (error) {
      throw toBrowserError(error);
    } finally {
      entry.touch();
      this.deps.notify();
    }
  }

  async takeControl(entry: TabEntry, clientId: string): Promise<void> {
    this.requireConnected();
    await entry.control.take(clientId, () => entry.releaseInput());
    // Only an explicit takeover may raise the tab; merely watching never steals window focus.
    await withTimeout(entry.page.bringToFront(), 3000, 'bringToFront timed out').catch(() => undefined);
    entry.touch();
    this.deps.notify();
  }

  async releaseControl(entry: TabEntry, clientId: string): Promise<void> {
    await entry.control.release(clientId, () => entry.releaseInput());
    entry.touch();
    this.deps.notify();
  }

  /** A stream viewer disconnected: free its control and any pressed mouse buttons. */
  async dropClient(tabId: string, clientId: string): Promise<void> {
    const entry = this.tabs.get(tabId);
    if (!entry) return;
    await entry.control.releaseIfOwner(clientId, () => entry.releaseInput());
    entry.touch();
    this.deps.notify();
  }

  // --- connection ---------------------------------------------------------------------------------------------

  private async launchManaged(generation: number): Promise<void> {
    const executable = await resolveManagedExecutable(this.deps.getSettings().browserExecutable);
    if (executable.problem) throw new BrowserError(400, executable.problem);
    if (!executable.path) throw new BrowserError(503, 'Chromium is not installed. Use "Install Chromium" in the Browser panel or set a browser executable in settings.');
    const playwright = await loadPlaywright();
    const profileDir = path.join(this.deps.dataDir, 'browser', 'profiles', this.deps.sessionId);
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    let context: BrowserContext;
    try {
      context = await playwright.chromium.launchPersistentContext(profileDir, {
        ...(executable.configured ? { executablePath: executable.path } : { channel: 'chromium' }),
        headless: true,
        chromiumSandbox: true,
        viewport: { ...DEFAULT_VIEWPORT },
        acceptDownloads: false,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        timeout: LAUNCH_TIMEOUT_MS,
      });
    } catch (error) {
      throw diagnoseLaunchError(error);
    }
    if (generation !== this.generation) {
      await context.close().catch(() => undefined);
      throw new BrowserError(409, 'The browser was disconnected while connecting.');
    }
    this.context = context;
    context.on('close', () => this.browserGone(generation, 'The browser closed unexpectedly.'));
    context.on('page', (page) => this.onPage(page, generation));
    for (const page of context.pages()) await this.adopt(page, { activate: this.activeTabId === null });
  }

  private async attachExisting(target: ExistingTarget, generation: number): Promise<void> {
    const playwright = await loadPlaywright();
    this.addNotice('Waiting for the browser to accept the connection. If it shows a remote debugging prompt, approve it there.');
    this.deps.notify();
    let browser: Browser;
    try {
      // noDefaults keeps the user's own context untouched (no viewport, download or media overrides).
      browser = await playwright.chromium.connectOverCDP(target.wsUrl, { noDefaults: true, timeout: CONNECT_TIMEOUT_MS, isLocal: true });
    } catch (error) {
      throw diagnoseConnectError(error, target.kind);
    }
    this.notices = [];
    const context = browser.contexts()[0];
    if (generation !== this.generation || !context) {
      await withTimeout(browser.close(), DETACH_TIMEOUT_MS, 'disconnect timed out').catch(() => undefined);
      throw generation !== this.generation
        ? new BrowserError(409, 'The browser was disconnected while connecting.')
        : new BrowserError(409, 'The browser has no default window to attach to. Open a normal browser window and try again.');
    }
    this.browser = browser;
    this.context = context;
    this.endpoint = target.wsUrl;
    this.addNotice(`Connected to ${target.label}. The agent can see and use your open tabs, including pages you are signed in to. Relay never closes your browser; disconnecting only detaches.`);
    browser.on('disconnected', () => this.browserGone(generation, `${target.label} disconnected.`));
    context.on('page', (page) => this.onPage(page, generation));
    for (const page of context.pages()) await this.adopt(page, { activate: this.activeTabId === null });
  }

  private browserGone(generation: number, reason: string): void {
    if (generation !== this.generation) return;
    this.generation++;
    void this.teardown(false).then(() => {
      this.status = 'error';
      this.mode = null;
      this.error = reason;
      this.deps.notify();
    });
  }

  private async teardown(closeBrowser: boolean): Promise<void> {
    const entries = [...this.tabs.values()];
    const { context, browser, mode } = this;
    this.tabs.clear();
    this.pages.clear();
    this.activeTabId = null;
    this.context = null;
    this.browser = null;
    this.endpoint = null;
    await Promise.allSettled(entries.map((entry) => entry.end('The browser was disconnected.')));
    this.deps.targets.releaseSession(this.deps.sessionId);
    if (!closeBrowser) return;
    if (browser) {
      // For a connected (not launched) browser, close() only drops Relay's connection; the user's browser keeps running.
      await withTimeout(browser.close(), DETACH_TIMEOUT_MS, 'disconnect timed out').catch(() => undefined);
    } else if (context && mode === 'managed') {
      await withTimeout(context.close(), 10_000, 'close timed out').catch(() => undefined);
    }
  }

  // --- tabs ----------------------------------------------------------------------------------------------------

  private async createTab(context: BrowserContext): Promise<TabEntry> {
    const release = this.endpoint ? this.deps.targets.beginCreate(this.endpoint) : () => undefined;
    this.localCreates++;
    try {
      const page = await withTimeout(context.newPage(), 15_000, 'Opening a new tab timed out.');
      const entry = await this.adopt(page, { activate: true, created: true });
      if (!entry) {
        await page.close().catch(() => undefined);
        throw new BrowserError(409, 'The new tab could not be tracked, so it was closed.');
      }
      return entry;
    } catch (error) {
      throw toBrowserError(error);
    } finally {
      this.localCreates--;
      release();
      this.rescan();
    }
  }

  private onPage(page: Page, generation: number): void {
    if (generation !== this.generation || this.localCreates > 0) return;
    void this.adopt(page, { activate: this.mode === 'managed' });
  }

  /** Picks up pages that appeared while a local tab creation suppressed page events. */
  private rescan(): void {
    if (!this.context) return;
    for (const page of this.context.pages()) if (!this.pages.has(page) && !this.adopting.has(page)) void this.adopt(page, { activate: false });
  }

  private adopt(page: Page, options: { activate: boolean; created?: boolean }): Promise<TabEntry | null> {
    const known = this.pages.get(page);
    if (known) return Promise.resolve(known);
    const running = this.adopting.get(page);
    if (running) return running;
    const task = this.adoptNow(page, options, this.generation).catch((error: unknown) => {
      this.deps.log('warn', 'Could not adopt a browser tab', error);
      return null;
    }).finally(() => { this.adopting.delete(page); });
    this.adopting.set(page, task);
    return task;
  }

  private async adoptNow(page: Page, options: { activate: boolean; created?: boolean }, generation: number): Promise<TabEntry | null> {
    const live = () => generation === this.generation && !page.isClosed();
    if (!live()) return null;
    if (!isEligibleTabUrl(page.url())) {
      this.watchForEligibility(page, generation);
      return null;
    }
    if (this.tabs.size >= MAX_TABS_PER_SESSION || this.deps.totalTabs() >= MAX_TABS_GLOBAL) {
      if (this.mode === 'managed') {
        await page.close().catch(() => undefined);
        this.addNotice(`A new page was closed because the tab limit (${MAX_TABS_PER_SESSION} per session, ${MAX_TABS_GLOBAL} overall) was reached.`);
      } else {
        this.skippedForLimit++;
      }
      this.deps.notify();
      return null;
    }
    let targetId: string | null = null;
    if (this.mode === 'existing' && this.endpoint) {
      targetId = await this.targetIdOf(page);
      if (!targetId || !live()) return null;
      if (!options.created) await this.deps.targets.idle(this.endpoint);
      if (!live()) return null;
      if (!this.deps.targets.claim(this.endpoint, targetId, this.deps.sessionId)) {
        this.skippedOwned++;
        this.deps.notify();
        return null;
      }
    }
    const entry = new TabEntry(page, this.mode === 'managed', targetId);
    // A blank tab may be recycled by open() only if Relay made it; never one the user already had open.
    entry.reusable = this.mode === 'managed' || options.created === true;
    this.tabs.set(entry.id, entry);
    this.pages.set(page, entry);
    this.wire(entry, generation);
    if (options.activate || !this.activeTabId) this.activeTabId = entry.id;
    void this.refreshTitle(entry);
    void refreshViewport(entry).then(() => { entry.touch(); this.deps.notify(); });
    this.deps.notify();
    return entry;
  }

  private async targetIdOf(page: Page): Promise<string | null> {
    const context = this.context;
    if (!context) return null;
    try {
      const session = await withTimeout(context.newCDPSession(page), 5000, 'Identifying the tab timed out.');
      try {
        const { targetInfo } = await withTimeout(session.send('Target.getTargetInfo'), 5000, 'Identifying the tab timed out.');
        return targetInfo.targetId;
      } finally {
        await session.detach().catch(() => undefined);
      }
    } catch {
      return null;
    }
  }

  /** A tab that is not http(s) yet (a new-tab page, for instance) is adopted once it navigates somewhere eligible. */
  private watchForEligibility(page: Page, generation: number): void {
    if (this.watched.has(page)) return;
    this.watched.add(page);
    const handler = () => {
      if (generation !== this.generation) return void page.off('framenavigated', handler);
      if (!isEligibleTabUrl(page.url())) return;
      page.off('framenavigated', handler);
      this.watched.delete(page);
      void this.adopt(page, { activate: false });
    };
    page.on('framenavigated', handler);
  }

  private wire(entry: TabEntry, generation: number): void {
    const { page } = entry;
    page.on('close', () => this.removeTab(entry, generation));
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      if (entry.dialog) entry.setDialog(null);
      void this.refreshTitle(entry);
      entry.touch();
      this.deps.notify();
    });
    page.on('load', () => { void this.refreshTitle(entry); void refreshViewport(entry).then(() => entry.touch()); });
    page.on('dialog', (dialog) => {
      // Never answered automatically: the dialog stays pending until an explicit dialog action accepts or dismisses it.
      entry.setDialog({ type: dialog.type(), message: truncate(dialog.message(), MAX_DIALOG_MESSAGE), handle: dialog });
      this.deps.notify();
    });
    page.on('crash', () => { this.addNotice('A browser tab crashed. Close it and open it again.'); this.deps.notify(); });
    page.on('download', (download) => {
      if (entry.managed) void download.cancel().catch(() => undefined);
      this.addNotice('Downloads are not supported in Relay\'s shared browser yet; the download was not saved.');
      this.deps.notify();
    });
    // A file chooser listener makes Playwright intercept the native picker, so only a headless (managed) tab gets one.
    if (entry.managed) {
      page.on('filechooser', () => {
        this.addNotice('File uploads are not supported in Relay\'s shared browser yet.');
        this.deps.notify();
      });
    }
  }

  private removeTab(entry: TabEntry, generation: number): void {
    if (generation !== this.generation || !this.tabs.delete(entry.id)) return;
    this.pages.delete(entry.page);
    if (entry.targetId && this.endpoint) this.deps.targets.release(this.endpoint, entry.targetId, this.deps.sessionId);
    void entry.end('The tab was closed.');
    if (this.activeTabId === entry.id) this.activeTabId = [...this.tabs.keys()].at(-1) ?? null;
    this.deps.notify();
  }

  private async refreshTitle(entry: TabEntry): Promise<void> {
    if (entry.dialog) return;
    const title = await withTimeout(entry.page.title(), 2000, 'Reading the title timed out.').catch(() => null);
    if (title === null || title === entry.title) return;
    entry.title = title;
    entry.touch();
    this.deps.notify();
  }

  private addNotice(text: string): void {
    if (this.notices.includes(text)) return;
    this.notices = [...this.notices, text].slice(-MAX_NOTICES);
  }
}
