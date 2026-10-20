import { useEffect, useMemo, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import type { GitHubState, RepositoryMutationResult, RepositoryState } from '@relay/contracts';
import { api, errorMessage } from '../../lib/api';
import { useRelay } from '../../store/store';
import { cx } from '../../lib/format';
import { Badge, Button, Field, InlineError, Modal } from '../ui';
import { SelectMenu } from '../SelectMenu';
import { Markdown } from '../Markdown';
import { branchNameProblem, changeLabel, openExternal, shortSha } from './gitUtil';

export interface MutationProps {
  projectId: string;
  sessionId: string | null;
  repo: RepositoryState;
  adopt: (result: RepositoryMutationResult, remote?: boolean) => void;
  refresh: () => Promise<void>;
  /** Set while a run or disconnect makes Git changes unsafe. */
  blocked: string | null;
  onClose: () => void;
}

const toast = (tone: 'info' | 'success' | 'error', text: string): void => useRelay.getState().toast(tone, text);
const settle = (): void => { void useRelay.getState().refreshNow(); };

/* ——— Commit ——— */
export function CommitDialog({ projectId, sessionId, repo, adopt, refresh, blocked, onClose }: MutationProps) {
  // The reviewed snapshot is pinned: files that appear after the dialog opened are never committed unseen.
  const [reviewed, setReviewed] = useState(repo);
  const eligible = useMemo(() => reviewed.changes.filter((c) => c.eligible), [reviewed]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(eligible.map((c) => c.path)));
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const moved = repo.fingerprint !== reviewed.fingerprint || repo.head !== reviewed.head;
  const chosen = eligible.filter((c) => selected.has(c.path));
  const problem = blocked ?? (!message.trim() ? 'Write a commit message' : chosen.length === 0 ? 'Select at least one file' : moved ? 'The repository changed — reload the file list' : null);

  const reload = () => {
    const ok = new Set(repo.changes.filter((c) => c.eligible).map((c) => c.path));
    setSelected((current) => new Set([...current].filter((path) => ok.has(path))));
    setReviewed(repo);
    setError(null);
  };

  const submit = async () => {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.repositoryCommit(projectId, sessionId, {
        expectedHead: reviewed.head, expectedFingerprint: reviewed.fingerprint, message: message.trim(), paths: chosen.map((c) => c.path),
      });
      adopt(result);
      settle();
      toast('success', result.commit ? `Committed ${shortSha(result.commit)} · ${chosen.length} file${chosen.length === 1 ? '' : 's'}` : 'Committed');
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      void refresh();
    } finally {
      setBusy(false);
    }
  };

  const toggleAll = () => setSelected(selected.size === eligible.length ? new Set() : new Set(eligible.map((c) => c.path)));
  const blockedFiles = reviewed.changes.filter((c) => !c.eligible);
  const location = reviewed.detached ? `detached HEAD at ${shortSha(reviewed.head)}` : `${reviewed.branch ?? 'unborn branch'} at ${shortSha(reviewed.head)}`;

  return (
    <Modal
      title="Commit changes" description={`On ${location}. Nothing is pushed.`} onClose={onClose} width={580}
      footer={<>
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="primary" busy={busy} disabled={Boolean(problem)} why={problem ?? undefined} onClick={() => void submit()}>
          Commit {chosen.length > 0 ? `${chosen.length} file${chosen.length === 1 ? '' : 's'}` : ''}
        </Button>
      </>}
    >
      <div className="form gitdlg">
        <Field label="Commit message" htmlFor="commit-message" hint="You write the message; Relay never commits on its own.">
          <textarea
            id="commit-message" className="textarea" rows={3} value={message} data-autofocus maxLength={10000}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); } }}
          />
        </Field>
        <fieldset className="fieldset gitdlg__files">
          <legend>Files</legend>
          {moved ? (
            <div className="gitdlg__stale" role="status">
              <span>Files changed since you opened this dialog.</span>
              <button type="button" className="link-btn" onClick={reload}>Reload list</button>
            </div>
          ) : null}
          {eligible.length === 0 ? <p className="muted small">No eligible changes to commit.</p> : (
            <>
              <div className="gitdlg__bar">
                <label className="check"><input type="checkbox" checked={selected.size === eligible.length} ref={(el) => { if (el) el.indeterminate = selected.size > 0 && selected.size < eligible.length; }} onChange={toggleAll} /><span>{selected.size} of {eligible.length} selected</span></label>
              </div>
              <ul className="gitdlg__list">
                {eligible.map((change) => (
                  <li key={change.path}>
                    <label className="check">
                      <input
                        type="checkbox" checked={selected.has(change.path)}
                        onChange={(e) => setSelected((current) => { const next = new Set(current); if (e.target.checked) next.add(change.path); else next.delete(change.path); return next; })}
                      />
                      <span className="gitdlg__file">
                        <code title={change.path}>{change.path}</code>
                        {change.originalPath ? <small>from {change.originalPath}</small> : null}
                      </span>
                      <Badge tone={change.status === '??' ? 'neutral' : 'info'}>{changeLabel(change)}</Badge>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
          {blockedFiles.length > 0 ? (
            <details className="gitdlg__blocked">
              <summary>{blockedFiles.length} file{blockedFiles.length === 1 ? '' : 's'} can’t be committed here</summary>
              <ul>{blockedFiles.map((change) => <li key={change.path}><code>{change.path}</code><small>{change.reason ?? 'Not eligible'}</small></li>)}</ul>
            </details>
          ) : null}
        </fieldset>
        <p className="field__hint">Only the selected files are committed. Other staged or unstaged changes are left as they are.</p>
        {reviewed.notices.map((notice) => <p key={notice} className="field__hint">{notice}</p>)}
        {error ? <InlineError>{error}</InlineError> : null}
      </div>
    </Modal>
  );
}

/* ——— Push ——— */
const defaultRemote = (repo: RepositoryState): string => {
  const fromUpstream = repo.upstream?.split('/')[0];
  if (fromUpstream && repo.remotes.some((r) => r.name === fromUpstream)) return fromUpstream;
  return repo.remotes.find((r) => r.name === 'origin')?.name ?? repo.remotes[0]?.name ?? '';
};

export function PushDialog({ projectId, sessionId, repo, adopt, refresh, blocked, onClose }: MutationProps) {
  const [remote, setRemote] = useState(() => defaultRemote(repo));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = repo.remotes.find((r) => r.name === remote);
  const publishing = !repo.upstream;
  const problem = blocked ?? (!repo.branch ? 'Detached HEAD cannot be pushed' : !repo.head ? 'Commit something first' : !remote ? 'No remote configured' : null);

  const submit = async () => {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.repositoryPush(projectId, sessionId, { expectedHead: repo.head, remote });
      adopt(result, true);
      settle();
      toast('success', `Pushed ${repo.branch ?? 'branch'} to ${remote}`);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      void refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={publishing ? 'Publish branch' : 'Push commits'} onClose={onClose} width={480}
      description={publishing ? 'The branch has no upstream yet; it will be created on the remote.' : undefined}
      footer={<>
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="primary" busy={busy} disabled={Boolean(problem)} why={problem ?? undefined} onClick={() => void submit()}>{publishing ? 'Publish' : 'Push'}</Button>
      </>}
    >
      <div className="form gitdlg">
        <dl className="gitdlg__facts">
          <dt>Branch</dt><dd><code>{repo.branch ?? 'detached'}</code></dd>
          <dt>Commit</dt><dd><code>{shortSha(repo.head)}</code></dd>
          {repo.upstream ? <><dt>Upstream</dt><dd><code>{repo.upstream}</code></dd></> : null}
          {repo.upstream ? <><dt>Ahead</dt><dd>{repo.ahead === null ? 'Unknown — Git did not report a count' : `${repo.ahead} commit${repo.ahead === 1 ? '' : 's'} to push`}</dd></> : null}
          {repo.behind ? <><dt>Behind</dt><dd>{repo.behind} commit{repo.behind === 1 ? '' : 's'} on upstream</dd></> : null}
        </dl>
        {repo.remotes.length > 1 ? (
          <Field label="Remote" htmlFor="push-remote">
            <SelectMenu id="push-remote" label="Remote" value={remote} onChange={setRemote} options={repo.remotes.map((r) => ({ value: r.name, label: r.name, description: r.repository ?? r.host ?? undefined }))} />
          </Field>
        ) : (
          <p className="small">Remote <code>{remote || 'none'}</code>{target?.repository ? <> · {target.repository}</> : null}</p>
        )}
        {repo.behind ? <InlineError>The upstream has {repo.behind} commit{repo.behind === 1 ? '' : 's'} this branch lacks, so the push may be rejected. Relay has no force-push option.</InlineError> : null}
        <p className="field__hint">A normal push of the current branch only. Relay does not push automatically.</p>
        {error ? <InlineError>{error}</InlineError> : null}
      </div>
    </Modal>
  );
}

/* ——— Create branch ——— */
export function CreateBranchDialog({ projectId, sessionId, repo, adopt, refresh, blocked, onClose }: MutationProps) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalid = name ? branchNameProblem(name) : null;
  const exists = repo.branches.some((b) => b.name === name.trim());
  const problem = blocked ?? (!name.trim() ? 'Enter a branch name' : invalid ?? (exists ? 'A branch with that name already exists' : null));

  const submit = async () => {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.repositoryBranch(projectId, sessionId, { expectedHead: repo.head, name: name.trim(), create: true });
      adopt(result);
      settle();
      toast('success', `Switched to new branch ${name.trim()}`);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      void refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Create branch" onClose={onClose} width={440}
      description={`Starts at ${shortSha(repo.head)}${repo.branch ? `, the current commit on ${repo.branch}` : ''}, then switches to it.`}
      footer={<>
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="primary" busy={busy} disabled={Boolean(problem)} why={problem ?? undefined} onClick={() => void submit()}>Create branch</Button>
      </>}
    >
      <div className="form gitdlg">
        <Field label="Branch name" htmlFor="new-branch" error={invalid ?? (exists ? 'A branch with that name already exists.' : null)}>
          <input
            id="new-branch" className="input input--mono" value={name} data-autofocus autoComplete="off" spellCheck={false} maxLength={200} placeholder="feature/short-name"
            onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } }}
          />
        </Field>
        {error ? <InlineError>{error}</InlineError> : null}
      </div>
    </Modal>
  );
}

