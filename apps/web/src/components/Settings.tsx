import { useState } from 'react';
import { CheckCircle2, CircleSlash, RefreshCw } from 'lucide-react';
import type { AppSettings, ProviderInfo } from '@relay/contracts';
import { useRelay } from '../store/store';
import { api, errorMessage } from '../lib/api';
import { Badge, Button, Field, InlineError, ProviderMark } from './ui';

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

export function SettingsPage() {
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
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
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
  const modelKey = settings.defaultProvider === 'codex' ? 'defaultCodexModel' : 'defaultClaudeModel';
  const defaultModel = settings[modelKey];
  const reportedModels = boot.providers.find((p) => p.id === settings.defaultProvider)?.models ?? [];
  const models = reportedModels.some((m) => m.id === defaultModel) ? reportedModels : [{ id: defaultModel, name: defaultModel }, ...reportedModels];
  const disabled = busy !== null;

  return (
    <div className="settings-page" aria-labelledby="settings-title">
      <div className="settings-page__inner">
      <header className="settings-page__head"><h1 id="settings-title">Settings</h1><p>Make this workspace yours.</p></header>
      <div className="settings">
        {error ? <InlineError>{error}</InlineError> : null}
        <section className="sec">
          <header className="sec__head"><h3>New sessions</h3><span className="muted small" role="status">{error ? 'Not saved' : busy && busy !== 'providers' ? 'Saving…' : 'Saves automatically'}</span></header>
          <p className="muted small">New Session opens immediately with these defaults. Existing sessions keep their own choices.</p>
          <Field label="Default provider" htmlFor="st-provider">
            <select id="st-provider" className="select" value={settings.defaultProvider} disabled={disabled}
              onChange={(e) => void update({ defaultProvider: e.target.value as AppSettings['defaultProvider'] }, 'provider')}>
              <option value="codex">Codex</option><option value="claude">Claude</option>
            </select>
          </Field>
          <Field label="Default model" htmlFor="st-model">
            <select id="st-model" className="select" value={defaultModel} disabled={disabled}
              onChange={(e) => void update({ [modelKey]: e.target.value }, 'model')}>
              {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </Field>
          <Field label="Default effort" htmlFor="st-effort">
            <select id="st-effort" className="select" value={settings.defaultEffort} disabled={disabled}
              onChange={(e) => void update({ defaultEffort: e.target.value as AppSettings['defaultEffort'] }, 'effort')}>
              <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
            </select>
          </Field>
        </section>

        <section className="sec">
          <header className="sec__head"><h3>Appearance</h3></header>
          <Field label="Theme" htmlFor="st-theme">
            <select id="st-theme" className="select" value={settings.theme} disabled={disabled}
              onChange={(e) => void update({ theme: e.target.value as AppSettings['theme'] }, 'theme')}>
              <option value="dark">Dark</option><option value="light">Light</option>
            </select>
          </Field>
        </section>

        <details className="settings__advanced">
          <summary>Session permissions and workspace</summary>
          <Field label="Default approval policy" htmlFor="st-policy">
            <select id="st-policy" className="select" value={settings.defaultPolicy} disabled={disabled}
              onChange={(e) => void update({ defaultPolicy: e.target.value as AppSettings['defaultPolicy'] }, 'policy')}>
              <option value="supervised">Supervised</option><option value="balanced">Balanced</option>
            </select>
          </Field>
          <Field label="Default workspace" htmlFor="st-workspace" hint="A worktree keeps edits on a separate branch. Project folder edits the existing checkout directly.">
            <select id="st-workspace" className="select" value={settings.defaultIsolated ? 'worktree' : 'project'} disabled={disabled}
              onChange={(e) => void update({ defaultIsolated: e.target.value === 'worktree' }, 'workspace')}>
              <option value="worktree">Isolated worktree</option><option value="project">Project folder</option>
            </select>
          </Field>
        </details>

        <details className="settings__advanced">
          <summary>Providers and executables</summary>
          <header className="sec__head"><h3>Provider status</h3><Button size="sm" disabled={disabled} busy={busy === 'providers'} onClick={() => void refreshProviders()}><RefreshCw size={13} /> Re-check</Button></header>
          {boot.providers.length === 0 ? <p className="muted small">The server has not reported any providers yet. Use Re-check to probe the Codex and Claude executables.</p> : null}
          {boot.providers.map((p) => <ProviderRow key={p.id} p={p} />)}
          <p className="muted small">Claude uses your local Claude Code login; run <code>claude auth login</code> and Re-check if needed. An <code>ANTHROPIC_API_KEY</code> in the server environment takes precedence and uses API billing. Codex uses <code>codex login</code>. Relay stores no credentials.</p>
          <form className="form" onSubmit={(e) => {
            e.preventDefault();
            void update({ claudeExecutable: claude.trim(), codexExecutable: codex.trim() }, 'paths').then((saved) => { if (saved) void refreshProviders(); });
          }}>
            <Field label="Claude executable" htmlFor="st-claude" hint="Leave empty to let the server choose.">
              <input id="st-claude" className="input input--mono" value={claude} disabled={disabled} onChange={(e) => setClaude(e.target.value)} placeholder="claude" spellCheck={false} />
            </Field>
            <Field label="Codex executable" htmlFor="st-codex" hint="Path or command name for codex.">
              <input id="st-codex" className="input input--mono" value={codex} disabled={disabled} onChange={(e) => setCodex(e.target.value)} placeholder="codex" spellCheck={false} />
            </Field>
            <div><Button type="submit" size="sm" busy={busy === 'paths'} disabled={!pathsDirty || disabled} why={!pathsDirty ? 'No changes' : undefined}>Save and re-check</Button></div>
          </form>
        </details>
      </div>
      </div>
    </div>
  );
}
