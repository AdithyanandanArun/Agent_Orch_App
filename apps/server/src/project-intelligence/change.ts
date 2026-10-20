import type { ProjectContext } from '@mingle/contracts';

/** Everything a scan derives, minus volatile fields (scan time, live task count). Equal signatures mean "nothing meaningful changed". */
export function contextSignature(context: ProjectContext): string {
  const { scannedAt: _scannedAt, taskCount: _taskCount, ...stable } = context;
  return JSON.stringify(stable);
}

const short = (sha: string | null) => (sha ? sha.slice(0, 8) : 'none');
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** Human-readable diff between two contexts for the Activity feed; payload carries bounded details. */
export function describeContextChange(previous: ProjectContext | undefined, next: ProjectContext): { summary: string; payload: Record<string, unknown> } {
  const payload: Record<string, unknown> = { head: next.head, branch: next.branch, fileCount: next.fileCount, components: next.components.length };
  if (!previous || (previous.status === 'error' && !previous.scannedAt)) {
    return { summary: `Project indexed: ${plural(next.fileCount, 'file')}, ${plural(next.components.length, 'component')}${next.isRepo ? '' : ' (not a Git repository)'}`, payload };
  }
  const parts: string[] = [];
  if (previous.head !== next.head) { parts.push(`HEAD ${short(previous.head)} → ${short(next.head)}`); payload.previousHead = previous.head; }
  if (previous.branch !== next.branch) { parts.push(`branch ${previous.branch ?? 'none'} → ${next.branch ?? 'none'}`); payload.previousBranch = previous.branch; }
  const before = new Set(previous.changedPaths);
  const after = new Set(next.changedPaths);
  const added = next.changedPaths.filter((item) => !before.has(item));
  const removed = previous.changedPaths.filter((item) => !after.has(item));
  if (added.length || removed.length) {
    parts.push(`changed paths +${added.length} −${removed.length} (${next.changedPaths.length} total)`);
    payload.addedPaths = added.slice(0, 20);
    payload.removedPaths = removed.slice(0, 20);
  }
  if (previous.fileCount !== next.fileCount) {
    const delta = next.fileCount - previous.fileCount;
    parts.push(`${delta > 0 ? '+' : '−'}${plural(Math.abs(delta), 'file')}`);
    payload.previousFileCount = previous.fileCount;
  }
  const knownComponents = new Set(previous.components.map((component) => component.id));
  const newComponents = next.components.filter((component) => !knownComponents.has(component.id));
  if (newComponents.length) { parts.push(`${plural(newComponents.length, 'new component')}`); payload.newComponents = newComponents.slice(0, 10).map((component) => component.name); }
  if (previous.status === 'error') parts.push('scan recovered');
  if (!parts.length) parts.push('map details updated');
  return { summary: `Project context: ${parts.join(', ')}`, payload };
}
