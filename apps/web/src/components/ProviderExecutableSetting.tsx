import { useEffect, useRef, useState } from 'react';
import type { AppSettings, Provider, ProviderInfo } from '@mingle/contracts';
import { Button } from './ui';
import '../styles/provider-executable.css';

type ExecutableKey = 'claudeExecutable' | 'codexExecutable' | 'antigravityExecutable' | 'opencodeExecutable';
const KEYS: Record<Provider, ExecutableKey> = { claude: 'claudeExecutable', codex: 'codexExecutable', antigravity: 'antigravityExecutable', opencode: 'opencodeExecutable' };
const COMMANDS: Record<Provider, string> = { claude: 'claude', codex: 'codex', antigravity: 'agy_acp_server.par', opencode: 'opencode' };
export const executableSetting = (provider: Provider): ExecutableKey => KEYS[provider];

export function ProviderExecutableSetting({ provider, settings, disabled, onSave }: {
  provider: ProviderInfo; settings: AppSettings; disabled: boolean; onSave: (path: string) => Promise<boolean>;
}) {
  const saved = settings[KEYS[provider.id]] ?? '';
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const previous = useRef(saved);
  useEffect(() => {
    // Installation or another window can change a saved path. Keep any local edit in progress.
    const prior = previous.current;
    setDraft((current) => current.trim() === prior.trim() ? saved : current);
    previous.current = saved;
  }, [saved]);
  const dirty = draft.trim() !== saved;
  const busy = disabled || saving;
  const save = async (value = draft.trim()) => {
    if (busy) return;
    setSaving(true); setSavedNotice(false);
    try {
      if (await onSave(value)) { setDraft(value); setSavedNotice(true); }
    } finally { setSaving(false); }
  };
  const id = `st-${provider.id}`;
  return <form className="provider-executable" onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <label htmlFor={id}>Executable path</label>
    <div className="provider-executable__field">
      <input id={id} className="input input--mono" value={draft} disabled={busy} spellCheck={false} autoComplete="off"
        placeholder={provider.executable ?? COMMANDS[provider.id]} aria-describedby={`${id}-help`}
        onChange={(event) => { setDraft(event.target.value); setSavedNotice(false); }} />
      <Button type="submit" size="sm" disabled={busy || !dirty} busy={saving}>Save path</Button>
    </div>
    <div id={`${id}-help`} className="provider-executable__help">
      <span>{saved ? 'Custom path' : 'Automatic detection'}{provider.executable ? <> · <code>{provider.executable}</code></> : null}</span>
      <span className="provider-executable__status" role="status">{dirty ? 'Unsaved' : savedNotice ? 'Saved' : ''}</span>
    </div>
    <div className="provider-executable__actions">
      {saved || draft.trim() ? <button type="button" className="link-btn" disabled={busy} onClick={() => void save('')}>Use automatic detection</button>
        : provider.executable ? <button type="button" className="link-btn" disabled={busy} onClick={() => { setDraft(provider.executable!); setSavedNotice(false); }}>Use detected path</button> : null}
      {provider.id === 'antigravity' ? <span>Keep the native harness beside this executable.</span> : null}
    </div>
  </form>;
}