/* ——— Pull request ——— */
const titleFromBranch = (branch: string | null): string => {
  const words = (branch ?? '').split('/').pop()?.replace(/[-_]+/g, ' ').trim() ?? '';
  return words ? words[0]!.toUpperCase() + words.slice(1) : '';
};
const defaultBase = (repo: RepositoryState): string => {
  const others = repo.branches.filter((b) => !b.current).map((b) => b.name);
  return ['main', 'master', 'trunk', 'develop'].find((name) => others.includes(name)) ?? others[0] ?? '';
};

export function PullRequestDialog({ projectId, sessionId, repo, github, adopt, refresh, blocked, onClose }: MutationProps & { github: GitHubState | null }) {
  const [step, setStep] = useState<'edit' | 'review'>('edit');
  const [title, setTitle] = useState(() => titleFromBranch(repo.branch));
  const [body, setBody] = useState('');
  const [base, setBase] = useState(() => defaultBase(repo));
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ url?: string } | null>(null);
  const unpublished = !repo.upstream;
  const unpushed = repo.upstream ? (repo.ahead ?? 0) : 0;
  const baseProblem = !base.trim() ? 'Choose the branch the pull request targets.' : /[\0\r\n]/.test(base) ? 'The base branch contains invalid characters.' : base.trim() === repo.branch ? 'The base branch must differ from the current branch.' : null;
  const problem = blocked ?? (!repo.branch ? 'Detached HEAD has no branch to open a pull request from'
    : unpublished ? 'No upstream is configured — push the branch first; Relay never pushes for you'
      : !title.trim() ? 'Enter a title' : baseProblem);

  useEffect(() => { if (created) document.getElementById('pr-done')?.focus(); }, [created]);

  const submit = async () => {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.repositoryPullRequest(projectId, sessionId, { expectedHead: repo.head, title: title.trim(), body, base: base.trim(), draft });
      adopt(result, true);
      settle();
      setCreated({ url: result.url });
      toast('success', 'Pull request created');
    } catch (cause) {
      setError(errorMessage(cause));
      setStep('edit');
      void refresh();
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <Modal title="Pull request created" onClose={onClose} width={440} footer={<><Button id="pr-done" variant="primary" onClick={onClose}>Done</Button></>}>
        <div className="form gitdlg">
          <p className="small">{repo.branch} → {base.trim()}{draft ? ' · draft' : ''}</p>
          {created.url ? <Button onClick={() => openExternal(created.url!)}><ExternalLink size={13} /> Open pull request</Button> : <p className="field__hint">The server did not report a link; look for the new pull request on GitHub.</p>}
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={step === 'edit' ? 'Create pull request' : 'Review pull request'} onClose={onClose} width={560}
      description={github?.repository ? `On ${github.repository}. Nothing is created until you confirm.` : 'Nothing is created until you confirm.'}
      footer={step === 'edit' ? (
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={Boolean(problem)} why={problem ?? undefined} onClick={() => setStep('review')}>Review</Button>
        </>
      ) : (
        <>
          <Button variant="ghost" onClick={() => setStep('edit')} disabled={busy}>Back</Button>
          <Button variant="primary" busy={busy} disabled={Boolean(problem)} why={problem ?? undefined} onClick={() => void submit()}>Create pull request</Button>
        </>
      )}
    >
      {step === 'edit' ? (
        <div className="form gitdlg">
          {unpublished ? <InlineError>This branch has no upstream configured, so Relay can’t confirm it is on the remote. Push it first; creating a pull request does not push.</InlineError> : unpushed > 0 ? <p className="gitdlg__warn" role="status">{unpushed} local commit{unpushed === 1 ? ' is' : 's are'} not pushed and will not be in the pull request until you push.</p> : null}
          <Field label="Title" htmlFor="pr-title"><input id="pr-title" className="input" value={title} data-autofocus maxLength={250} onChange={(e) => setTitle(e.target.value)} /></Field>
          <Field label="Description" htmlFor="pr-body"><textarea id="pr-body" className="textarea" rows={6} value={body} maxLength={50000} onChange={(e) => setBody(e.target.value)} placeholder="Optional. Markdown is supported." /></Field>
          <Field label="Base branch" htmlFor="pr-base" hint={<>Merge <code>{repo.branch ?? 'HEAD'}</code> into this branch.</>} error={base && baseProblem ? baseProblem : null}>
            <input id="pr-base" className="input input--mono" value={base} list="pr-base-options" autoComplete="off" spellCheck={false} maxLength={200} onChange={(e) => setBase(e.target.value)} />
            <datalist id="pr-base-options">{repo.branches.filter((b) => !b.current).map((b) => <option key={b.name} value={b.name} />)}</datalist>
          </Field>
          <label className="check"><input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} /><span>Open as draft</span></label>
          {error ? <InlineError>{error}</InlineError> : null}
        </div>
      ) : (
        <div className="form gitdlg">
          <dl className="gitdlg__facts">
            <dt>Repository</dt><dd>{github?.repository ?? 'unknown'}</dd>
            <dt>From</dt><dd><code>{repo.branch}</code> at <code>{shortSha(repo.head)}</code></dd>
            <dt>Into</dt><dd><code>{base.trim()}</code></dd>
            <dt>Type</dt><dd>{draft ? 'Draft pull request' : 'Ready for review'}</dd>
          </dl>
          <div className={cx('gitdlg__preview')}>
            <h3>{title.trim()}</h3>
            {body.trim() ? <Markdown text={body} /> : <p className="muted small">No description.</p>}
          </div>
          <p className="field__hint">Creating the pull request does not push or change any local files.</p>
          {error ? <InlineError>{error}</InlineError> : null}
        </div>
      )}
    </Modal>
  );
}
