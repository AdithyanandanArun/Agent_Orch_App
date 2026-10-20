import type { ProjectContext } from '@mingle/contracts';
import type { RepoInfo } from '../git.ts';
import { git, parsePorcelain } from '../git.ts';
import { isDeniedName } from '../paths.ts';
import { redactSecrets, errorMessage } from '../util.ts';
import { cleanInline } from './extract.ts';
import { isExcludedPath } from './fileset.ts';
import type { Budget } from './limits.ts';
import { LIMITS } from './limits.ts';

export interface GitFacts { recentCommits: ProjectContext['recentCommits']; changedPaths: string[]; notices: string[] }

/** Read-only recent history and actual working-tree changes, scoped to the project folder; argv-only Git, no hooks. */
export async function readGitFacts(root: string, info: RepoInfo, budget: Budget): Promise<GitFacts> {
  const facts: GitFacts = { recentCommits: [], changedPaths: [], notices: [] };
  if (!info.isRepo) return facts;
  if (info.hasHead) {
    try {
      const log = await git(root, ['log', `-n${LIMITS.maxCommits}`, '--no-color', '--format=%H%x1f%aI%x1f%s%x1e', '--', '.'], { timeoutMs: budget.gitTimeout(10_000), extraConfig: ['log.showSignature=false'] });
      for (const record of log.stdout.split('\x1e')) {
        const [sha, authoredAt, ...title] = record.trim().split('\x1f');
        if (sha && /^[0-9a-f]{40,64}$/.test(sha) && authoredAt) facts.recentCommits.push({ sha, authoredAt, title: cleanInline(redactSecrets(title.join(' ')), 200) });
      }
    } catch (error) {
      facts.notices.push(`Recent commits could not be read: ${errorMessage(error)}`);
    }
  }
  try {
    let status;
    try {
      status = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'], { timeoutMs: budget.gitTimeout(15_000), maxBuffer: 8 * 1024 * 1024 });
    } catch {
      status = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--', '.'], { timeoutMs: budget.gitTimeout(15_000), maxBuffer: 8 * 1024 * 1024 });
      facts.notices.push('Untracked directories are listed as a single path because the full untracked listing exceeded its limit.');
    }
    const prefix = info.prefix ? `${info.prefix}/` : '';
    const paths = new Set<string>();
    for (const file of parsePorcelain(status.stdout)) {
      const rel = prefix && file.path.startsWith(prefix) ? file.path.slice(prefix.length) : file.path;
      if (prefix && !file.path.startsWith(prefix)) continue;
      if (isExcludedPath(rel) || rel.split('/').some(isDeniedName)) continue;
      paths.add(rel);
    }
    const sorted = [...paths].sort();
    if (sorted.length > LIMITS.maxChangedPaths) facts.notices.push(`Only the first ${LIMITS.maxChangedPaths} of ${sorted.length} changed paths are listed.`);
    facts.changedPaths = sorted.slice(0, LIMITS.maxChangedPaths);
  } catch (error) {
    facts.notices.push(`Changed paths could not be read: ${errorMessage(error)}`);
  }
  return facts;
}
