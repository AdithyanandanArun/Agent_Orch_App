import { useEffect, useId, useRef, useState } from 'react';
import { ChevronLeft, File, FileCode2, FileSearch, Folder, Quote, Search, X } from 'lucide-react';
import { MESSAGE_CONTEXT_LIMITS, type FileContextRef, type FileEntry, type MessageContextRef, type QuoteCitation } from '@mingle/contracts';
import { api, errorMessage } from '../lib/api';
import { useMingle } from '../store/store';

export const EMPTY_CONTEXT_REFS: MessageContextRef[] = [];

export function FileContextPicker({ open, projectId, sessionId, initialQuery = '', onClose, onSelect }: {
  open: boolean; projectId: string; sessionId: string; initialQuery?: string; onClose: () => void; onSelect: (ref: FileContextRef) => void;
}) {
  const [path, setPath] = useState('');
  const [query, setQuery] = useState(initialQuery);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true); setError(null);
      const load = query.trim()
        ? api.searchFiles(projectId, query.trim(), sessionId, controller.signal)
        : api.listFiles(projectId, path, sessionId, controller.signal);
      void load.then((result) => { if (!controller.signal.aborted) setEntries(result); })
        .catch((cause) => { if (!controller.signal.aborted) setError(errorMessage(cause)); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, query.trim() ? 140 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [open, projectId, sessionId, path, query]);

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); }
      if (event.key !== 'Tab') return;
      const dialog = document.getElementById(titleId)?.closest<HTMLElement>('[role="dialog"]');
      const focusable = dialog ? Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')) : [];
      if (!focusable.length) return;
      const first = focusable[0]!; const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, titleId]);

  if (!open) return null;
  const parentPath = path.split('/').slice(0, -1).join('/');
  return (
    <div className="file-picker-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="file-picker" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="file-picker__head">
          <div><strong id={titleId}>Add workspace context</strong><span>Choose files from this session’s worktree.</span></div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close file picker"><X size={15} /></button>
        </header>
        <label className="file-picker__search"><Search size={14} aria-hidden="true" /><span className="sr-only">Search workspace files</span>
          <input ref={searchRef} type="search" value={query} placeholder="Search files and folders…" onChange={(event) => setQuery(event.target.value)} />
        </label>
        <div className="file-picker__location">
          {path && !query.trim() ? <button type="button" className="link-btn" onClick={() => setPath(parentPath)} aria-label="Go up one folder"><ChevronLeft size={13} /> Back</button> : null}
          <span title={path || 'Workspace root'}>{query.trim() ? `Search results for “${query}”` : path || 'Workspace root'}</span>
        </div>
        <div className="file-picker__results" aria-live="polite" aria-busy={loading}>
          {loading ? <p className="file-picker__empty">Loading workspace files…</p>
            : error ? <p className="file-picker__empty is-error" role="alert">{error}</p>
              : entries.length ? entries.map((entry) => entry.type === 'directory' ? (
                <button type="button" className="file-picker__entry" key={`${entry.path}:${entry.type}`} onClick={() => { setPath(entry.path); setQuery(''); }}>
                  <Folder size={15} aria-hidden="true" /><span title={entry.path}>{entry.name}</span><small>Folder</small>
                </button>
              ) : (
                <button type="button" className="file-picker__entry" key={`${entry.path}:${entry.type}`} onClick={() => { onSelect({ kind: 'file', path: entry.path, sourceSessionId: sessionId }); onClose(); }}>
                  <FileCode2 size={15} aria-hidden="true" /><span title={entry.path}>{entry.path}</span><small>Add</small>
                </button>
              )) : <p className="file-picker__empty">{query.trim() ? 'No matching files or folders.' : 'This folder has no visible files.'}</p>}
        </div>
        <footer className="file-picker__foot"><FileSearch size={13} aria-hidden="true" /> Secret and internal paths, common dependency folders, and symlinks are excluded.</footer>
      </section>
    </div>
  );
}

