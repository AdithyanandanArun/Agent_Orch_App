import { useEffect, useMemo, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { Bot, ChevronRight, CircleAlert, FileCode2, Globe2, LoaderCircle, Search, Terminal, Wrench } from 'lucide-react';
import type { SessionRun, ToolCall, ToolCategory } from '@relay/contracts';
import { api } from '../lib/api';
import { cx } from '../lib/format';
import { formatElapsed, runElapsed, runStatusLabel } from '../lib/activity';

interface ToolNode { call: ToolCall; children: ToolNode[] }
function mergeToolCalls(current: ToolCall[], incoming: ToolCall[], preferIncoming: boolean): ToolCall[] {
  const calls = new Map(current.map(call => [call.id, call]));
  for (const call of incoming) {
    const existing = calls.get(call.id);
    if (!existing) calls.set(call.id, call);
    else if (preferIncoming) calls.set(call.id, call);
  }
  return [...calls.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

function normalizeCommand(value: string): string {
  return value.trim().replace(/^(?:\$|❯)\s*/, '');
}

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
  if (agents > 0) parts.push(`${agents} agent ${agents === 1 ? 'call' : 'calls'}`);
  const files = counts.file ?? 0;
  if (files > 0) parts.push(`Used file tools ${files} ${files === 1 ? 'time' : 'times'}`);
  return parts;
}

function Field({ label, value, code = false }: { label: string; value: string; code?: boolean }) {
  return <div className="run-tool__field"><span>{label}</span>{code ? <pre>{value}</pre> : <code>{value}</code>}</div>;
}

function ToolDetail({ node, activeRun }: { node: ToolNode; activeRun: boolean }) {
  const [call, setCall] = useState(node.call);
  const [outputSource, setOutputSource] = useState<'snapshot' | 'detail'>('snapshot');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const requested = useRef(false);
  const expanded = useRef(false);
  const requestGeneration = useRef(0);
  const fullCall = useRef<ToolCall | null>(null);
  const previousStatus = useRef(node.call.status);
  const latestCall = useRef(node.call);
  latestCall.current = node.call;
  const row = call;
  const elapsedMs = row.durationMs ?? (row.status === 'running' && activeRun ? (() => {
    const started = Date.parse(row.startedAt);
    return Number.isFinite(started) ? Math.max(0, Date.now() - started) : null;
  })() : null);
  const title = row.summary.trim() || row.command?.trim() || row.name || 'Tool activity';

  const fetchFull = (): void => {
    const current = latestCall.current;
    if (current.status === 'running') return;
    requested.current = true;
    const generation = ++requestGeneration.current;
    setLoading(true);
    setLoadError(false);
    void api.toolCall(current.id).then((full) => {
      const latest = latestCall.current;
      if (generation !== requestGeneration.current || !expanded.current || latest.id !== full.id || latest.status === 'running') return;
      const merged = { ...full, ...latest, input: full.input, output: full.output, outputTruncated: full.outputTruncated };
      fullCall.current = merged;
      setCall(merged);
      setOutputSource('detail');
    }).catch(() => {
      if (generation !== requestGeneration.current) return;
      setLoadError(true);
      requested.current = false;
    }).finally(() => {
      if (generation === requestGeneration.current) setLoading(false);
    });
  };

  useEffect(() => {
    const completedLiveCall = previousStatus.current === 'running' && node.call.status !== 'running';
    previousStatus.current = node.call.status;
    setLoading(false);
    if (node.call.status === 'running') {
      fullCall.current = null;
      setCall(node.call);
      setOutputSource('snapshot');
    } else if (fullCall.current?.id === node.call.id) {
      setCall({ ...fullCall.current, ...node.call, input: fullCall.current.input, output: fullCall.current.output, outputTruncated: fullCall.current.outputTruncated });
      setOutputSource('detail');
    } else {
      setCall(node.call);
      setOutputSource('snapshot');
    }
    if (expanded.current && node.call.status !== 'running' && (completedLiveCall || !activeRun || fullCall.current || requested.current)) fetchFull();
    return () => { requestGeneration.current += 1; };
  }, [node.call, activeRun]);

  useEffect(() => () => { requestGeneration.current += 1; }, []);

  const onToggle = (event: SyntheticEvent<HTMLDetailsElement>): void => {
    expanded.current = event.currentTarget.open;
    if (!event.currentTarget.open) {
      requestGeneration.current += 1;
      requested.current = false;
      setLoading(false);
      return;
    }
    if (requested.current) return;
    if (latestCall.current.status === 'running') return;
    requested.current = true;
    fetchFull();
  };

  return (
    <details className={cx('run-tool', `run-tool--${row.category}`)} onToggle={onToggle}>
      <summary className="run-tool__summary">
        <ChevronRight size={12} className="run-tool__chevron" aria-hidden="true" />
        {categoryIcon(row.category)}
        <span className="run-tool__title" title={title}>{title}</span>
        {row.command && normalizeCommand(row.command) !== normalizeCommand(title) ? <code className="run-tool__command" title={row.command}>{row.command}</code> : null}
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
          {row.command ? <Field label="Command" value={row.command} code /> : null}
        </div>
        {row.input ? <Field label="Input" value={row.input} code /> : null}
        {row.output ? <Field label={row.outputTruncated ? outputSource === 'snapshot' ? 'Output tail' : 'Captured output truncated' : 'Captured output'} value={row.output} code /> : null}
        {node.children.length ? <div className="run-tool__children" aria-label="Child tool calls">{node.children.map(child => <ToolDetail key={child.call.id} node={child} activeRun={activeRun} />)}</div> : null}
      </div>
    </details>
  );
}

export function RunActivity({ run, initialCalls }: { run: SessionRun; initialCalls: ToolCall[] }) {
  const [now, setNow] = useState(() => Date.now());
  const [calls, setCalls] = useState(() => initialCalls);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const requested = useRef(false);
  const expanded = useRef(false);
  const requestGeneration = useRef(0);

  useEffect(() => { setCalls(current => mergeToolCalls(current, initialCalls, true)); }, [initialCalls]);
  useEffect(() => () => { requestGeneration.current += 1; }, []);
  useEffect(() => {
    if (run.status !== 'running') return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [run.status]);

  const elapsed = runElapsed(run, now);
  const summary = useMemo(() => runSummary(run), [run]);
  const tree = useMemo(() => toolTree(calls, run.id), [calls, run.id]);
  const onToggle = (event: SyntheticEvent<HTMLDetailsElement>): void => {
    expanded.current = event.currentTarget.open;
    if (!event.currentTarget.open) {
      requestGeneration.current += 1;
      requested.current = false;
      setLoading(false);
      return;
    }
    if (requested.current) return;
    requested.current = true;
    const generation = ++requestGeneration.current;
    setLoading(true);
    setLoadError(false);
    void api.runTools(run.id).then((all) => {
      if (generation !== requestGeneration.current || !expanded.current) return;
      setCalls(current => mergeToolCalls(current, all.filter(call => call.runId === run.id), false));
    }).catch(() => {
      if (generation !== requestGeneration.current) return;
      setLoadError(true);
      requested.current = false;
    }).finally(() => { if (generation === requestGeneration.current) setLoading(false); });
  };

  return (
    <details className={cx('run-activity', `is-${run.status}`)} onToggle={onToggle}>
      <summary className="run-activity__summary">
        <ChevronRight size={13} className="run-activity__chevron" aria-hidden="true" />
        {run.status === 'running' ? <span className="run-activity__pulse" aria-hidden="true" /> : <span className={cx('run-activity__mark', `is-${run.status}`)} aria-hidden="true" />}
        <span className="run-activity__status" role={run.status === 'running' ? 'timer' : undefined} aria-live="off">{runStatusLabel(run, elapsed)}</span>
        {summary.length ? <span className="run-activity__counts" title={summary.join(' · ')}>{summary.join(' · ')}</span> : null}
      </summary>
      <div className="run-activity__body">
        {!run.toolCount && !tree.length ? <p className="run-activity__empty">No tool calls were reported for this run.</p> : null}
        {loading ? <span className="run-tool__loading"><LoaderCircle size={13} className="run-tool__spin" /> Loading run activity…</span> : null}
        {loadError ? <span className="run-tool__load-error"><CircleAlert size={13} /> Could not refresh the full tool list. Showing available activity.</span> : null}
        {tree.length ? <div className="run-activity__tools">{tree.map(node => <ToolDetail key={node.call.id} node={node} activeRun={run.status === 'running'} />)}</div> : !loading && run.toolCount > 0 ? <p className="run-activity__empty">Tool details are not included in the current snapshot.</p> : null}
        {calls.length < run.toolCount ? <p className="run-activity__empty">Showing {calls.length} of {run.toolCount} reported tool calls. The per-run detail list returns at most 1,000 calls.</p> : null}
      </div>
    </details>
  );
}
