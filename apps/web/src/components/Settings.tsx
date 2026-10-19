import { useState, type ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import type { AppSettings, ProviderInfo } from '@relay/contracts';
import { useRelay } from '../store/store';
import { api, errorMessage } from '../lib/api';
import { Button, InlineError } from './ui';
import { SelectMenu } from './SelectMenu';

type Category = 'general' | 'providers' | 'appearance';
const CATEGORIES: { id: Category; name: string }[] = [
  { id: 'general', name: 'General' }, { id: 'providers', name: 'Providers' }, { id: 'appearance', name: 'Appearance' },
];

function SettingRow({ title, description, htmlFor, children }: { title: string; description?: string; htmlFor: string; children: ReactNode }) {
  return <div className="settings-row">
    <div className="settings-row__copy"><label htmlFor={htmlFor}>{title}</label>{description ? <p>{description}</p> : null}</div>
    <div className="settings-row__control">{children}</div>
  </div>;
}

function ProviderStatus({ provider }: { provider: ProviderInfo }) {
  return <section className="settings-provider" aria-label={`${provider.name} status`}>
    <div className="settings-provider__head"><h3>{provider.name}</h3><span className={provider.available ? 'settings-provider__state is-ready' : 'settings-provider__state'}><i aria-hidden="true" />{provider.available ? 'Configured' : 'Setup needed'}</span></div>
    <p className="settings-provider__version">{provider.version ? `Version ${provider.version}` : 'Executable not detected'}</p>
    {!provider.available ? <p className="settings-provider__reason">{provider.reason}</p> : null}
    <details className="settings-provider__details"><summary>Connection details</summary><p>{provider.reason ?? 'Authentication and model access are checked when a session runs.'}</p>{provider.executable ? <code>{provider.executable}</code> : null}</details>
  </section>;
}

export function SettingsPage() {
  const boot = useRelay((s) => s.boot);
  const settings = boot?.settings;
  const [category, setCategory] = useState<Category>('general');
  const [claude, setClaude] = useState(settings?.claudeExecutable ?? '');
  const [codex, setCodex] = useState(settings?.codexExecutable ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (!settings || !boot) return null;
  const update = async (patch: Partial<AppSettings>, key: string) => {
    setBusy(key); setError(null);
    try {
      await api.updateSettings(patch);
      await useRelay.getState().refreshNow();
      setSaved(true);
      return true;
    } catch (cause) { setError(errorMessage(cause)); return false; }
    finally { setBusy(null); }
  };
  const refreshProviders = async () => {
    setBusy('providers'); setError(null);
    try { await api.refreshProviders(); await useRelay.getState().refreshNow(); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(null); }
  };
  const disabled = busy !== null;
  const modelKey = settings.defaultProvider === 'codex' ? 'defaultCodexModel' : 'defaultClaudeModel';
  const defaultModel = settings[modelKey];
  const reportedModels = boot.providers.find((p) => p.id === settings.defaultProvider)?.models ?? [];
  const models = reportedModels.some((m) => m.id === defaultModel) ? reportedModels : [{ id: defaultModel, name: defaultModel }, ...reportedModels];
  const pathsDirty = claude.trim() !== settings.claudeExecutable || codex.trim() !== settings.codexExecutable;
  const status = busy === 'providers' ? 'Checking providers…' : busy ? 'Saving…' : error ? 'Could not complete change' : saved ? 'All changes saved' : 'Changes save automatically';

  return <div className="settings-page" aria-labelledby="settings-title">
    <div className="settings-page__inner">
      <header className="settings-page__head"><div><h1 id="settings-title">Settings</h1><p>Models, permissions and appearance.</p></div><span className="settings-page__save" role="status">{status}</span></header>
      <nav className="settings-page__tabs" aria-label="Settings sections">
        {CATEGORIES.map((item) => <button type="button" key={item.id} aria-current={category === item.id ? 'page' : undefined} onClick={() => setCategory(item.id)}>{item.name}</button>)}
      </nav>
      {error ? <InlineError>{error}</InlineError> : null}
      {category === 'general' ? <div className="settings-page__section">
        <div className="settings-page__section-head"><h2>New sessions</h2><p>Defaults for your next session. Existing conversations keep their own settings.</p></div>
        <SettingRow title="Provider" description="The agent used when you start a session." htmlFor="st-provider">
          <SelectMenu id="st-provider" label="Default provider" value={settings.defaultProvider} disabled={disabled} options={[{ value: 'codex', label: 'Codex' }, { value: 'claude', label: 'Claude' }]} onChange={(value) => void update({ defaultProvider: value as AppSettings['defaultProvider'] }, 'provider')} />
        </SettingRow>
        <SettingRow title="Model" description={`Default for ${settings.defaultProvider === 'codex' ? 'Codex' : 'Claude'} sessions.`} htmlFor="st-model">
          <SelectMenu id="st-model" label="Default model" value={defaultModel} disabled={disabled} options={models.map((m) => ({ value: m.id, label: m.name }))} onChange={(value) => void update({ [modelKey]: value }, 'model')} />
        </SettingRow>
        <SettingRow title="Reasoning effort" description="How much reasoning to use for a response." htmlFor="st-effort">
          <SelectMenu id="st-effort" label="Default effort" value={settings.defaultEffort} disabled={disabled} options={[{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }]} onChange={(value) => void update({ defaultEffort: value as AppSettings['defaultEffort'] }, 'effort')} />
        </SettingRow>
        <div className="settings-page__section-head settings-page__section-head--next"><h2>Workspace & permissions</h2></div>
        <SettingRow title="Workspace" description="Use a separate Git worktree, or edit the existing project folder." htmlFor="st-workspace">
          <SelectMenu id="st-workspace" label="Default workspace" value={settings.defaultIsolated ? 'worktree' : 'project'} disabled={disabled} options={[{ value: 'worktree', label: 'Isolated worktree' }, { value: 'project', label: 'Project folder' }]} onChange={(value) => void update({ defaultIsolated: value === 'worktree' }, 'workspace')} />
        </SettingRow>
        <SettingRow title="Approval policy" description="Supervised asks before changes. Balanced allows edits with fewer prompts." htmlFor="st-policy">
          <SelectMenu id="st-policy" label="Default approval policy" value={settings.defaultPolicy} disabled={disabled} options={[{ value: 'supervised', label: 'Supervised' }, { value: 'balanced', label: 'Balanced' }]} onChange={(value) => void update({ defaultPolicy: value as AppSettings['defaultPolicy'] }, 'policy')} />
        </SettingRow>
      </div> : null}
      {category === 'providers' ? <div className="settings-page__section">
        <div className="settings-page__section-head settings-page__section-head--actions"><div><h2>Connected agents</h2><p>Local installations and login status.</p></div><Button size="sm" disabled={disabled} busy={busy === 'providers'} onClick={() => void refreshProviders()}><RefreshCw size={12} /> Re-check</Button></div>
        {boot.providers.map((provider) => <ProviderStatus key={provider.id} provider={provider} />)}
        {!boot.providers.length ? <p className="settings-page__hint">Provider information is loading. Re-check to request a fresh status.</p> : null}
        <div className="settings-page__login"><p>Sign in on this machine with <code>claude auth login</code> or <code>codex login</code>, then re-check.</p><p>Claude uses its existing login. An <code>ANTHROPIC_API_KEY</code> in the server environment takes precedence and uses API billing. Relay stores no credentials.</p></div>
        <details className="settings-page__advanced"><summary>Executable paths</summary><p className="settings-page__hint">Leave empty to use automatic discovery.</p>
          <form className="settings-page__paths" onSubmit={(event) => { event.preventDefault(); void update({ claudeExecutable: claude.trim(), codexExecutable: codex.trim() }, 'paths').then((ok) => { if (ok) void refreshProviders(); }); }}>
            <label htmlFor="st-claude">Claude executable</label><input id="st-claude" className="input input--mono" value={claude} disabled={disabled} onChange={(event) => setClaude(event.target.value)} placeholder="claude" spellCheck={false} />
            <label htmlFor="st-codex">Codex executable</label><input id="st-codex" className="input input--mono" value={codex} disabled={disabled} onChange={(event) => setCodex(event.target.value)} placeholder="codex" spellCheck={false} />
            <div><Button type="submit" size="sm" disabled={!pathsDirty || disabled} busy={busy === 'paths'}>Save paths and re-check</Button></div>
          </form>
        </details>
      </div> : null}
      {category === 'appearance' ? <div className="settings-page__section">
        <div className="settings-page__section-head"><h2>Appearance</h2><p>Simple surfaces, readable text and quiet controls.</p></div>
        <SettingRow title="Theme" description="Choose a dark or light workspace." htmlFor="st-theme">
          <SelectMenu id="st-theme" label="Theme" value={settings.theme} disabled={disabled} options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]} onChange={(value) => void update({ theme: value as AppSettings['theme'] }, 'theme')} />
        </SettingRow>
      </div> : null}
      <footer className="settings-page__foot">Relay {boot.version}<span>Local workspace</span></footer>
    </div>
  </div>;
}
