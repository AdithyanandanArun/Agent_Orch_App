import { useRef, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import type { GitHubState, RepositoryState } from '@mingle/contracts';
import { cx, relativeTime, useNow } from '../../lib/format';
import { Badge, Button } from '../ui';
import { Popover } from './Popover';
import { classifyRun, githubMatches, openExternal, runLabel, shortSha, summarizeChecks, type RunTone } from './gitUtil';

interface Headline { tone: 'ok' | 'err' | 'warn' | 'neutral' | 'busy'; label: string }

function headline(repo: RepositoryState, github: GitHubState | null, error: string | null, loading: boolean): Headline {
  if (repo.remotes.length === 0) return { tone: 'neutral', label: 'No remote' };
  if (!github) return error ? { tone: 'warn', label: 'GitHub unavailable' } : { tone: 'busy', label: 'Checking GitHub…' };
  if (error && github.status === 'available') return { tone: 'warn', label: 'GitHub status stale' };
  if (github.status === 'unsupported') return { tone: 'neutral', label: 'Not a GitHub remote' };
  if (github.status === 'unavailable') return { tone: 'warn', label: 'GitHub unavailable' };
  if (!githubMatches(github, repo)) return { tone: 'busy', label: loading ? 'Updating…' : 'Checks out of date' };
  if (github.checks.length === 0) return github.checksComplete === false ? { tone: 'warn', label: 'Checks unavailable' } : { tone: 'neutral', label: 'No checks reported' };
  const summary = summarizeChecks(github.checks);
  if (github.checksComplete === false && summary.tone !== 'err') return { tone: 'warn', label: 'Checks incomplete' };
  return { tone: summary.tone, label: `Actions · ${summary.label}` };
}

const toneClass: Record<RunTone, string> = { pass: 'ok', fail: 'err', pending: 'warn', skipped: 'neutral', unknown: 'neutral' };
const Dot = ({ tone }: { tone: string }) => <i className={cx('gh-dot', `gh-dot--${tone}`)} aria-hidden="true" />;

/** Read-only GitHub checks for the exact current HEAD, with commit-labelled workflow history underneath. */
export function ActionsStatus({ repo, github, error, loading, onRefresh }: {
  repo: RepositoryState; github: GitHubState | null; error: string | null; loading: boolean; onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const now = useNow();
  const head = headline(repo, github, error, loading);
  const exact = githubMatches(github, repo);
  const workflows = github?.workflows ?? [];
  const pr = exact ? github?.pullRequest ?? null : null;
  const stale = Boolean(error && github);

  return (
    <>
      <button
        ref={anchor} type="button" className={cx('gitbar__btn gitbar__status', open && 'is-open')} aria-haspopup="dialog" aria-expanded={open}
        aria-label={`GitHub status: ${head.label}`} title="GitHub checks for the current commit" onClick={() => setOpen((v) => !v)}
      >
        <Dot tone={head.tone} />
        <span>{head.label}</span>
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} label="GitHub status details" width={380} className="ghpop">
        <header className="ghpop__head">
          <div>
            <strong>{github?.repository ?? 'GitHub'}</strong>
            <span className="muted small">
              {repo.branch ?? 'detached'} · HEAD <code>{shortSha(repo.head)}</code>
              {github ? ` · updated ${relativeTime(github.fetchedAt, now) || 'just now'}` : ''}
            </span>
          </div>
          <Button size="sm" variant="ghost" busy={loading} onClick={onRefresh} aria-label="Refresh GitHub status" title="Refresh GitHub status"><RefreshCw size={12} /></Button>
        </header>

        {repo.remotes.length === 0 ? <p className="ghpop__note">No remote is configured, so there is nothing on GitHub to check.</p> : null}
        {error ? <p className="ghpop__note ghpop__note--err" role="alert">Couldn’t read GitHub status: {error}{stale ? ' Showing the last successful read, which may be out of date.' : ''}</p> : null}
        {github?.status === 'unsupported' ? <p className="ghpop__note">The remote is not a GitHub repository, so checks are unavailable.</p> : null}
        {github?.status === 'unavailable' ? <p className="ghpop__note">GitHub status is unavailable. See the notes below.</p> : null}

        {github?.status === 'available' ? (
          <div className={cx('ghpop__data', stale && 'is-stale')}>
            {pr ? (
              <section className="ghpop__sec">
                <h4>Pull request</h4>
                <button type="button" className="ghpop__row" onClick={() => openExternal(pr.url)} title={pr.url}>
                  <span className="ghpop__main">#{pr.number} {pr.title}</span>
                  <Badge tone={pr.state.toLowerCase() === 'open' ? 'ok' : 'neutral'}>{pr.isDraft ? 'draft' : pr.state.toLowerCase()}</Badge>
                  <ExternalLink size={12} aria-hidden="true" />
                </button>
                <span className="muted small">{pr.headBranch} → {pr.baseBranch}</span>
              </section>
            ) : null}

            <section className="ghpop__sec">
              <h4>Checks for <code>{shortSha(repo.head)}</code> (current HEAD)</h4>
              {!exact ? <p className="ghpop__note">These results are for <code>{shortSha(github.head)}</code>{github.branch !== repo.branch ? ` on ${github.branch ?? 'another branch'}` : ''}, not the current checkout. Refreshing…</p> : null}
              {exact && github.checksComplete === false ? <p className="ghpop__note">Some checks could not be read. These results are incomplete; see the notes below.</p> : null}
              {exact && github.checks.length === 0 && github.checksComplete !== false ? (
                <p className="ghpop__note">GitHub reported no checks for this commit.</p>
              ) : null}
              {exact ? github.checks.map((check) => {
                const tone = classifyRun(check.status, check.conclusion);
                const row = (
                  <>
                    <Dot tone={toneClass[tone]} />
                    <span className="ghpop__main">{check.name}</span>
                    <span className="ghpop__meta">{runLabel(check.status, check.conclusion)}</span>
                    {check.url ? <ExternalLink size={12} aria-hidden="true" /> : null}
                  </>
                );
                return check.url
                  ? <button key={check.id} type="button" className="ghpop__row" title={check.url} onClick={() => openExternal(check.url!)}>{row}</button>
                  : <div key={check.id} className="ghpop__row ghpop__row--static">{row}</div>;
              }) : null}
            </section>

            <section className="ghpop__sec">
              <h4>Workflow runs by commit</h4>
              {github.workflowsComplete === false ? <p className="ghpop__note">Showing the workflow runs available from a partial or bounded read.</p> : null}
              {workflows.length === 0 ? <p className="ghpop__note">No recent workflow runs were reported.</p> : (
                <>
                  {workflows.slice(0, 8).map((run) => {
                    const tone = classifyRun(run.status, run.conclusion);
                    const current = run.headSha === repo.head;
                    return (
                      <button key={run.id} type="button" className="ghpop__row ghpop__row--run" title={run.url} onClick={() => openExternal(run.url)}>
                        <Dot tone={toneClass[tone]} />
                        <span className="ghpop__main">{run.name}<small>{run.title}</small></span>
                        <span className="ghpop__sha"><code>{shortSha(run.headSha)}</code>{current ? <Badge tone="accent">HEAD</Badge> : null}</span>
                        <span className="ghpop__meta">{runLabel(run.status, run.conclusion)} · {relativeTime(run.updatedAt, now)}</span>
                      </button>
                    );
                  })}
                  <p className="ghpop__note">Runs for other commits describe those commits only, not the current HEAD.</p>
                </>
              )}
            </section>
          </div>
        ) : null}

        {github?.notices.length ? (
          <section className="ghpop__sec">
            <h4>Notes</h4>
            {github.notices.map((notice, index) => <p key={`${index}:${notice}`} className="ghpop__note">{notice}</p>)}
          </section>
        ) : null}
        {repo.notices.length ? repo.notices.map((notice, index) => <p key={`r${index}:${notice}`} className="ghpop__note">{notice}</p>) : null}
      </Popover>
    </>
  );
}
