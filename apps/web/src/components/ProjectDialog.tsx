import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ArrowLeft, ArrowUp, ChevronRight, Clock3, Folder, FolderPlus, GitBranch, HardDrive, LoaderCircle, Search, Eye, EyeOff } from 'lucide-react';
import type { DirectoryListing, LocalDirectory, Project } from '@relay/contracts';
import { api, errorMessage } from '../lib/api';
import { basename } from '../lib/format';
import { useRelay } from '../store/store';
import { Button, InlineError, Modal } from './ui';

type PickerView = 'sources' | 'local' | 'new' | 'clone';

export function ProjectDialog() {
  const closeDialog = useRelay.getState().closeDialog;
  const [view, setView] = useState<PickerView>('sources');
  const [location, setLocation] = useState('');
  const [query, setQuery] = useState('');
  const [hidden, setHidden] = useState(false);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [resolvedPath, setResolvedPath] = useState('');
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [name, setName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controller = useRef<AbortController | null>(null);
  const latest = useRef(0);
  const pathInput = useRef<HTMLInputElement>(null);
  const pathEditing = useRef(false);

  const pathValue = location;
  const revealLabel = listing?.platform.toLowerCase().includes('win') ? 'File Explorer'
    : listing?.platform.toLowerCase().includes('darwin') || listing?.platform.toLowerCase().includes('mac') ? 'Finder' : 'Files';
  const folders = listing?.directories ?? [];

  const loadListing = useCallback((path: string, search: string, showHidden: boolean, immediate = false) => {
    if (timer.current) clearTimeout(timer.current);
    const run = () => {
      controller.current?.abort();
      const requestId = ++latest.current;
      const aborter = new AbortController();
      controller.current = aborter;
      setLoading(true);
      setListError(null);
      api.directories(path, search, showHidden, aborter.signal).then((result) => {
        if (requestId !== latest.current) return;
        setListing(result);
        const acceptedPath = path || result.path;
        setResolvedPath(acceptedPath);
        if (!path && !pathEditing.current) setLocation(result.path);
        setActive(0);
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

  useEffect(() => {
    if (view === 'sources') return;
    loadListing(location, query, hidden, !listing);
  }, [view, location, query, hidden, loadListing]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    controller.current?.abort();
  }, []);

  useEffect(() => {
    if (listing?.truncated) setNotice('This folder has more than 2,000 directories. Some entries are not shown.');
  }, [listing?.truncated]);

  useEffect(() => {
    if (!nameEdited && listing?.canSelect) setName(basename(listing.path));
  }, [listing?.path, listing?.canSelect, nameEdited]);

  const start = (next: PickerView) => {
    setView(next);
    setError(null);
    setNotice(null);
  };

  const navigate = (path: string | null | undefined) => {
    if (path == null) return;
    setLocation(path);
    pathEditing.current = false;
    setQuery('');
    setActive(0);
    setListError(null);
    setNotice(null);
  };

  const selectProject = async (project: Project) => {
    await useRelay.getState().refreshNow();
    useRelay.getState().selectProject(project.id);
    useRelay.getState().toast('success', `${view === 'clone' ? 'Cloned' : view === 'new' ? 'Created' : 'Opened'} ${project.name}`);
    closeDialog();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!listing || !valid || busy) return;
    setBusy(true);
    setError(null);
    const operation = view === 'new'
      ? api.createProjectAt({ name: name.trim(), parentPath: listing.path })
      : view === 'clone'
        ? api.cloneProject({ url: url.trim(), name: name.trim(), parentPath: listing.path })
        : api.createProject({ name: (name.trim() || basename(listing.path)), path: listing.path });
    void operation.then(selectProject).catch((cause) => setError(errorMessage(cause))).finally(() => setBusy(false));
  };

  const addCurrentFolder = () => {
    if (!listing || !valid || busy) return;
    if (view === 'new' || view === 'clone') {
      pathInput.current?.blur();
      document.getElementById('picker-name')?.focus();
      return;
    }
    void submit(new Event('submit') as unknown as FormEvent);
  };

  const folderAt = (index: number): LocalDirectory | undefined => folders[index];
  const enterActive = () => {
    const row = folderAt(active);
    if (row) navigate(row.path);
  };

  const onPathKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      addCurrentFolder();
      return;
    }
    if (event.key === 'Backspace') {
      const input = event.currentTarget;
      if (input.selectionStart === 0 && input.selectionEnd === 0 && listing?.parentPath) {
        event.preventDefault();
        navigate(listing.parentPath);
      }
      return;
    }
    if (event.key === 'ArrowDown' && folders.length) {
      event.preventDefault();
      setActive((index) => Math.min(folders.length - 1, index + 1));
    } else if (event.key === 'ArrowUp' && folders.length) {
      event.preventDefault();
      setActive((index) => Math.max(0, index - 1));
    } else if (event.key === 'Enter' && folders.length) {
      event.preventDefault();
      enterActive();
    }
  };

  const onPickerKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && view !== 'sources' && !busy) {
      event.stopPropagation();
      event.preventDefault();
      setView('sources');
      return;
    }
    if (event.target === pathInput.current) return;
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
      if (event.key === 'Enter' && (event.target.id === 'picker-name' || event.target === event.currentTarget.querySelector('.project-picker__field input'))) {
        event.preventDefault();
        void submit(new Event('submit') as unknown as FormEvent);
      }
      return;
    }
    if (event.key === 'Backspace' && listing?.parentPath) {
      event.preventDefault();
      navigate(listing.parentPath);
    } else if (event.key === 'ArrowDown' && folders.length) {
      event.preventDefault();
      setActive((index) => Math.min(folders.length - 1, index + 1));
    } else if (event.key === 'ArrowUp' && folders.length) {
      event.preventDefault();
      setActive((index) => Math.max(0, index - 1));
    } else if (event.key === 'Enter' && folders.length) {
      event.preventDefault();
      enterActive();
    } else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      addCurrentFolder();
    }
  };

  const close = () => { if (!busy) closeDialog(); };
  const title = view === 'sources' ? 'Open project' : view === 'local' ? 'Choose a folder' : view === 'new' ? 'New project' : 'Clone from Git URL';
  const valid = Boolean(listing?.canSelect && location === resolvedPath);
  const buttonLabel = view === 'new' ? 'Create project' : view === 'clone' ? 'Clone project' : 'Open project';
  const disabledWhy = !valid ? 'Choose an existing folder' : (view === 'new' || view === 'clone') && !name.trim() ? 'Enter a project name' : view === 'clone' && !url.trim() ? 'Enter a Git URL' : undefined;
  const roots = useMemo(() => listing?.roots ?? [], [listing?.roots]);

  return (
    <Modal title={title} onClose={close} width={view === 'sources' ? 620 : 760} footer={view === 'sources' ? <div className="project-picker__source-foot"><span>Choose where your project lives</span><Button variant="ghost" onClick={close}>Cancel</Button></div> : <>
      <div className="project-picker__foot-left">
        <Button variant="ghost" disabled={!valid || busy} onClick={() => void api.revealDirectory(listing!.path).catch((cause) => setError(errorMessage(cause)))}><HardDrive size={15} /> Open in {revealLabel}</Button>
        {valid && (view === 'new' || view === 'clone') ? <span className="project-picker__parent">Parent: <code>{listing?.displayPath}</code></span> : null}
      </div>
      <div className="project-picker__foot-right">
        {busy ? <span className="project-picker__status" role="status">{view === 'clone' ? 'Cloning repository…' : view === 'new' ? 'Creating project…' : 'Opening project…'}</span> : null}
        <Button variant="ghost" onClick={() => setView('sources')} disabled={busy}>Back</Button>
        <Button variant="primary" type="submit" form="project-create-form" busy={busy} disabled={Boolean(disabledWhy)} why={disabledWhy}>{buttonLabel}</Button>
      </div>
    </>}>
      <div className="project-picker" onKeyDown={onPickerKeyDown}>
        {view === 'sources' ? <div className="project-picker__source-list" role="list" aria-label="Project sources">
          <button className="project-picker__source" onClick={() => start('new')} role="listitem">
            <span className="project-picker__source-icon"><FolderPlus size={18} /></span><span><strong>New project</strong><small>Create a project in a new folder</small></span><ChevronRight size={16} />
          </button>
          <button className="project-picker__source" onClick={() => start('local')} role="listitem">
            <span className="project-picker__source-icon"><Folder size={18} /></span><span><strong>Local folder</strong><small>Open an existing folder on this machine</small></span><ChevronRight size={16} />
          </button>
          <button className="project-picker__source" onClick={() => start('clone')} role="listitem">
            <span className="project-picker__source-icon"><GitBranch size={18} /></span><span><strong>Git URL</strong><small>Clone a repository from a remote URL</small></span><ChevronRight size={16} />
          </button>
        </div> : <>
          <div className="project-picker__toolbar">
            <button className="project-picker__back" onClick={() => setView('sources')} aria-label="Back to project sources"><ArrowLeft size={16} /></button>
            <div className="project-picker__path-wrap"><HardDrive size={16} aria-hidden="true" /><input ref={pathInput} data-autofocus={view === 'local' ? true : undefined} aria-label="Folder path" className="project-picker__path" value={pathValue} onFocus={() => { pathEditing.current = true; }} onBlur={() => { pathEditing.current = false; }} onChange={(event) => { setLocation(event.target.value); pathEditing.current = true; setError(null); }} onKeyDown={onPathKeyDown} placeholder="Enter a folder path" spellCheck={false} autoComplete="off" /></div>
            <button className="project-picker__icon-btn" disabled={!listing?.parentPath} onClick={() => navigate(listing?.parentPath)} aria-label="Go to parent folder" title="Parent folder"><ArrowUp size={16} /></button>
            <button className="project-picker__home" disabled={!listing?.homePath || listing?.path === listing?.homePath} onClick={() => navigate(listing?.homePath)} title="Go to home folder">Home</button>
            <button className="project-picker__hidden" onClick={() => setHidden((value) => !value)} aria-pressed={hidden}>{hidden ? <EyeOff size={15} /> : <Eye size={15} />}{hidden ? 'Hide hidden' : 'Show hidden'}</button>
          </div>
          <div className="project-picker__location-row">
            <span className="project-picker__location" title={listing?.displayPath}>{listing?.displayPath ?? 'Loading location…'}</span>
            {roots.length > 0 ? <label className="project-picker__roots">Location <select value={roots.some((root) => root.path === listing?.path) ? listing?.path : ''} onChange={(event) => navigate(event.target.value)} aria-label="Choose a filesystem root"><option value="">Choose location…</option>{roots.map((root) => <option key={root.path} value={root.path}>{root.name}</option>)}</select></label> : null}
          </div>
          {view !== 'local' ? <div className="project-picker__form-fields">
            {view === 'clone' ? <label className="project-picker__field"><span>Git URL</span><input autoFocus className="input input--mono" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://github.com/owner/repository.git" spellCheck={false} autoComplete="url" /></label> : null}
            <label className="project-picker__field"><span>Project name</span><input id="picker-name" className="input" value={name} maxLength={100} onChange={(event) => { setName(event.target.value); setNameEdited(true); }} placeholder="My project" /></label>
          </div> : null}
          {query.length > 0 || folders.length > 8 ? <label className="project-picker__search"><Search size={15} /><input aria-label="Filter folders" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter folders in this location" /></label> : null}
          <div className="project-picker__body">
            {loading ? <div className="project-picker__loading"><LoaderCircle size={16} className="spin" /> Loading folders…</div> : null}
            {listError ? <InlineError onRetry={() => loadListing(location, query, hidden, true)}>{listError}</InlineError> : null}
            {!loading && !listError && folders.length === 0 ? <div className="project-picker__empty">No folders found here.</div> : null}
            <div className="project-picker__folders" role="listbox" aria-label="Folders" aria-activedescendant={folders[active] ? `project-folder-${active}` : undefined} tabIndex={0}>
              {folders.map((folder, index) => <button id={`project-folder-${index}`} key={folder.path} type="button" role="option" aria-selected={active === index} disabled={loading} className={`project-picker__folder${active === index ? ' is-active' : ''}`} onMouseEnter={() => setActive(index)} onClick={() => setActive(index)} onDoubleClick={() => navigate(folder.path)}>
                <Folder size={16} aria-hidden="true" /><span>{folder.name}</span>{folder.symlink ? <small>Alias</small> : null}<ChevronRight size={14} aria-hidden="true" />
              </button>)}
            </div>
          </div>
          {listing?.truncated ? <p className="project-picker__notice">Showing the first 2,000 folders.</p> : null}
          {notice && !listing?.truncated ? <p className="project-picker__notice">{notice}</p> : null}
          {valid && view === 'local' ? <p className="project-picker__selected">Selected folder: <code>{listing?.displayPath}</code></p> : null}
          {error ? <InlineError>{error}</InlineError> : null}
          <form id="project-create-form" onSubmit={submit} className="project-picker__submit-form"><button type="submit" tabIndex={-1} aria-hidden="true" /></form>
          {valid && view === 'local' ? <button className="project-picker__shortcut" onClick={addCurrentFolder}><Clock3 size={13} /> Press Ctrl+Enter to open this folder</button> : null}
        </>}
      </div>
    </Modal>
  );
}
