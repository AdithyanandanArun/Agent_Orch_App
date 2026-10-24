import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import { AccountConnectionSchema, AccountPreferencesSchema, type AccountConnection, type AccountState, type SavedAccountPreferences } from '@mingle/contracts';
import { HttpError, conflict } from '../util.ts';
import publicConnection from './public-connection.json';
import { AccountVault, AccountVaultError, writePrivateJson } from './vault.ts';
import { DesktopAccountStorage } from './desktop-storage.ts';

interface Attempt { server: Server; state: string; timer: NodeJS.Timeout; consumed: boolean }
const STORAGE_KEY = 'mingle-account-session';

/** A single local user's account client, separate from provider authentication and local workspace authority. */
export class AccountService {
  private client: SupabaseClient | null = null;
  private vault: AccountVault | null = null;
  private readonly desktopStorage = new DesktopAccountStorage();
  private attempt: Attempt | null = null;
  private callbackWork: Promise<void> | null = null;
  private closing = new AbortController();
  private locked = false;
  private mutationInProgress = false;
  private generation = 0;
  private accountOperations = new AbortController();
  private readonly authenticatedOperationContext = new AsyncLocalStorage<{ client: SupabaseClient; generation: number }>();
  private state: AccountState = {
    configured: false, connection: null, configurationSource: 'none', status: 'restoring', user: null,
    sessionStorage: 'memory', error: null, authorizationUrl: null, browserError: null,
  };
  readonly ready: Promise<void>;
  constructor(private readonly dataDir: string, env: NodeJS.ProcessEnv, private readonly changed: () => void) {
    this.ready = this.initialize(env);
  }
  snapshot(): AccountState { return structuredClone(this.state); }
  private notify(patch: Partial<AccountState>) { Object.assign(this.state, patch); this.changed(); }
  private async initialize(env: NodeJS.ProcessEnv) {
    const { key, storage } = await this.desktopStorage.request();
    this.state.storage = storage;
    try { this.vault = new AccountVault(this.dataDir, key, () => this.storageWriteFailed()); }
    catch {
      key?.fill(0);
      this.vault = new AccountVault(this.dataDir, null, () => this.storageWriteFailed());
      this.state.storage = { ...storage, status: 'unavailable', reason: 'session-unreadable', retryable: false };
    }
    this.state.sessionStorage = this.vault.persistent ? 'os-encrypted' : 'memory';
    try {
      let raw: unknown;
      if (env.MINGLE_SUPABASE_URL || env.MINGLE_SUPABASE_PUBLISHABLE_KEY) {
        raw = { url: env.MINGLE_SUPABASE_URL, publishableKey: env.MINGLE_SUPABASE_PUBLISHABLE_KEY };
        this.state.configurationSource = 'environment';
      } else if (existsSync(this.connectionFile)) {
        raw = JSON.parse(readFileSync(this.connectionFile, 'utf8'));
        this.state.configurationSource = 'device';
      } else {
        raw = publicConnection;
        this.state.configurationSource = 'application';
      }
      if (raw) this.connect(AccountConnectionSchema.parse(raw));
      if (this.client) {
        const { data, error } = await this.client.auth.getSession();
        if (error) throw error;
        if (data.session) await this.verifyUser();
      }
    } catch {
      this.state.error = 'Account connection could not be restored. Check the connection and network, then sign in again.';
    } finally {
      this.notify({ status: this.state.user ? 'signed-in' : 'signed-out' });
    }
  }
  private get connectionFile() { return path.join(this.dataDir, 'account-connection.json'); }
  private storageWriteFailed() {
    this.notify({ sessionStorage: 'memory', storage: { status: 'unavailable', backend: this.state.storage?.backend ?? null, reason: 'storage-write-failed', retryable: true } });
  }
  retryStorage(): Promise<AccountState> {
    return this.exclusive(async () => {
      if (this.vault!.persistent) return this.snapshot();
      if (this.state.storage?.reason === 'session-unreadable') return this.snapshot();
      const result = await this.desktopStorage.request();
      if (!result.key) {
        this.notify({ storage: result.storage, sessionStorage: 'memory' });
        return this.snapshot();
      }
      let restored = false;
      try {
        ({ restored } = this.vault!.enablePersistence(result.key, !this.attempt && !this.state.user));
      } catch (error) {
        result.key.fill(0);
        const reason = error instanceof AccountVaultError ? error.reason : 'storage-write-failed';
        this.notify({ sessionStorage: 'memory', storage: { ...result.storage, status: 'unavailable', reason, retryable: reason !== 'session-unreadable' } });
        return this.snapshot();
      }
      this.notify({ storage: result.storage, sessionStorage: 'os-encrypted' });
      if (restored && this.state.connection) {
        // A client initialized with empty memory has already cached a signed-out state.
        // Recreate it only when an explicit retry restores a previously saved account.
        this.client?.auth.stopAutoRefresh();
        this.connect(this.state.connection);
        try {
          const { data, error } = await this.client!.auth.getSession();
          if (error) throw error;
          if (data.session) await this.verifyUser();
          this.notify({ status: this.state.user ? 'signed-in' : 'signed-out', error: null });
        } catch {
          this.notify({ status: 'signed-out', user: null, error: 'Secure storage is ready. The saved account could not be verified; check your connection or sign in again.' });
        }
      }
      return this.snapshot();
    });
  }
  private connect(connection: AccountConnection) {
    this.fenceAccountOperations();
    this.state.connection = { ...connection, url: new URL(connection.url).origin };
    this.state.configured = true;
    this.client = createClient(connection.url, connection.publishableKey, {
      auth: { flowType: 'pkce', detectSessionInUrl: false, persistSession: true, autoRefreshToken: true, storageKey: STORAGE_KEY, storage: this.vault! },
      global: { fetch: (input, init) => {
        const context = this.authenticatedOperationContext.getStore();
        if (context && (this.mutationInProgress || context.generation !== this.generation || context.client !== this.client)) {
          return Promise.reject(conflict('The account changed while this cloud operation was running. Retry with the current account.'));
        }
        return fetch(input, { ...init, signal: AbortSignal.any([this.closing.signal, this.accountOperations.signal, AbortSignal.timeout(15_000), ...(init?.signal ? [init.signal] : [])]) });
      } },
    });
    this.client.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        this.fenceAccountOperations();
        this.notify({ user: null, status: 'signed-out', authorizationUrl: null });
      }
    });
  }
  private fenceAccountOperations() {
    this.generation++;
    this.accountOperations.abort();
    this.accountOperations = new AbortController();
  }
  private async exclusive<T>(work: () => Promise<T>, fenceAccount = false): Promise<T> {
    await this.ready;
    if (this.closing.signal.aborted) throw new HttpError(503, 'Account service is shutting down.');
    if (this.locked) throw conflict('An account operation is in progress. Try again when it finishes.');
    this.locked = true;
    if (fenceAccount) {
      this.mutationInProgress = true;
      this.fenceAccountOperations();
    }
    try { return await work(); } finally {
      this.locked = false;
      if (fenceAccount) this.mutationInProgress = false;
    }
  }
  configure(connection: AccountConnection): Promise<AccountState> {
    return this.exclusive(async () => {
      if (this.state.configurationSource === 'environment') throw conflict('Account connection is configured by the runtime environment.');
      if (this.state.user || this.attempt) throw conflict('Sign out or cancel sign-in before changing the account connection.');
      this.client?.auth.stopAutoRefresh();
      this.vault!.clear();
      writePrivateJson(this.connectionFile, connection);
      this.connect(connection);
      this.notify({ configurationSource: 'device', error: null });
      return this.snapshot();
    }, true);
  }
  private async verifyUser(client: SupabaseClient | null = this.client): Promise<User> {
    if (!client) throw new HttpError(409, 'Configure the Supabase account connection first.');
    const { data, error } = await client.auth.getUser();
    if (error || !data.user || data.user.is_anonymous || !data.user.identities?.some((identity) => identity.provider === 'google')) {
      throw new HttpError(401, 'Google sign-in is required. Sign in again.');
    }
    const user = data.user;
    const name = user.user_metadata?.full_name;
    const verifiedUser = { id: user.id, email: user.email ?? null, name: typeof name === 'string' ? name.slice(0, 200) : null };
    if (this.state.user?.id !== verifiedUser.id || this.state.user.email !== verifiedUser.email || this.state.user.name !== verifiedUser.name) {
      this.notify({ user: verifiedUser });
    }
    return user;
  }
  /**
   * Server-only bridge for account-scoped cloud operations. It verifies the live
   * Supabase user for each call and fences work against sign-in/sign-out so a
   * stale account cannot be used after a local authority change.
   *
   * Keep callback results inside the server. In particular, never serialize the
   * Supabase client, session, access token or refresh token to the renderer.
   */
  async withAuthenticatedClient<T>(callback: (client: SupabaseClient, user: User) => Promise<T>): Promise<T> {
    await this.ready;
    if (this.closing.signal.aborted) throw new HttpError(503, 'Account service is shutting down.');
    if (this.mutationInProgress || this.attempt) throw conflict('An account change is in progress. Try again when it finishes.');
    const client = this.client;
    if (!client) throw new HttpError(409, 'Configure the Supabase account connection first.');
    const generation = this.generation;
    let user: User;
    try {
      user = await this.verifyUser(client);
    } catch (error) {
      this.assertAccountGeneration(client, generation);
      throw error;
    }
    this.assertAccountGeneration(client, generation, user.id);
    let result: T;
    try {
      result = await this.authenticatedOperationContext.run({ client, generation }, () => callback(client, user));
    } catch (error) {
      this.assertAccountGeneration(client, generation, user.id);
      throw error;
    }
    this.assertAccountGeneration(client, generation, user.id);
    return result;
  }
  private assertAccountGeneration(client: SupabaseClient, generation: number, userId?: string) {
    if (this.closing.signal.aborted) throw new HttpError(503, 'Account service is shutting down.');
    if (this.mutationInProgress || this.generation !== generation || this.client !== client) {
      throw conflict('The account changed while this cloud operation was running. Retry with the current account.');
    }
    if (userId && this.state.user?.id !== userId) throw conflict('The signed-in account changed while this cloud operation was running. Retry with the current account.');
    if (this.attempt) throw conflict('An account change is in progress. Try again when it finishes.');
  }
  startSignIn(): Promise<AccountState> {
    return this.exclusive(async () => {
      if (!this.client) throw conflict('Configure the Supabase account connection first.');
      if (this.state.user) throw conflict('Sign out before switching Google accounts.');
      if (this.attempt) throw conflict('Google sign-in is already open.');
      this.notify({ status: 'signing-in', error: null, browserError: null });
      const state = randomBytes(32).toString('hex');
      const callbackPath = `/auth/callback/${state}`;
      const server = createServer((req, res) => {
        const reply = (status: number, message: string) => {
          res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'" });
          res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Mingle sign-in</title><body style="background:#101010;color:#eee;font:16px system-ui;padding:12vh 8vw"><h1>Mingle</h1><p>${message}</p><p>You can close this tab and return to Mingle.</p></body></html>`);
        };
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const attempt = this.attempt;
        if (!attempt || attempt.server !== server || attempt.consumed || req.method !== 'GET' || url.pathname !== callbackPath ||
          req.headers.host !== `127.0.0.1:${(server.address() as AddressInfo | null)?.port}`) return reply(404, 'This sign-in link is no longer active.');
        const codes = url.searchParams.getAll('code');
        if (!url.searchParams.has('error') && (codes.length !== 1 || !codes[0] || codes[0].length > 4096)) return reply(400, 'The sign-in response was incomplete. Please try again.');
        attempt.consumed = true;
        this.callbackWork = (async () => {
          try {
            if (url.searchParams.has('error')) throw new Error('denied');
            const { error } = await this.client!.auth.exchangeCodeForSession(codes[0]!);
            if (error) throw error;
            await this.verifyUser();
            if (this.closing.signal.aborted) throw new Error('closed');
            this.notify({ status: 'signed-in', error: null });
            reply(200, 'You are signed in. Your local workspace is ready.');
          } catch {
            this.notify({ status: 'signed-out', user: null, error: 'Google sign-in did not finish. Check Google provider setup and redirect URLs, then try again.' });
            await this.client!.auth.signOut({ scope: 'local' }).catch(() => undefined);
            this.vault!.clear();
            reply(400, 'Sign-in did not finish. Please try again from Mingle.');
          } finally { this.finishAttempt(); }
        })();
      });
      server.requestTimeout = 20_000;
      server.headersTimeout = 10_000;
      server.on('clientError', (_error, socket) => socket.destroy());
      try {
        const settings = await fetch(`${this.state.connection!.url}/auth/v1/settings`, {
          headers: { apikey: this.state.connection!.publishableKey },
          signal: AbortSignal.any([this.closing.signal, AbortSignal.timeout(15_000)]),
        });
        const authSettings = settings.ok ? await settings.json() as { external?: { google?: boolean } } : null;
        if (authSettings?.external?.google !== true) throw new Error('Google provider is not enabled');
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
        const timer = setTimeout(() => {
          if (this.attempt?.consumed) return;
          this.finishAttempt();
          this.notify({ status: 'signed-out', error: 'Google sign-in timed out. Try again.' });
        }, 5 * 60_000);
        timer.unref();
        this.attempt = { server, state, timer, consumed: false };
        const redirectTo = `http://127.0.0.1:${(server.address() as AddressInfo).port}${callbackPath}`;
        const { data, error } = await this.client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo, skipBrowserRedirect: true, scopes: 'openid email profile', queryParams: { prompt: 'select_account' } } });
        if (error || !data.url) throw new Error('oauth');
        const authorization = new URL(data.url);
        if (authorization.origin !== new URL(this.state.connection!.url).origin || authorization.pathname !== '/auth/v1/authorize' || authorization.searchParams.get('provider') !== 'google' || authorization.searchParams.get('redirect_to') !== redirectTo) throw new Error('invalid authorization URL');
        this.notify({ authorizationUrl: authorization.href });
        await this.openBrowser(authorization.href);
      } catch {
        this.finishAttempt();
        server.close();
        this.notify({ status: 'signed-out', error: 'Could not start Google sign-in. Check the Supabase connection and Google provider configuration.' });
      }
      return this.snapshot();
    }, true);
  }
  private async openBrowser(url: string) {
    const executable = process.platform === 'darwin' ? '/usr/bin/open' : process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe') : 'xdg-open';
    await new Promise<void>((resolve) => {
      const child = spawn(executable, [url], { stdio: 'ignore', detached: true, windowsHide: true });
      const timer = setTimeout(() => resolve(), 2000);
      timer.unref();
      const finish = (failed: boolean) => { clearTimeout(timer); if (failed && this.attempt) this.notify({ browserError: 'The browser could not be opened. Use the sign-in link below.' }); resolve(); };
      child.once('error', () => finish(true));
      child.once('exit', (code) => finish(code !== 0));
      child.unref();
    });
  }
  cancelSignIn(): Promise<AccountState> {
    return this.exclusive(async () => {
      if (this.attempt?.consumed) throw conflict('Sign-in is finishing. Please wait.');
      this.finishAttempt();
      this.notify({ status: this.state.user ? 'signed-in' : 'signed-out', error: null });
      return this.snapshot();
    }, true);
  }
  private finishAttempt() {
    if (this.attempt) { clearTimeout(this.attempt.timer); this.attempt.server.close(); this.attempt.server.closeIdleConnections(); }
    this.attempt = null;
    this.vault?.removeItem(`${STORAGE_KEY}-code-verifier`);
    this.notify({ authorizationUrl: null, browserError: null });
  }
  signOut(): Promise<AccountState> {
    return this.exclusive(async () => {
      if (this.attempt?.consumed) throw conflict('Sign-in is finishing. Please wait.');
      this.finishAttempt();
      const result = await this.client?.auth.signOut({ scope: 'local' }).catch(() => ({ error: true }));
      this.vault!.clear();
      // Recreate the client so even failed remote revocation cannot leave in-memory authority behind.
      this.client?.auth.stopAutoRefresh();
      if (this.state.connection) this.connect(this.state.connection);
      this.notify({ user: null, status: 'signed-out', error: result?.error ? 'Signed out on this device. The server could not confirm remote session revocation.' : null });
      return this.snapshot();
    }, true);
  }
  loadPreferences(): Promise<SavedAccountPreferences | null> {
    return this.exclusive(async () => {
      const user = await this.verifyUser();
      const { data, error } = await this.client!.from('account_preferences').select('preferences,revision,updated_at').eq('user_id', user.id).maybeSingle();
      if (error) throw new HttpError(502, 'Account preferences could not be loaded. Check the network and account database setup.');
      return data ? this.parsePreferences(data) : null;
    });
  }
  savePreferences(preferences: SavedAccountPreferences['preferences'], expectedRevision: number | null): Promise<SavedAccountPreferences> {
    return this.exclusive(async () => {
      const user = await this.verifyUser();
      const payload = { user_id: user.id, preferences: AccountPreferencesSchema.parse(preferences), revision: (expectedRevision ?? 0) + 1 };
      const table = this.client!.from('account_preferences');
      const query = expectedRevision === null ? table.insert(payload) : table.update(payload).eq('user_id', user.id).eq('revision', expectedRevision);
      const { data, error } = await query.select('preferences,revision,updated_at').maybeSingle();
      if (error?.code === '23505' || (!error && !data)) throw conflict('Preferences changed on another device. Reload them before saving again.');
      if (error || !data) throw new HttpError(502, 'Account preferences could not be saved. Check the network and account database setup.');
      return this.parsePreferences(data);
    });
  }
  private parsePreferences(data: Record<string, unknown>): SavedAccountPreferences {
    const parsed = AccountPreferencesSchema.safeParse(data.preferences);
    if (!parsed.success || !Number.isSafeInteger(data.revision) || Number(data.revision) < 1 || typeof data.updated_at !== 'string') throw new HttpError(502, 'Saved preferences use an unsupported format. Update Mingle before restoring them.');
    return { preferences: parsed.data, revision: Number(data.revision), updatedAt: data.updated_at };
  }
  async close() {
    this.closing.abort();
    this.desktopStorage.close();
    await this.ready;
    this.finishAttempt();
    await this.callbackWork;
    this.client?.auth.stopAutoRefresh();
    this.vault?.close();
  }
}
