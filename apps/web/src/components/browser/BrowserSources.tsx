import { Copy, ExternalLink, RefreshCw } from 'lucide-react';
import type { BrowserDiscovery } from '@relay/contracts';
import { copyText } from '../../lib/clipboard';
import { errorMessage } from '../../lib/api';
import { useRelay } from '../../store/store';
import { Button } from '../ui';
import { SelectMenu } from '../SelectMenu';

export const CHROME_INSPECT_URL = 'chrome://inspect/#remote-debugging';
const CHROME_DOCS_URL = 'https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect';

/** How to let a running Chromium browser be attached to; shown wherever an existing browser can be chosen. */
export function ChromeSetupHelp({ open }: { open?: boolean }) {
  const copy = () => {
    copyText(CHROME_INSPECT_URL)
      .then(() => useRelay.getState().toast('success', 'Address copied. Paste it into your browser’s address bar.'))
      .catch((cause) => useRelay.getState().toast('error', errorMessage(cause)));
  };
  return (
    <details className="browser-help" open={open}>
      <summary>How to allow your browser to connect</summary>
      <ol>
        <li>In Chrome 144 or newer, open <code>{CHROME_INSPECT_URL}</code> <button type="button" className="link-btn" onClick={copy}><Copy size={11} aria-hidden="true" /> Copy</button> and turn on remote debugging.</li>
        <li>Choose the detected browser, then approve the prompt Chrome shows when Relay connects.</li>
      </ol>
      <p>Relay attaches to the running browser. It does not copy cookies, passwords or profiles, and disconnecting leaves the browser open.</p>
      <a href={CHROME_DOCS_URL} target="_blank" rel="noopener noreferrer">Chrome remote debugging guide <ExternalLink size={11} aria-hidden="true" /></a>
    </details>
  );
}

interface Props {
  discovery: BrowserDiscovery | null;
  loading: boolean;
  sourceId: string;
  endpoint: string;
  onSource(id: string): void;
  onEndpoint(value: string): void;
  onEndpointBlur?(): void;
  onRefresh(): void;
  disabled?: boolean;
  idPrefix: string;
}

/** Detected browser profiles plus a manual endpoint for anything discovery cannot find. */
export function BrowserSourcePicker({ discovery, loading, sourceId, endpoint, onSource, onEndpoint, onEndpointBlur, onRefresh, disabled, idPrefix }: Props) {
  const sources = discovery?.sources ?? [];
  const selected = sources.find((s) => s.id === sourceId);
  return (
    <div className="browser-sources">
      <div className="browser-sources__row">
        {sources.length ? (
          <SelectMenu
            id={`${idPrefix}-source`} label="Detected browser" value={selected ? selected.id : ''} disabled={disabled}
            displayValue={selected?.name ?? 'Choose a browser'}
            options={sources.map((s) => ({ value: s.id, label: s.name, description: s.debuggingAvailable ? `Debugging address found · ${s.userDataDir}` : `Enable remote debugging · ${s.userDataDir}`, disabled: !s.debuggingAvailable }))}
            onChange={(id) => { onEndpoint(''); onSource(id); }}
          />
        ) : <p className="browser-sources__none">{loading ? 'Looking for Chromium browsers…' : 'No supported Chromium profile was found. You can enter a debugging endpoint.'}</p>}
        <Button size="sm" onClick={onRefresh} disabled={loading || disabled} busy={loading} aria-label="Refresh detected browsers"><RefreshCw size={12} aria-hidden="true" /> Refresh</Button>
      </div>
      <details className="browser-advanced" open={Boolean(endpoint)}>
        <summary>Enter a debugging endpoint</summary>
        <label htmlFor={`${idPrefix}-endpoint`}>Endpoint</label>
        <input
          id={`${idPrefix}-endpoint`} className="input input--mono" value={endpoint} disabled={disabled} spellCheck={false} autoComplete="off"
          placeholder="http://127.0.0.1:9222" onChange={(e) => onEndpoint(e.target.value)} onBlur={onEndpointBlur}
        />
        <p>For a browser started with <code>--remote-debugging-port</code> and its own profile folder. Any program on this computer can use an open debugging port.</p>
      </details>
    </div>
  );
}