export function ContextReferenceChips({ refs, onRemove, disabled = false }: { refs: readonly MessageContextRef[]; onRemove?: (index: number) => void; disabled?: boolean }) {
  if (!refs.length) return null;
  return (
    <div className="context-refs" aria-label="Attached context">
      {refs.map((reference, index) => reference.kind === 'file' ? (
        <span className="context-ref context-ref--file" key={`file:${reference.sourceSessionId}:${reference.path}`} title={`Workspace file · ${reference.path}`}>
          <File size={12} aria-hidden="true" /><code>{reference.path}</code>
          {onRemove ? <button type="button" onClick={() => onRemove(index)} aria-label={`Remove file ${reference.path}`} disabled={disabled}><X size={11} /></button> : null}
        </span>
      ) : (
        <span className="context-ref context-ref--quote" key={`quote:${reference.sourceSessionId}:${reference.sourceMessageId}:${index}`} title={reference.excerpt}>
          <Quote size={12} aria-hidden="true" /><button type="button" className="context-ref__source" onClick={() => navigateToQuote(reference)}>{reference.excerpt}</button>
          {onRemove ? <button type="button" onClick={() => onRemove(index)} aria-label="Remove quoted text" disabled={disabled}><X size={11} /></button> : null}
        </span>
      ))}
    </div>
  );
}

export function quoteFromSelection(message: { id: string; sessionId: string; content: string }, groupId?: string): QuoteCitation | null {
  const selection = window.getSelection();
  let excerpt = selection?.toString().trim() ?? '';
  if (excerpt && selection?.rangeCount) {
    const common = selection.getRangeAt(0).commonAncestorContainer;
    const element = common instanceof Element ? common : common.parentElement;
    const content = element?.closest('.msg__content');
    const article = content?.closest<HTMLElement>('[data-message-id]');
    if (article?.dataset.messageId !== message.id) excerpt = '';
  }
  if (!excerpt) excerpt = message.content.trim();
  excerpt = excerpt.slice(0, 2_000).trim();
  if (!excerpt) return null;
  return { kind: 'quote', sourceMessageId: message.id, sourceSessionId: message.sessionId, ...(groupId ? { sourceGroupId: groupId } : {}), excerpt };
}

function navigateToQuote(reference: QuoteCitation): void {
  const store = useMingle.getState();
  store.selectSession(reference.sourceSessionId);
  const attempt = (remaining: number) => {
    const target = Array.from(document.querySelectorAll<HTMLElement>('[data-message-id]')).find((element) => element.dataset.messageId === reference.sourceMessageId);
    if (target) {
      target.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' });
      target.classList.add('is-context-source');
      target.tabIndex = -1;
      target.focus({ preventScroll: true });
      window.setTimeout(() => target.classList.remove('is-context-source'), 1600);
    } else if (remaining) window.requestAnimationFrame(() => attempt(remaining - 1));
    else store.toast('info', 'That quoted message is no longer in the visible conversation.');
  };
  window.requestAnimationFrame(() => window.requestAnimationFrame(() => attempt(5)));
}

export function appendContextReference(sessionId: string, reference: MessageContextRef): void {
  const store = useMingle.getState();
  const current = store.contextDrafts[sessionId] ?? [];
  const duplicate = current.some((item) => item.kind === reference.kind && (item.kind === 'file' && reference.kind === 'file'
    ? item.sourceSessionId === reference.sourceSessionId && item.path === reference.path
    : item.kind === 'quote' && reference.kind === 'quote' && item.sourceMessageId === reference.sourceMessageId && item.excerpt === reference.excerpt));
  if (duplicate) return;
  const count = current.filter((item) => item.kind === reference.kind).length;
  const kindLimit = reference.kind === 'file' ? MESSAGE_CONTEXT_LIMITS.files : MESSAGE_CONTEXT_LIMITS.quotes;
  if (count >= kindLimit) { store.toast('info', `A message can include up to ${kindLimit} ${reference.kind === 'file' ? 'files' : 'quoted passages'}.`); return; }
  if (current.length >= MESSAGE_CONTEXT_LIMITS.references) { store.toast('info', `A message can include up to ${MESSAGE_CONTEXT_LIMITS.references} context references.`); return; }
  store.setContextDraft(sessionId, [...current, reference]);
}
