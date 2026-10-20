import fsp from 'node:fs/promises';
import type { ProjectContext } from '@mingle/contracts';
import { repoInfo } from '../git.ts';
import { redactSecrets } from '../util.ts';
import { analyseComponents } from './components.ts';
import { commentStyleFor, extractChecklist, extractCommentMarkers, languageFor, textKey } from './extract.ts';
import { isSamplePath, listFiles, readBoundedText } from './fileset.ts';
import { readGitFacts } from './gitinfo.ts';
import { Budget, LIMITS } from './limits.ts';

/** A unit of work the repository itself declares: a Markdown checklist item or a marker comment in source. */
export interface RepoItem { kind: 'checkbox' | 'todo'; key: string; path: string; line: number; title: string; description: string; checked: boolean }

export interface ScanResult {
  /** Scan-derived context fields; status, scannedAt and taskCount are set by the service. */
  context: Omit<ProjectContext, 'status' | 'scannedAt' | 'taskCount' | 'error'>;
  items: RepoItem[];
  /** Files that were read completely. Items of a file can only disappear when the file was covered. */
  covered: Set<string>;
  /** Every eligible path, or null when the listing was incomplete (absence then proves nothing). */
  fileSet: Set<string> | null;
  /**
   * Whether the whole candidate set of each source kind was read. Items may only be flagged as vanished from a kind whose
   * scan was complete: any cap, time-out, unreadable file or incomplete listing disables it for that kind.
   */
  complete: { checklist: boolean; comments: boolean };
}

const DOC = /^(?:readme|todo|roadmap|backlog|tasks)(?:\.(?:md|markdown|txt))?$/i;
const MAX_DOC_DEPTH = 3;
const MAX_LINE = 5000;

const fmt = (n: number) => n.toLocaleString('en-US');
const clean = (text: string, max = 200) => redactSecrets(text).slice(0, max);

