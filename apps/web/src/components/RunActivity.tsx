import { useEffect, useMemo, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { Bot, ChevronRight, CircleAlert, FileCode2, Globe2, LoaderCircle, Search, Terminal, Wrench } from 'lucide-react';
import type { SessionRun, ToolCall, ToolCategory } from '@relay/contracts';
import { api } from '../lib/api';
import { cx } from '../lib/format';
import { formatElapsed, runElapsed, runStatusLabel } from '../lib/activity';

type ActivityApi = typeof api & {
  runTools?: (runId: string) => Promise<ToolCall[]>;
  toolCall?: (id: string) => Promise<ToolCall>;
};

interface ToolNode { call: ToolCall; children: ToolNode[] }

function toolTree(calls: ToolCall[], runId: string): ToolNode[] {
  const members = calls.filter(call => call.runId === runId);
  const providerRows = new Map<string, ToolCall[]>();
  for (const call of members) {
    const rows = providerRows.get(call.providerId) ?? [];
    rows.push(call);
    providerRows.set(call.providerId, rows);
  }
  const parentById = new Map<string, string>();
  for (const call of members) {
    if (!call.parentProviderId || call.parentProviderId === call.providerId) continue;
    const possible = providerRows.get(call.parentProviderId);
    if (possible?.length === 1 && possible[0]?.id !== call.id) parentById.set(call.id, possible[0]!.id);
  }

  // Break malformed cycles so bad provider metadata cannot recurse forever or hide every row.
  for (const call of members) {
    const path: string[] = [];
    const seenAt = new Map<string, number>();
    let current: string | undefined = call.id;
    while (current) {
      const at = seenAt.get(current);
      if (at !== undefined) {
        for (const cyclic of path.slice(at)) parentById.delete(cyclic);
        break;
      }
      seenAt.set(current, path.length);
      path.push(current);
      current = parentById.get(current);
    }
  }

  const childrenById = new Map<string, ToolCall[]>();
  const roots: ToolCall[] = [];
  for (const call of members) {
    const parentId = parentById.get(call.id);
    if (!parentId) roots.push(call);
    else {
      const children = childrenById.get(parentId) ?? [];
      children.push(call);
      childrenById.set(parentId, children);
    }
  }
  const toNode = (call: ToolCall, path = new Set<string>()): ToolNode => {
    if (path.has(call.id)) return { call, children: [] };
    const next = new Set(path).add(call.id);
    return { call, children: (childrenById.get(call.id) ?? []).map(child => toNode(child, next)) };
  };
  return roots.map(call => toNode(call));
}

function categoryIcon(category: ToolCategory): ReactNode {
  if (category === 'command') return <Terminal size={13} aria-hidden="true" />;
  if (category === 'browser') return <Globe2 size={13} aria-hidden="true" />;
  if (category === 'search') return <Search size={13} aria-hidden="true" />;
  if (category === 'file') return <FileCode2 size={13} aria-hidden="true" />;
  if (category === 'agent') return <Bot size={13} aria-hidden="true" />;
  return <Wrench size={13} aria-hidden="true" />;
}

function runSummary(run: SessionRun): string[] {
  const counts = run.toolCounts ?? {};
  const parts: string[] = [];
  if (run.toolCount > 0) parts.push(`Called ${run.toolCount} ${run.toolCount === 1 ? 'tool' : 'tools'}`);
  const commands = counts.command ?? 0;
  if (commands > 0) parts.push(`Ran ${commands} ${commands === 1 ? 'command' : 'commands'}`);
  const browsers = counts.browser ?? 0;
  if (browsers > 0) parts.push(`Used browser${browsers > 1 ? ` ${browsers} times` : ''}`);
  const searches = counts.search ?? 0;
  if (searches > 0) parts.push(`Searched ${searches} ${searches === 1 ? 'time' : 'times'}`);
  const agents = counts.agent ?? 0;
  if (agents > 0) parts.push(`Ran ${agents} ${agents === 1 ? 'subagent' : 'subagents'}`);
  const files = counts.file ?? 0;
  if (files > 0) parts.push(`Used file tools ${files} ${files === 1 ? 'time' : 'times'}`);
  return parts;
}

function Field({ label, value, code = false }: { label: string; value: string; code?: boolean }) {
  return <div className="run-tool__field"><span>{label}</span>{code ? <pre>{value}</pre> : <code>{value}</code>}</div>;
}

function ToolDetail({ node, activeRun }: { node: ToolNode; activeRun: boolean }) {
  const [call, setCall] = useState(node.call);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const requested = useRef(false);
  const expanded = useRef(false);
  const finalFetchKey = useRef('');
  const row = call;
  const elapsedMs = row.durationMs ?? (row.status === 'running' && activeRun ? (() => {
    const started = Date.parse(row.startedAt);
    return Number.isFinite(started) ? Math.max(0, Date.now() - started) : null;
  })() : null);
  const title = row.summary.trim() || row.command?.trim() || row.name || 'Tool activity';

  const fetchFull = (): void => {
    const loader = (api as ActivityApi).toolCall;
    if (!loader) return;
    setLoading(true);
    setLoadError(false);
    void loader(row.id).then((full) => setCall(full)).catch(() => {
      setLoadError(true);
      requested.current = false;
    }).finally(() => setLoading(false));
  };

  useEffect(() => {
    setCall(node.call);
    if (!activeRun && expanded.current && node.call.status !== 'running') {
      const key = `${node.call.id}:${node.call.finishedAt ?? node.call.status}`;
      if (finalFetchKey.current !== key) {
        finalFetchKey.current = key;
        fetchFull();
      }
    }
  }, [node.call, activeRun]);

  const onToggle = (event: SyntheticEvent<HTMLDetailsElement>): void => {
    expanded.current = event.currentTarget.open;
    if (!event.currentTarget.open || requested.current) return;
    const loader = (api as ActivityApi).toolCall;
    if (!loader) return;
    requested.current = true;
    setLoading(true);
    setLoadError(false);
    void loader(row.id).then((full) => setCall(full)).catch(() => {
      setLoadError(true);
      requested.current = false;
    }).finally(() => setLoading(false));
  };

  return (
    <details className={cx('run-tool', `run-tool--${row.category}`)} onToggle={onToggle}>
      <summary className="run-tool__summary">
        <ChevronRight size={12} className="run-tool__chevron" aria-hidden="true" />
        {categoryIcon(row.category)}
        <span className="run-tool__title" title={title}>{title}</span>
        {row.command && row.command !== title ? <code className="run-tool__command" title={row.command}>{row.command}</code> : null}
        <span className={cx('run-tool__status', `is-${row.status}`)}>{row.status}</span>
      </summary>
      <div className="run-tool__body">
        {loading ? <span className="run-tool__loading"><LoaderCircle size={13} className="run-tool__spin" /> Loading full output…</span> : null}
        {loadError ? <span className="run-tool__load-error"><CircleAlert size={13} /> Could not load full output. Showing the available record.</span> : null}
        <div className="run-tool__facts">
          {elapsedMs !== null ? <Field label="Duration" value={formatElapsed(elapsedMs)} /> : null}
          {row.exitCode !== null ? <Field label="Exit code" value={String(row.exitCode)} /> : null}
          {row.processId ? <Field label="Process" value={row.processId} /> : null}
          {row.cwd ? <Field label="Working directory" value={row.cwd} code /> : null}
          {row.command && row.summary ? <Field label="Command" value={row.command} code /> : null}
        </div>
        {row.input ? <Field label="Input" value={row.input} code /> : null}
        {row.output ? <Field label="Output" value={row.output} code /> : null}
        {node.children.length ? <div className="run-tool__children" aria-label="Child tool calls">{node.children.map(child => <ToolDetail key={child.call.id} node={child} activeRun={activeRun} />)}</div> : null}
      </div>
    </details>
  );
}

export function RunActivity({ run, initialCalls }: { run: SessionRun; initialCalls: ToolCall[] }) {
  const [now, setNow] = useState(() => Date.now());
  const [calls, setCalls] = useState(initialCalls);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const requested = useRef(false);

  useEffect(() => setCalls(initialCalls), [initialCalls]);
  useEffect(() => {
    if (run.status !== 'running') return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [run.status]);

  const elapsed = runElapsed(run, now);
  const summary = useMemo(() => runSummary(run), [run]);
  const tree = useMemo(() => toolTree(calls, run.id), [calls, run.id]);
  const onToggle = (event: SyntheticEvent<HTMLDetailsElement>): void => {
    if (!event.currentTarget.open || requested.current) return;
    const loader = (api as ActivityApi).runTools;
    if (!loader) return;
    requested.current = true;
    setLoading(true);
    setLoadError(false);
    void loader(run.id).then((all) => setCalls(all.filter(call => call.runId === run.id))).catch(() => {
      setLoadError(true);
      requested.current = false;
    }).finally(() => setLoading(false));
  };

  return (
    <details className={cx('run-activity', `is-${run.status}`)} onToggle={onToggle}>
      <summary className="run-activity__summary">
        <ChevronRight size={13} className="run-activity__chevron" aria-hidden="true" />
        {run.status === 'running' ? <span className="run-activity__pulse" aria-hidden="true" /> : <span className={cx('run-activity__mark', `is-${run.status}`)} aria-hidden="true" />}
        <span className="run-activity__status">{runStatusLabel(run, elapsed)}</span>
        {summary.length ? <span className="run-activity__counts">{summary.join(' · ')}</span> : null}
      </summary>
      <div className="run-activity__body">
        {!run.toolCount && !tree.length ? <p className="run-activity__empty">No tool calls were reported for this run.</p> : null}
        {loading ? <span className="run-tool__loading"><LoaderCircle size={13} className="run-tool__spin" /> Loading run activity…</span> : null}
        {loadError ? <span className="run-tool__load-error"><CircleAlert size={13} /> Could not refresh the full tool list. Showing available activity.</span> : null}
        {tree.length ? <div className="run-activity__tools">{tree.map(node => <ToolDetail key={node.call.id} node={node} activeRun={run.status === 'running'} />)}</div> : !loading && run.toolCount > 0 ? <p className="run-activity__empty">Tool details are not included in the current snapshot.</p> : null}
        {calls.length < run.toolCount ? <p className="run-activity__empty">Showing {calls.length} of {run.toolCount} reported tool calls.</p> : null}
      </div>
    </details>
  );
}
