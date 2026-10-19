import { useMemo, useState } from 'react';
import { Activity as ActivityIcon, ChevronRight } from 'lucide-react';
import type { WorkspaceEvent } from '@relay/contracts';
import { useRelay, useProject } from '../store/store';
import { clockTime, cx, dayLabel, relativeTime, useNow } from '../lib/format';
import { Badge, EmptyState } from '../components/ui';

const toneFor = (type: string): 'ok' | 'warn' | 'err' | 'info' | 'accent' | 'neutral' => {
  if (/error|fail|denied/.test(type)) return 'err';
  if (/approval|waiting|interrupt/.test(type)) return 'warn';
  if (/complete|done|approved|finished/.test(type)) return 'ok';
  if (/handoff/.test(type)) return 'accent';
  if (/task|session|project/.test(type)) return 'info';
  return 'neutral';
};

function EventRow({ ev, sessionName, now }: { ev: WorkspaceEvent; sessionName?: string; now: number }) {
  const [open, setOpen] = useState(false);
  const hasPayload = Object.keys(ev.payload).length > 0;
  return (
    <li className="evt">
      <span className={cx('evt__dot', `evt__dot--${toneFor(ev.type)}`)} aria-hidden="true" />
      <div className="evt__main">
        <div className="evt__line">
          <span className="evt__summary">{ev.summary}</span>
          {hasPayload ? (
            <button type="button" className="evt__toggle" aria-expanded={open} aria-label={open ? 'Hide event payload' : 'Show event payload'} onClick={() => setOpen((o) => !o)}>
              <ChevronRight size={13} className={cx('trow__chev', open && 'is-open')} />
            </button>
          ) : null}
        </div>
        <div className="evt__meta">
          <Badge tone={toneFor(ev.type)}>{ev.type}</Badge>
          {sessionName ? <button type="button" className="chip chip--btn" onClick={() => ev.sessionId && useRelay.getState().selectSession(ev.sessionId)}>{sessionName}</button> : null}
          <span title={new Date(ev.createdAt).toLocaleString()}>{clockTime(ev.createdAt)} · {relativeTime(ev.createdAt, now)}</span>
          <span className="evt__id">#{ev.id}</span>
        </div>
        {open ? <pre className="evt__payload">{JSON.stringify(ev.payload, null, 2)}</pre> : null}
      </div>
    </li>
  );
}

export function ActivityView() {
  const project = useProject();
  const events = useRelay((s) => s.boot?.events);
  const sessions = useRelay((s) => s.boot?.sessions);
  const [allProjects, setAllProjects] = useState(false);
  const [type, setType] = useState('');
  const [sessionId, setSessionId] = useState('');
  const now = useNow();

  const sessionName = useMemo(() => new Map((sessions ?? []).map((s) => [s.id, s.name])), [sessions]);
  const scoped = useMemo(() => (events ?? []).filter((e) => allProjects || e.projectId === project?.id || e.projectId === null), [events, allProjects, project?.id]);
  const types = useMemo(() => Array.from(new Set(scoped.map((e) => e.type))).sort(), [scoped]);
  const filtered = useMemo(() => scoped.filter((e) => (!type || e.type === type) && (!sessionId || e.sessionId === sessionId)).sort((a, b) => b.id - a.id).slice(0, 500), [scoped, type, sessionId]);

  const groups = useMemo(() => {
    const out: { day: string; items: WorkspaceEvent[] }[] = [];
    for (const e of filtered) {
      const day = dayLabel(e.createdAt);
      const last = out[out.length - 1];
      if (last && last.day === day) last.items.push(e);
      else out.push({ day, items: [e] });
    }
    return out;
  }, [filtered]);

  return (
    <div className="activity">
      <div className="viewbar">
        <div>
          <h1>Activity</h1>
          <p className="muted small">Durable workspace events recorded by the local server. Nothing here is simulated.</p>
        </div>
        <span className="spacer" />
        <label className="sr-only" htmlFor="ev-type">Event type</label>
        <select id="ev-type" className="select select--sm" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All types</option>
          {types.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <label className="sr-only" htmlFor="ev-session">Session</label>
        <select id="ev-session" className="select select--sm" value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
          <option value="">All sessions</option>
          {(sessions ?? []).filter((s) => allProjects || s.projectId === project?.id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <label className="check check--inline"><input type="checkbox" checked={allProjects} onChange={(e) => setAllProjects(e.target.checked)} /> All projects</label>
      </div>
      <div className="activity__scroll">
        {groups.length === 0 ? (
          <EmptyState icon={<ActivityIcon size={20} />} title={scoped.length === 0 ? 'No events yet' : 'No events match these filters'}>
            {scoped.length === 0 ? 'Project, session, task and approval events will appear here as they happen.' : 'Clear a filter to see more.'}
          </EmptyState>
        ) : (
          groups.map((g) => (
            <section key={g.day} className="egroup" aria-label={g.day}>
              <h2>{g.day}</h2>
              <ol className="evts">{g.items.map((ev) => <EventRow key={ev.id} ev={ev} now={now} sessionName={ev.sessionId ? sessionName.get(ev.sessionId) : undefined} />)}</ol>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
