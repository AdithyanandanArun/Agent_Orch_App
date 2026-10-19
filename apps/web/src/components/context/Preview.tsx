import { useState, type FormEvent } from 'react';
import { ExternalLink, Globe, RefreshCw } from 'lucide-react';
import { Button, EmptyState, IconButton, InlineError } from '../ui';

const KEY = 'relay.preview.url';
const PRESETS = ['http://localhost:3000', 'http://localhost:4173', 'http://localhost:8080'];

/** The preview is for the developer's own local servers only; anything else is refused. */
function normalise(input: string): { url: string } | { error: string } {
  const raw = input.trim();
  if (!raw) return { error: 'Enter a local address such as localhost:3000.' };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  let u: URL;
  try { u = new URL(withScheme); } catch { return { error: 'That does not look like a valid URL.' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'Only http and https addresses can be previewed.' };
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === '::1') return { error: 'Use localhost or 127.0.0.1 for previews. Browser frame policies do not support this IPv6 address.' };
  const local = host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
  if (!local) return { error: 'Preview is limited to local servers (localhost, 127.0.0.1, ::1). External sites are not embedded.' };
  return { url: u.toString() };
}

export function Preview() {
  const [input, setInput] = useState(() => localStorage.getItem(KEY) ?? '');
  const [url, setUrl] = useState<string | null>(() => {
    const saved = localStorage.getItem(KEY);
    const n = saved ? normalise(saved) : null;
    return n && 'url' in n ? n.url : null;
  });
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const go = (value: string) => {
    const n = normalise(value);
    if ('error' in n) { setError(n.error); return; }
    setError(null);
    setUrl(n.url);
    setInput(n.url);
    setNonce((x) => x + 1);
    try { localStorage.setItem(KEY, n.url); } catch { /* ignore */ }
  };
  const submit = (e: FormEvent) => { e.preventDefault(); go(input); };

  return (
    <div className="panel-col">
      <form className="preview__bar" onSubmit={submit}>
        <label htmlFor="preview-url" className="sr-only">Local preview address</label>
        <input id="preview-url" className="input input--mono" value={input} onChange={(e) => setInput(e.target.value)} placeholder="localhost:3000" spellCheck={false} autoComplete="off" />
        <Button type="submit" size="sm" variant="primary">Go</Button>
        <IconButton label="Reload preview" type="button" disabled={!url} why="Load an address first" onClick={() => setNonce((n) => n + 1)}><RefreshCw size={13} /></IconButton>
        <a className={url ? 'ibtn' : 'ibtn is-disabled'} href={url ?? undefined} target="_blank" rel="noopener noreferrer" aria-label="Open preview in a new tab" aria-disabled={!url} title={url ? 'Open in a new tab' : 'Load an address first'}><ExternalLink size={13} /></a>
      </form>
      {error ? <div className="pane-pad"><InlineError>{error}</InlineError></div> : null}
      {url ? (
        <iframe key={nonce} className="preview__frame" src={url} title="Local preview" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals" referrerPolicy="no-referrer" />
      ) : (
        <EmptyState icon={<Globe size={20} />} title="Preview a local server">
          Start a dev server for your project (for example in the terminal) and enter its address. Servers that forbid framing with <code>X-Frame-Options</code> will not render here.
          <span className="presets">{PRESETS.map((p) => <button key={p} type="button" className="chip chip--btn chip--mono" onClick={() => go(p)}>{p.replace('http://', '')}</button>)}</span>
        </EmptyState>
      )}
    </div>
  );
}