/** Bounded static analysis. Nothing in the project is executed and no network or model call is made. */
export async function scanProject(projectPath: string, stop?: () => boolean, budgetMs: number = LIMITS.scanBudgetMs): Promise<ScanResult> {
  const budget = new Budget(budgetMs, stop);
  const root = await fsp.realpath(projectPath);
  const stat = await fsp.stat(root);
  if (!stat.isDirectory()) throw new Error('Project path is not a directory');

  const info = await repoInfo(root).catch(() => ({ isRepo: false, topLevel: null, prefix: '', hasHead: false, head: null, branch: null }));
  const listing = await listFiles(root, info, budget);
  const { files } = listing;

  const notices = [`Static scan limits: ${fmt(LIMITS.maxFiles)} files, ${LIMITS.maxDocs} checklist documents, ${LIMITS.maxSourceFiles} source files (${LIMITS.maxSourceBytes / 1024} KiB each, ${LIMITS.maxSourceTotalBytes / 1024 / 1024} MiB total) and a cooperative ${LIMITS.scanBudgetMs / 1000} s reading budget; each Git command also has its own timeout. Project scripts are never run and no model is called. Tracked items are only flagged as missing from a source that was read completely.`];
  notices.push(...listing.notices);
  if (listing.excluded) notices.push(`${fmt(listing.excluded)} dependency, build, ignored or secret paths were skipped.`);
  if (listing.symlinks) notices.push(`${fmt(listing.symlinks)} symbolic links were not followed.`);
  if (!files.length) notices.push('No scannable files were found; the folder may still be empty.');
  if (!info.isRepo) notices.push('Not a Git repository: recent commits and changed paths are unavailable.');

  const languageCounts = new Map<string, number>();
  for (const rel of files) {
    const language = languageFor(rel);
    if (language) languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
  }
  const languages = [...languageCounts].map(([name, count]) => ({ name, files: count })).sort((a, b) => b.files - a.files || a.name.localeCompare(b.name)).slice(0, 12);

  const [analysis, gitFacts] = await Promise.all([analyseComponents(root, files, budget), readGitFacts(root, info, budget)]);
  notices.push(...analysis.notices, ...gitFacts.notices);

  const covered = new Set<string>();
  let checklistComplete = listing.complete;
  let commentsComplete = listing.complete;
  const items: RepoItem[] = [];
  const seenKeys = new Map<string, number>();
  const uniqueKey = (base: string) => {
    const count = (seenKeys.get(base) ?? 0) + 1;
    seenKeys.set(base, count);
    return count === 1 ? base : `${base}#${count}`;
  };

  const docs = files.filter((rel) => DOC.test(rel.slice(rel.lastIndexOf('/') + 1)) && rel.split('/').length <= MAX_DOC_DEPTH && !isSamplePath(rel))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  if (docs.length > LIMITS.maxDocs) checklistComplete = false;
  if (docs.length > LIMITS.maxDocs) notices.push(`Checklists were read from the first ${LIMITS.maxDocs} of ${docs.length} README/TODO/ROADMAP documents.`);
  for (const rel of docs.slice(0, LIMITS.maxDocs)) {
    if (budget.expired()) { checklistComplete = false; notices.push('The scan time budget ended before every document was read; no checklist item was flagged as missing.'); break; }
    const outcome = await readBoundedText(root, rel, LIMITS.maxDocBytes);
    if (!('text' in outcome)) { if (outcome.skipped !== 'missing') checklistComplete = false; continue; }
    covered.add(rel);
    for (const entry of extractChecklist(outcome.text)) {
      const title = clean(entry.text);
      items.push({
        kind: 'checkbox', key: uniqueKey(`repo:checklist:${rel}:${textKey(entry.text)}`), path: rel, line: entry.line, title, checked: entry.checked,
        description: `Listed in ${rel}:${entry.line}${entry.heading ? ` under “${clean(entry.heading, 100)}”` : ''}. Its checkbox in the file is the source of truth for completion.`,
      });
    }
  }

  const sources = files.filter((rel) => commentStyleFor(rel) && !isSamplePath(rel));
  if (sources.length > LIMITS.maxSourceFiles) commentsComplete = false;
  if (sources.length > LIMITS.maxSourceFiles) notices.push(`Marker comments were read from the first ${LIMITS.maxSourceFiles} of ${fmt(sources.length)} source files.`);
  let sourceBytes = 0;
  let budgetEnded = false;
  for (const rel of sources.slice(0, LIMITS.maxSourceFiles)) {
    if (budget.expired()) { budgetEnded = true; break; }
    if (sourceBytes >= LIMITS.maxSourceTotalBytes) { commentsComplete = false; notices.push('The total source-reading limit was reached; no marker comment was flagged as missing.'); break; }
    const outcome = await readBoundedText(root, rel, LIMITS.maxSourceBytes);
    if (!('text' in outcome)) { if (outcome.skipped !== 'missing') commentsComplete = false; continue; }
    sourceBytes += Buffer.byteLength(outcome.text, 'utf8');
    if (outcome.text.split('\n', 4000).some((line) => line.length > MAX_LINE)) { commentsComplete = false; continue; } // minified or generated
    const style = commentStyleFor(rel)!;
    covered.add(rel);
    for (const marker of extractCommentMarkers(outcome.text, style)) {
      items.push({
        kind: 'todo', key: uniqueKey(`repo:comment:${rel}:${textKey(marker.text)}`), path: rel, line: marker.line, title: clean(`${marker.marker}: ${marker.text}`), checked: false,
        description: `${marker.marker} comment in ${rel}:${marker.line}. Completion cannot be inferred from a removed comment, so it is flagged for review instead.`,
      });
    }
  }
  if (budgetEnded) { commentsComplete = false; notices.push('The scan time budget ended before every source file was read; no marker comment was flagged as missing.'); }

  return {
    context: {
      projectId: '', root: projectPath, isRepo: info.isRepo, branch: info.branch, head: info.head, fileCount: listing.total, components: analysis.components, languages,
      recentCommits: gitFacts.recentCommits, changedPaths: gitFacts.changedPaths, notices,
    },
    items, covered, fileSet: listing.complete ? new Set(files) : null, complete: { checklist: checklistComplete, comments: commentsComplete },
  };
}
