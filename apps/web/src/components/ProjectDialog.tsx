import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ArrowLeft, ArrowUp, ChevronRight, Eye, EyeOff, Folder, FolderPlus, GitBranch, HardDrive, LoaderCircle, Search, X } from 'lucide-react';
import type { DirectoryListing, LocalDirectory, Project } from '@mingle/contracts';
import { api, errorMessage } from '../lib/api';
import { basename } from '../lib/format';
import { useMingle } from '../store/store';
import { Button, InlineError, Modal } from './ui';

type PickerView = 'sources' | 'local' | 'new' | 'clone';
type Source = { view: Exclude<PickerView, 'sources'>; label: string; description: string; icon: typeof Folder };
const SOURCES: Source[] = [
  { view: 'new', label: 'New project', description: 'Create a project in a new folder', icon: FolderPlus },
  { view: 'local', label: 'Local folder', description: 'Open an existing folder on this machine', icon: Folder },
  { view: 'clone', label: 'Git URL', description: 'Clone a repository from a remote URL', icon: GitBranch },
];

export function ProjectDialog() {
  const closeDialog = useMingle.getState().closeDialog;
  const [view, setView] = useState<PickerView>('sources');
  const [sourceSearch, setSourceSearch] = useState('');
  const [sourceActive, setSourceActive] = useState(0);
  const [location, setLocation] = useState('');
  const [hidden, setHidden] = useState(false);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [resolvedKey, setResolvedKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [revealBusy, setRevealBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controller = useRef<AbortController | null>(null);
  const latest = useRef(0);
  const pathInput = useRef<HTMLInputElement>(null);
  const sourceSearchInput = useRef<HTMLInputElement>(null);
  const pathEditing = useRef(false);
  const pathRevision = useRef(0);
  const navigationPending = useRef(true);
  const folderList = useRef<HTMLDivElement>(null);
  const sourceList = useRef<HTMLDivElement>(null);
  const focusFolderList = useRef(false);

  const folders = listing?.directories ?? [];
  const sources = SOURCES.filter((source) => `${source.label} ${source.description}`.toLowerCase().includes(sourceSearch.trim().toLowerCase()));
  const exactPath = Boolean(listing && resolvedKey === JSON.stringify([location, hidden]));
  const valid = Boolean(exactPath && (view === 'local' ? listing?.canSelect : (listing?.canCreateWithin ?? listing?.canSelect)));
  const revealValid = Boolean(exactPath && (listing?.canSelect || listing?.canCreateWithin));
  const revealLabel = listing?.platform.toLowerCase() === 'darwin' || listing?.platform.toLowerCase().includes('mac') ? 'Finder'
    : listing?.platform.toLowerCase() === 'win32' || listing?.platform.toLowerCase().startsWith('win') ? 'File Explorer' : 'Files';
  const roots = listing?.roots ?? [];
  const buttonLabel = view === 'new' ? 'Create project' : view === 'clone' ? 'Clone project' : 'Add folder';
  const actionAllowed = valid && (view === 'local' || (name.trim().length > 0 && (view !== 'clone' || url.trim().length > 0)));
  const shortcutLabel = listing?.platform === 'darwin' ? '⌘↵' : 'Ctrl↵';

  const loadListing = useCallback((path: string, showHidden: boolean, immediate: boolean, showServerPath: boolean) => {
    if (timer.current) clearTimeout(timer.current);
    controller.current?.abort();
    const requestId = ++latest.current;
    const editRevision = pathRevision.current;
    setLoading(true);
    setListError(null);

    const run = () => {
      const aborter = new AbortController();
      controller.current = aborter;
      api.directories(path, '', showHidden, aborter.signal).then((result) => {
        if (requestId !== latest.current) return;
        setListing(result);
        setNotice(result.truncated ? 'Folder listing was limited. Type a more specific path or filter to narrow it.' : null);
        const useDisplayPath = showServerPath && editRevision === pathRevision.current;
        const nextInputPath = useDisplayPath ? result.displayPath : path;
        if (useDisplayPath) setLocation(result.displayPath);
        setResolvedKey(JSON.stringify([nextInputPath, showHidden]));
        navigationPending.current = false;
        setActive(0);
        if (focusFolderList.current) {
          folderList.current?.focus();
          focusFolderList.current = false;
        }
      }).catch((cause) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        if (requestId === latest.current) setListError(errorMessage(cause));
      }).finally(() => {
        if (requestId === latest.current) setLoading(false);
      });
    };

    if (immediate) run();
    else timer.current = setTimeout(run, 250);
  }, []);

  const cancelPendingListing = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    controller.current?.abort();
    latest.current += 1;
    setLoading(false);
    setResolvedKey('');
  };

  useEffect(() => {
    if (view === 'sources') return;
    const requestKey = JSON.stringify([location, hidden]);
    if (resolvedKey === requestKey && listing) return;
    const showServerPath = navigationPending.current;
    const immediate = !pathEditing.current || !listing;
    loadListing(location, hidden, immediate, showServerPath);
  }, [view, location, hidden, loadListing, resolvedKey, listing]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    controller.current?.abort();
  }, []);

  useEffect(() => {
    if (view === 'sources') sourceSearchInput.current?.focus();
    else pathInput.current?.focus();
  }, [view]);

  useEffect(() => {
    const row = folderList.current?.querySelector<HTMLElement>(`[data-folder-index="${active}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  useEffect(() => {
    const row = sourceList.current?.querySelector<HTMLElement>(`[data-source-index="${sourceActive}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [sourceActive]);

  const start = (next: Exclude<PickerView, 'sources'>) => {
    cancelPendingListing();
    setView(next);
    setError(null);
    setName('');
    setUrl('');
    if (!location) navigationPending.current = true;
  };

  const backToSources = () => {
    if (busy) return;
    cancelPendingListing();
    setView('sources');
  };

  const navigate = (path: string | null | undefined, focusFolders = false) => {
    if (path == null || busy) return;
    cancelPendingListing();
    pathEditing.current = false;
    navigationPending.current = true;
    focusFolderList.current = focusFolders;
    setLocation(path);
    setActive(0);
    setListError(null);
    setError(null);
  };

  const selectProject = async (project: Project) => {
    await useMingle.getState().refreshNow();
    useMingle.setState((current) => current.boot ? ({
      boot: {
        ...current.boot,
        projects: current.boot.projects.some((item) => item.id === project.id) ? current.boot.projects : [...current.boot.projects, project],
      },
    }) : current);
    useMingle.getState().selectProject(project.id);
    useMingle.getState().toast('success', `${view === 'clone' ? 'Cloned' : view === 'new' ? 'Created' : 'Opened'} ${project.name}`);
    closeDialog();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!listing || !valid || busy) return;
    if (view === 'new' && !name.trim()) { setError('Enter a project name.'); return; }
    if (view === 'clone' && (!name.trim() || !url.trim())) { setError('Enter a project name and Git URL.'); return; }
    setBusy(true);
    setError(null);
    const operation = view === 'new'
      ? api.createProjectAt({ name: name.trim(), parentPath: listing.path })
      : view === 'clone'
        ? api.cloneProject({ url: url.trim(), name: name.trim(), parentPath: listing.path })
        : api.createProject({ name: basename(listing.path), path: listing.path });
    void operation.then(selectProject).catch((cause) => setError(errorMessage(cause))).finally(() => setBusy(false));
  };

  const addCurrentFolder = () => {
    if (busy || !actionAllowed) return;
    (document.getElementById('project-add-form') as HTMLFormElement | null)?.requestSubmit();
  };

  const folderAt = (index: number): LocalDirectory | undefined => folders[index];
  const enterActive = () => {
    const row = folderAt(active);
    if (row && !busy && !loading && exactPath) navigate(row.path, true);
  };

  const onPickerKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      addCurrentFolder();
      return;
    }
    if (event.key === 'Escape' && view !== 'sources' && !busy) {
      event.stopPropagation();
      event.preventDefault();
      backToSources();
      return;
    }
    if (busy) return;

    if (view === 'sources') {
      if (event.key === 'ArrowDown' && sources.length) {
        event.preventDefault();
        setSourceActive((index) => Math.min(sources.length - 1, index + 1));
      } else if (event.key === 'ArrowUp' && sources.length) {
        event.preventDefault();
        setSourceActive((index) => Math.max(0, index - 1));
      } else if (event.key === 'Enter' && event.target instanceof HTMLInputElement && sources[sourceActive]) {
        event.preventDefault();
        start(sources[sourceActive]!.view);
      }
      return;
    }

    if (event.target === pathInput.current) {
      if (loading || !exactPath) return;
      if (event.key === 'Backspace') {
        const pathElement = pathInput.current;
        if (pathElement?.selectionStart === 0 && pathElement.selectionEnd === 0 && listing?.parentPath) {
          event.preventDefault();
          navigate(listing.parentPath);
        }
      } else if (event.key === 'ArrowDown' && folders.length) {
        event.preventDefault();
        setActive((index) => Math.min(folders.length - 1, index + 1));
      } else if (event.key === 'ArrowUp' && folders.length) {
        event.preventDefault();
        setActive((index) => Math.max(0, index - 1));
      } else if (event.key === 'Enter') {
        event.preventDefault();
        enterActive();
      }
      return;
    }

    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
    if (event.key === 'Backspace' && listing?.parentPath) {
      event.preventDefault();
      navigate(listing.parentPath);
    } else if (event.target === folderList.current || event.target instanceof HTMLElement && event.target.closest('.project-picker__folders')) {
      if (loading || !exactPath) return;
      if (event.key === 'ArrowDown' && folders.length) {
        event.preventDefault();
        setActive((index) => Math.min(folders.length - 1, index + 1));
      } else if (event.key === 'ArrowUp' && folders.length) {
        event.preventDefault();
        setActive((index) => Math.max(0, index - 1));
      } else if (event.key === 'Enter') {
        event.preventDefault();
        enterActive();
      }
    }
  };

  const close = () => { if (!busy) closeDialog(); };
  const title = view === 'sources' ? 'Open project' : view === 'local' ? 'Choose a folder' : view === 'new' ? 'New project' : 'Clone from Git URL';
  const onPathChange = (value: string) => {
    cancelPendingListing();
    pathRevision.current += 1;
    pathEditing.current = true;
    navigationPending.current = false;
    setLocation(value);
    setError(null);
  };

  return (
    <Modal title={title} onClose={close} variant="palette" footer={view === 'sources' ? <div className="project-picker__source-foot">Choose where your project lives <span><kbd>Esc</kbd> Close</span></div> : <>
      <div className="project-picker__keys"><kbd>↑</kbd><kbd>↓</kbd> Navigate <span>·</span><kbd>Enter</kbd> Open <span>·</span><kbd>Backspace</kbd> Parent <span>·</span><kbd>Esc</kbd> Back</div>
      <Button variant="ghost" className="project-picker__reveal" disabled={busy || revealBusy || !revealValid} onClick={() => {
        if (!listing || !revealValid) return;
        setRevealBusy(true);
        setError(null);
        void api.revealDirectory(listing.path).catch((cause) => setError(errorMessage(cause))).finally(() => setRevealBusy(false));
      }}><HardDrive size={14} /> {revealBusy ? 'Opening…' : `Open in ${revealLabel}`}</Button>
    </>}>
      <div className="project-picker" onKeyDown={onPickerKeyDown} aria-busy={busy}>
        {view === 'sources' ? <>
          <div className="project-picker__source-header">
            <Search size={16} aria-hidden="true" />
            <input ref={sourceSearchInput} data-autofocus aria-label="Search project sources" value={sourceSearch} onChange={(event) => { setSourceSearch(event.target.value); setSourceActive(0); }} placeholder="Search…" />
            <button type="button" className="project-picker__close" onClick={close} aria-label="Close dialog"><X size={16} /></button>
          </div>
          <div className="project-picker__source-label">Sources</div>
          <div ref={sourceList} className="project-picker__source-list" role="listbox" aria-label="Project sources">
            {sources.map((source, index) => {
              const Icon = source.icon;
              return <button key={source.view} type="button" role="option" aria-selected={sourceActive === index} data-source-index={index} className={`project-picker__source${sourceActive === index ? ' is-active' : ''}`} onMouseEnter={() => setSourceActive(index)} onClick={() => start(source.view)}>
                <Icon size={16} aria-hidden="true" /><span><strong>{source.label}</strong><small>{source.description}</small></span><ChevronRight size={15} aria-hidden="true" />
              </button>;
            })}
            {sources.length === 0 ? <div className="project-picker__no-sources">No matching sources.</div> : null}
          </div>
        </> : <form id="project-add-form" onSubmit={submit}>
          <div className="project-picker__toolbar">
            <button type="button" className="project-picker__back" onClick={backToSources} aria-label="Back to sources" disabled={busy}><ArrowLeft size={16} /></button>
            <div className="project-picker__path-wrap"><HardDrive size={15} aria-hidden="true" /><input ref={pathInput} data-autofocus aria-label="Folder path" className="project-picker__path" value={location} disabled={busy} onFocus={() => { pathEditing.current = true; }} onBlur={() => { pathEditing.current = false; }} onChange={(event) => onPathChange(event.target.value)} placeholder="Enter a folder path" spellCheck={false} autoComplete="off" /></div>
            <button type="submit" className="project-picker__add" disabled={busy || !actionAllowed} title="Add current folder (Ctrl+Enter or Cmd+Enter)" aria-label={busy ? (view === 'clone' ? 'Cloning project' : view === 'new' ? 'Creating project' : 'Adding folder') : buttonLabel}>{busy ? <><LoaderCircle className="spin" size={15} />{view === 'clone' ? 'Cloning…' : view === 'new' ? 'Creating…' : 'Adding…'}</> : <>{buttonLabel}<span>{shortcutLabel}</span></>}</button>
          </div>
          {view !== 'local' ? <div className="project-picker__form-fields">
            {view === 'clone' ? <label className="project-picker__field"><span>Git URL</span><input id="project-url" className="input input--mono" value={url} disabled={busy} onChange={(event) => setUrl(event.target.value)} placeholder="https://github.com/owner/repository.git" spellCheck={false} autoComplete="url" /><small>HTTPS and SSH URLs are supported, including private hosts and custom ports. Do not include credentials.</small></label> : null}
            <label className="project-picker__field"><span>Project name</span><input id="project-name" className="input" value={name} disabled={busy} maxLength={100} onChange={(event) => setName(event.target.value)} placeholder="My project" />{view === 'new' ? <small>Mingle initializes the new repository with an empty commit. Configure your Git author name and email first.</small> : null}</label>
          </div> : null}
          <div className="project-picker__directory-head">
            <strong>Directories</strong>
            <div className="project-picker__directory-tools">
              <button type="button" className="project-picker__tiny" disabled={busy || !listing?.parentPath} onClick={() => navigate(listing?.parentPath)} title="Parent folder" aria-label="Parent folder"><ArrowUp size={14} /></button>
              <button type="button" className="project-picker__tiny" disabled={busy || !listing?.homePath || listing.path === listing.homePath} onClick={() => navigate(listing?.homePath)} title="Home folder">Home</button>
              {roots.length > 0 ? <select disabled={busy} value={roots.some((root) => root.path === listing?.path) ? listing?.path : ''} onChange={(event) => navigate(event.target.value)} aria-label="Choose a filesystem root"><option value="">Locations</option>{roots.map((root) => <option key={root.path} value={root.path}>{root.name}</option>)}</select> : null}
              <button type="button" className="project-picker__tiny" disabled={busy} onClick={() => { cancelPendingListing(); setHidden((value) => !value); }} aria-pressed={hidden} title={hidden ? 'Hide hidden folders' : 'Show hidden folders'}>{hidden ? <EyeOff size={14} /> : <Eye size={14} />}<span>{hidden ? 'Hidden' : 'Show hidden'}</span></button>
            </div>
          </div>
          <div ref={folderList} className="project-picker__body" role="listbox" aria-label="Directories" aria-activedescendant={folders[active] ? `project-folder-${active}` : undefined} tabIndex={0}>
            {loading ? <div className="project-picker__loading"><LoaderCircle size={15} className="spin" /> Loading folders…</div> : null}
            {listError ? <InlineError onRetry={() => loadListing(location, hidden, true, navigationPending.current)}>{listError}</InlineError> : null}
            {!loading && !listError && folders.length === 0 ? <div className="project-picker__empty">No folders found here.</div> : null}
            <div className="project-picker__folders">
              {folders.map((folder, index) => <button id={`project-folder-${index}`} data-folder-index={index} key={folder.path} type="button" role="option" aria-selected={active === index} disabled={busy || loading || !exactPath} className={`project-picker__folder${active === index ? ' is-active' : ''}`} onMouseEnter={() => setActive(index)} onClick={() => navigate(folder.path, true)}>
                <Folder size={15} aria-hidden="true" /><span>{folder.name}</span>{folder.symlink ? <small>Alias</small> : null}<ChevronRight size={14} aria-hidden="true" />
              </button>)}
            </div>
          </div>
          {notice ? <p className="project-picker__notice">{notice}</p> : null}
          {error ? <InlineError>{error}</InlineError> : null}
        </form>}
      </div>
    </Modal>
  );
}
