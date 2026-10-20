import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { AlertTriangle, ArrowDownToLine, Check, Clock3, Folder, Search, X } from 'lucide-react';
import type { ExternalConversation, ExternalConversationDetails, ExternalConversationMessage, Provider } from '@relay/contracts';
import { useRelay } from '../store/store';
import { api, errorMessage } from '../lib/api';
import { Button, InlineError, Modal, Spinner } from './ui';
import { cx } from '../lib/format';

const PROVIDERS: { id: Provider; label: string }[] = [
  { id: 'claude', label: 'Claude' }, { id: 'codex', label: 'Codex' }, { id: 'antigravity', label: 'Antigravity' },
];

function shortDate(value: string | null): string {
  if (!value) return 'Date unavailable';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Date unavailable' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
}

function messageLabel(role: ExternalConversationMessage['role']): string {
  if (role === 'assistant') return 'Assistant';
  if (role === 'user') return 'You';
  return role === 'tool' ? 'Tool' : 'System';
}

export function ImportDialog() {
  const state = useRelay();
  const close = useRelay.getState().closeDialog;
  const project = state.boot?.projects.find((item) => item.id === state.activeProjectId) ?? null;
  const activeSession = state.activeProjectId ? state.boot?.sessions.find((item) => item.id === state.sessionByProject[state.activeProjectId!]) : undefined;
  const [provider, setProvider] = useState<Provider>(() => activeSession?.provider ?? state.boot?.settings.defaultProvider ?? 'codex');
  const [allFolders, setAllFolders] = useState(true);
  const [query, setQuery] = useState('');
  const [conversations, setConversations] = useState<ExternalConversation[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [listNotices, setListNotices] = useState<string[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [listRevision, setListRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<ExternalConversation | null>(null);
  const [details, setDetails] = useState<ExternalConversationDetails | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailRevision, setDetailRevision] = useState(0);
  const [detailLoading, setDetailLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const listController = useRef<AbortController | null>(null);
  const detailController = useRef<AbortController | null>(null);
  const listRequest = useRef(0);
  const folderProjectId = allFolders ? undefined : project?.id;

  useEffect(() => () => {
    listController.current?.abort();
    detailController.current?.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    listController.current?.abort();
    detailController.current?.abort();
    listController.current = controller;
    const request = ++listRequest.current;
    setConversations([]); setNextCursor(null); setListNotices([]); setListError(null);
    setLoadingMore(false);
    setSelected(null); setDetails(null); setDetailError(null); setImportError(null);
    if (provider === 'antigravity') {
      setListNotices(['Antigravity native history import is not supported yet. No local history request was made.']);
      setLoading(false);
      return () => controller.abort();
    }
    setLoading(true);
    void api.imports(provider, folderProjectId, undefined, controller.signal).then((result) => {
      if (controller.signal.aborted || request !== listRequest.current) return;
      setConversations(result.conversations); setNextCursor(result.nextCursor); setListNotices(result.notices);
    }).catch((cause) => {
      if (!controller.signal.aborted && request === listRequest.current) setListError(errorMessage(cause));
    }).finally(() => {
      if (!controller.signal.aborted && request === listRequest.current) setLoading(false);
    });
    return () => controller.abort();
  }, [provider, folderProjectId, listRevision]);

  useEffect(() => {
    if (!selected) { setDetails(null); setDetailError(null); setDetailLoading(false); return; }
    const controller = new AbortController();
    detailController.current?.abort();
    detailController.current = controller;
    setDetails(null); setDetailError(null); setDetailLoading(true); setImportError(null);
    void api.importDetails(provider, selected.id, controller.signal).then((result) => {
      if (!controller.signal.aborted) setDetails(result);
    }).catch((cause) => {
      if (!controller.signal.aborted) setDetailError(errorMessage(cause));
    }).finally(() => {
      if (!controller.signal.aborted) setDetailLoading(false);
    });
    return () => controller.abort();
  }, [provider, selected?.id, detailRevision]);

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return conversations;
    return conversations.filter((item) => `${item.title} ${item.directory ?? ''} ${item.model ?? ''}`.toLocaleLowerCase().includes(needle));
  }, [conversations, query]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    const cursor = nextCursor;
    const controller = new AbortController();
    listController.current?.abort();
    listController.current = controller;
    setLoadingMore(true); setListError(null);
    try {
      const result = await api.imports(provider, folderProjectId, cursor, controller.signal);
      if (controller.signal.aborted) return;
      setConversations((items) => {
        const known = new Set(items.map((item) => item.id));
        return [...items, ...result.conversations.filter((item) => !known.has(item.id))];
      });
      setNextCursor(result.nextCursor);
      setListNotices((notices) => Array.from(new Set([...notices, ...result.notices])));
    } catch (cause) {
      if (!controller.signal.aborted) setListError(errorMessage(cause));
    } finally {
      if (!controller.signal.aborted) setLoadingMore(false);
    }
  };

  const importAndOpen = async () => {
    if (!selected || !details || selected.provider !== provider || details.conversation.provider !== provider || details.conversation.id !== selected.id || selected.unavailableReason || details.conversation.unavailableReason || !details.conversation.directory || importing) return;
    setImporting(true); setImportError(null);
    try {
      const result = await api.importConversation(provider, selected.id);
      await useRelay.getState().refreshNow();
      useRelay.setState((current) => current.boot ? ({
        boot: {
          ...current.boot,
          projects: current.boot.projects.some((item) => item.id === result.project.id) ? current.boot.projects : [...current.boot.projects, result.project],
          sessions: current.boot.sessions.some((item) => item.id === result.session.id) ? current.boot.sessions : [...current.boot.sessions, result.session],
        },
      }) : current);
      useRelay.getState().selectSession(result.session.id);
      close();
      useRelay.getState().toast('success', result.alreadyImported ? `Opened “${result.session.name}”` : `Imported “${result.session.name}”`);
      for (const notice of [...new Set([...details.notices, ...result.notices])]) useRelay.getState().toast('info', notice);
    } catch (cause) {
      setImportError(errorMessage(cause));
    } finally {
      setImporting(false);
    }
  };

  const detailsMatchSelection = Boolean(selected && details?.conversation.provider === provider && details.conversation.provider === selected.provider && details.conversation.id === selected.id);
  const picked = selected ? (detailsMatchSelection ? { ...selected, ...details!.conversation } : conversations.find((item) => item.id === selected.id) ?? selected) : null;
  const unavailableReason = picked && (!detailsMatchSelection ? 'Wait for this conversation preview to load.' : !details!.conversation.directory ? 'The original conversation folder is unavailable.' : details!.conversation.unavailableReason ?? selected?.unavailableReason);
  const requestClose = () => { if (!importing) close(); };
  const footer = <>
    <p className="import-dialog__shared">Imported conversations continue in their original folder, which is shared with other programs.</p>
    <div className="import-dialog__foot-actions">
      <span className="import-dialog__policy">New imported sessions start supervised with standard speed.</span>
      <Button variant="ghost" onClick={requestClose} disabled={importing}>Cancel</Button>
      <Button variant="primary" type="submit" form="import-form" busy={importing}
        disabled={!picked || !detailsMatchSelection || detailLoading || Boolean(unavailableReason) || Boolean(importError) || importing}
        why={!picked ? 'Select a conversation' : unavailableReason ?? (detailLoading || !detailsMatchSelection ? 'Wait for its transcript to load' : undefined)}>
        {picked?.importedSessionId ? 'Open imported session' : 'Import and open'}
      </Button>
    </div>
  </>;

  return (
    <Modal title="Import a conversation" description="Continue a supported local provider conversation in Relay." onClose={requestClose} footer={footer}>
      <form id="import-form" className="import-dialog" onSubmit={(event: FormEvent) => { event.preventDefault(); void importAndOpen(); }} onKeyDown={(event) => {
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement) event.preventDefault();
      }}>
        <section className="import-dialog__list" aria-label="Conversation history">
          <div className="import-dialog__top">
            <div className="import-dialog__tabs" role="tablist" aria-label="Provider" onKeyDown={(event) => {
              if (importing || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const index = event.key === 'Home' ? 0 : event.key === 'End' ? PROVIDERS.length - 1 : (PROVIDERS.findIndex((item) => item.id === provider) + (event.key === 'ArrowRight' ? 1 : -1) + PROVIDERS.length) % PROVIDERS.length;
              setProvider(PROVIDERS[index]!.id);
              event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index]?.focus({ preventScroll: true });
            }}>
              {PROVIDERS.map((item) => <button key={item.id} type="button" role="tab" disabled={importing} aria-selected={provider === item.id} className={cx('import-dialog__tab', provider === item.id && 'is-active')} onClick={() => setProvider(item.id)}>{item.label}</button>)}
            </div>
            <label className="import-dialog__folder-toggle"><input type="checkbox" checked={allFolders || !project} disabled={!project || importing} onChange={(event) => setAllFolders(event.target.checked)} /><span>All folders</span></label>
          </div>
          <p className="import-dialog__scope" title={allFolders || !project ? 'Loaded conversation history across available folders' : project.path}>{allFolders || !project ? 'Across all folders' : `Folder: ${project.path}`}</p>
          <label className="import-dialog__search"><Search size={14} aria-hidden="true" /><input disabled={importing} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter loaded history…" aria-label="Filter loaded conversation history" /><span>Loaded only</span></label>
          {listNotices.map((notice, index) => <p className="import-dialog__notice" key={`${index}:${notice}`}>{notice}</p>)}
          {listError ? <InlineError onRetry={importing ? undefined : () => setListRevision((value) => value + 1)}>{listError}</InlineError> : null}
          {loading ? <div className="import-dialog__state"><Spinner label="Loading conversations" /><span>Reading local conversation history…</span></div> : null}
          {!loading && provider === 'antigravity' ? <div className="import-dialog__state"><AlertTriangle size={20} /><strong>Antigravity import is unavailable</strong><span>Relay does not have an Antigravity native history reader yet.</span></div> : null}
          {!loading && provider !== 'antigravity' && !listError && conversations.length === 0 ? <div className="import-dialog__state"><Folder size={20} /><strong>No conversations found</strong><span>Relay only reads history available from this machine.</span></div> : null}
          {!loading && conversations.length > 0 && visible.length === 0 ? <div className="import-dialog__state"><Search size={18} /><strong>No matches in loaded history</strong><span>Load more history to search older conversations.</span></div> : null}
          <div className="import-dialog__rows" role="listbox" aria-label={`${provider} conversations`} aria-busy={loading} onKeyDown={(event) => {
            if (importing || !visible.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]')];
            const current = rows.indexOf(document.activeElement as HTMLButtonElement);
            const index = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)));
            setSelected(visible[index]!);
            rows[index]?.focus();
          }}>
            {visible.map((item) => <button key={item.id} type="button" role="option" disabled={importing} aria-selected={picked?.id === item.id} className={cx('import-dialog__row', picked?.id === item.id && 'is-selected')} onClick={() => setSelected(item)}>
              <span className="import-dialog__row-title"><span className="import-dialog__title-text" title={item.title}>{item.title || 'Untitled conversation'}</span>{item.importedSessionId ? <span className="import-dialog__imported"><Check size={11} /> Imported</span> : null}</span>
              <span className="import-dialog__row-meta"><span><Clock3 size={12} />{shortDate(item.updatedAt ?? item.createdAt)}</span><span className="import-dialog__row-path" title={item.directory ?? 'Original folder unavailable'}>{item.directory ?? 'Folder unavailable'}</span></span>
              {item.unavailableReason || !item.directory ? <span className="import-dialog__row-warning"><AlertTriangle size={12} />Unavailable to import</span> : null}
            </button>)}
          </div>
          {nextCursor ? <Button className="import-dialog__more" onClick={() => void loadMore()} busy={loadingMore} disabled={loadingMore || importing}>Load more</Button> : null}
        </section>

        <section className="import-dialog__preview" aria-label="Conversation preview" aria-live="polite">
          {!picked ? <div className="import-dialog__state import-dialog__state--preview"><ArrowDownToLine size={20} /><strong>Choose a conversation</strong><span>Review its transcript and original folder before importing.</span></div> : <>
            <div className="import-dialog__preview-head"><div><h3>{picked.title || 'Untitled conversation'}</h3><p><Folder size={13} />{picked.directory ?? 'Original folder unavailable'}</p></div><button className="import-dialog__clear" type="button" aria-label="Clear selected conversation" disabled={importing} onClick={() => setSelected(null)}><X size={15} /></button></div>
            <p className="import-dialog__resume-note">Import opens a Relay session without starting a model turn. Your next composer message resumes this conversation in its original folder.</p>
            {unavailableReason ? <div className="import-dialog__unavailable"><AlertTriangle size={15} /><span>{unavailableReason}</span></div> : null}
            <p className="import-dialog__cli-note">Finish any active CLI run before continuing here.</p>
            {detailError ? <InlineError onRetry={importing ? undefined : () => setDetailRevision((value) => value + 1)}>{detailError}</InlineError> : null}
            {detailLoading ? <div className="import-dialog__state"><Spinner label="Loading transcript" /><span>Loading transcript…</span></div> : null}
            {details && detailsMatchSelection ? <>
              {details.notices.map((notice, index) => <p className="import-dialog__notice" key={`${index}:${notice}`}>{notice}</p>)}
              {details.truncated ? <p className="import-dialog__truncated">This preview is shortened. The source conversation remains unchanged.</p> : null}
              <div className="import-dialog__transcript">
                {details.messages.length ? details.messages.map((message, index) => <article className="import-dialog__message" key={`${index}:${message.createdAt ?? ''}`}>
                  <header><strong>{messageLabel(message.role)}</strong>{message.createdAt ? <time>{shortDate(message.createdAt)}</time> : null}</header>
                  <pre>{message.content || (message.role === 'tool' ? 'Tool output omitted' : '')}</pre>
                </article>) : <div className="import-dialog__state"><strong>No transcript preview</strong><span>The conversation can still be imported.</span></div>}
              </div>
            </> : null}
            {importError ? <InlineError onRetry={importing ? undefined : () => void importAndOpen()}>{importError}</InlineError> : null}
          </>}
        </section>
      </form>
    </Modal>
  );
}
