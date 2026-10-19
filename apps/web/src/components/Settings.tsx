import { useState } from 'react';
import { CheckCircle2, CircleSlash, KeyRound, Moon, RefreshCw, Sun } from 'lucide-react';
import type { AppSettings, Policy, ProviderInfo } from '@relay/contracts';
import { useRelay } from '../store/store';
import { api, errorMessage } from '../lib/api';
import { Badge, Button, Field, InlineError, Modal, ProviderMark, Segmented } from './ui';

const UPCOMING = [
  ['Distributed teams', 'Connect teammates’ machines and sessions over an authenticated channel.'],
  ['Voice control', 'Address a session or the whole team and handle approvals by voice.'],
  ['Shared browser', 'Playwright/CDP-driven previews with explicit control leases.'],
  ['Automatic scheduling', 'Dependency-aware dispatch and integration queues. Today every run is started by you.'],
] as const;

function ProviderRow({ p }: { p: ProviderInfo }) {
  return (
    <div className="prow">
      <ProviderMark provider={p.id} size={22} />
      <div className="prow__main">
        <div className="prow__title"><strong>{p.name}</strong>{p.available ? <Badge tone="ok"><CheckCircle2 size={11} /> Configured</Badge> : <Badge tone="warn"><CircleSlash size={11} /> {p.executable ? 'Setup needed' : 'Not available'}</Badge>}</div>
        <p className="muted small">
          {p.available ? `${p.version ?? 'version unknown'} · ${p.executable ?? 'path unknown'}` : p.reason ?? 'The executable could not be started.'}
        </p>
        {p.available ? <p className="muted small">{p.reason ?? `${p.models.length} models listed. Credentials are validated when a run starts.`}</p> : null}
      </div>
    </div>
  );
}

export function SettingsSheet() {
  const close = useRelay.getState().closeDialog;
  const boot = useRelay((s) => s.boot);
  const settings = boot?.settings;
  const [claude, setClaude] = useState(settings?.claudeExecutable ?? '');
  const [codex, setCodex] = useState(settings?.codexExecutable ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!settings || !boot) return null;

  const update = async (patch: Partial<AppSettings>, key: string) => {
    setBusy(key);
    setError(null);
    try {
      await api.updateSettings(patch);
      await useRelay.getState().refreshNow();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const refreshProviders = async () => {
    setBusy('providers');
    setError(null);
    try {
      await api.refreshProviders();
      await useRelay.getState().refreshNow();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const pathsDirty = claude !== settings.claudeExecutable || codex !== settings.codexExecutable;

  return (
    <Modal variant="sheet" title="Settings" description={`Relay ${boot.version} · local server`} onClose={close}>
      <div className="settings">
        <section className="sec">
          <header className="sec__head"><h3>Providers</h3><Button size="sm" busy={busy === 'providers'} onClick={() => void refreshProviders()}><RefreshCw size={13} /> Re-check</Button></header>
          {boot.providers.length === 0 ? <p className="muted small">The server has not reported any providers yet. Use Re-check to probe the Codex and Claude executables.</p> : null}
          {boot.providers.map((p) => <ProviderRow key={p.id} p={p} />)}
          <div className="note"><KeyRound size={14} />
            <p>Claude uses your existing Claude Code login. Run <code>claude auth login</code> in a terminal on this machine, then Re-check. You can also set <code>ANTHROPIC_API_KEY</code> in the server’s environment; an API key takes precedence and uses API billing. Codex uses its own CLI login. Relay stores no credentials. A configured provider can still return authentication or quota errors when a run starts.</p>
          </div>
          <form className="form" onSubmit={(e) => { e.preventDefault(); void update({ claudeExecutable: claude.trim(), codexExecutable: codex.trim() }, 'paths').then(refreshProviders); }}>
            <Field label="Claude executable" htmlFor="st-claude" hint="Leave empty to let the server choose.">
              <input id="st-claude" className="input input--mono" value={claude} onChange={(e) => setClaude(e.target.value)} placeholder="claude" spellCheck={false} />
            </Field>
            <Field label="Codex executable" htmlFor="st-codex" hint="Path or command name for codex.">
              <input id="st-codex" className="input input--mono" value={codex} onChange={(e) => setCodex(e.target.value)} placeholder="codex" spellCheck={false} />
            </Field>
            <div><Button type="submit" size="sm" variant="primary" busy={busy === 'paths'} disabled={!pathsDirty} why="No changes">Save and re-check</Button></div>
          </form>
        </section>

        <section className="sec">
          <header className="sec__head"><h3>Preferences</h3></header>
          <Field label="Default approval policy" hint="Applied to new sessions; each session keeps the policy it was created with.">
            <Segmented<Policy> label="Default approval policy" value={settings.defaultPolicy} onChange={(v) => void update({ defaultPolicy: v }, 'policy')} options={[{ value: 'supervised', label: 'Supervised' }, { value: 'balanced', label: 'Balanced' }]} />
          </Field>
          <Field label="Theme">
            <Segmented label="Theme" value={settings.theme} onChange={(v) => void update({ theme: v }, 'theme')} options={[{ value: 'dark', label: <><Moon size={13} /> Dark</> }, { value: 'light', label: <><Sun size={13} /> Light</> }]} />
          </Field>
        </section>

        <section className="sec">
          <header className="sec__head"><h3>Not available yet</h3></header>
          <ul className="upcoming">{UPCOMING.map(([t, d]) => <li key={t}><strong>{t}</strong><span>{d}</span><Badge>Planned</Badge></li>)}</ul>
        </section>
        {error ? <InlineError>{error}</InlineError> : null}
      </div>
    </Modal>
  );
}
