import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ChevronRight, ShieldAlert, Terminal, Info, FolderPlus } from 'lucide-react';
import type { Approval, Session } from '@relay/contracts';
import { useRelay, useProject, useActiveSession } from '../store/store';
import { api, errorMessage } from '../lib/api';
import { clockTime, cx } from '../lib/format';
import { Markdown } from './Markdown';
import { Badge, Button, EmptyState, ProviderMark, PROVIDER_NAME } from './ui';
import { Composer } from './Composer';

interface DisplayMessage { id: string; role: 'user' | 'assistant' | 'system' | 'tool'; content: string; createdAt: string; kind?: string; live: boolean }

function useSessionMessages(session: Session | undefined): DisplayMessage[] {
  const all = useRelay((s) => s.boot?.messages);
  const streams = useRelay((s) => s.streams);
  return useMemo(() => {
    if (!session || !all) return [];
    const out: DisplayMessage[] = [];
    const seen = new Set<string>();
    for (const m of all) {
      if (m.sessionId !== session.id) continue;
      seen.add(m.id);
      const st = streams[m.id];
      const streamed = st ? st.base + st.text : '';
      const content = streamed.length > m.content.length ? streamed : m.content;
      out.push({ id: m.id, role: m.role, content, createdAt: m.createdAt, kind: m.kind, live: (Boolean(st) || m.kind === 'streaming') && session.status === 'running' });
    }
    for (const [id, st] of Object.entries(streams)) {
      if (st.sessionId !== session.id || seen.has(id)) continue;
      out.push({ id, role: 'assistant', content: st.base + st.text, createdAt: '', live: session.status === 'running' });
    }
    return out;
  }, [all, streams, session]);
}

const ToolCard = memo(function ToolCard({ m }: { m: DisplayMessage }) {
  const [open, setOpen] = useState(false);
  const first = m.content.split('\n').find((l) => l.trim()) ?? '';
  return (
    <div className={cx('tool', open && 'is-open')}>
      <button type="button" className="tool__head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <ChevronRight size={13} className="tool__chev" aria-hidden="true" />
        <Terminal size={13} aria-hidden="true" />
        <span className="tool__name">{m.kind ?? 'tool'}</span>
        {!open ? <span className="tool__summary">{first.slice(0, 140)}</span> : null}
      </button>
      {open ? <pre className="tool__body">{m.content}</pre> : null}
    </div>
  );
});

const MessageRow = memo(function MessageRow({ m, session }: { m: DisplayMessage; session: Session }) {
  if (m.role === 'tool') return <ToolCard m={m} />;
  if (m.role === 'system') {
    return (
      <div className="sysmsg">
        <Info size={12} aria-hidden="true" />
        <div>{m.kind ? <Badge>{m.kind}</Badge> : null} <span className="sysmsg__text"><Markdown text={m.content} /></span></div>
      </div>
    );
  }
  if (m.role === 'user') {
    return (
      <div className="msg msg--user">
        <div className="msg__bubble"><Markdown text={m.content} /></div>
        {m.createdAt ? <time className="msg__time" dateTime={m.createdAt}>{clockTime(m.createdAt)}</time> : null}
      </div>
    );
  }
  return (
    <div className="msg msg--assistant">
      <div className="msg__avatar"><ProviderMark provider={session.provider} size={20} /></div>
      <div className="msg__main">
        <div className="msg__meta">
          <strong>{PROVIDER_NAME[session.provider]}</strong>
          <span>{session.model}</span>
          {m.createdAt ? <time dateTime={m.createdAt}>{clockTime(m.createdAt)}</time> : null}
        </div>
        <div className={cx('msg__content', m.live && 'is-live')}><Markdown text={m.content || '…'} /></div>
      </div>
    </div>
  );
});

function ApprovalCard({ approval }: { approval: Approval }) {
  const [busy, setBusy] = useState<'approved' | 'denied' | null>(null);
  const [showInput, setShowInput] = useState(false);
  const decide = async (decision: 'approved' | 'denied') => {
    setBusy(decision);
    try {
      await api.decideApproval(approval.id, decision);
      await useRelay.getState().refreshNow();
    } catch (e) {
      useRelay.getState().toast('error', `Approval failed: ${errorMessage(e)}`);
      void useRelay.getState().refreshNow();
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="approval" aria-label={`Approval requested for ${approval.tool}`}>
      <div className="approval__head">
        <ShieldAlert size={15} aria-hidden="true" />
        <strong>Approval needed</strong>
        <code>{approval.tool}</code>
      </div>
      <p className="approval__desc">{approval.description}</p>
      {Object.keys(approval.input).length > 0 ? (
        <>
          <button type="button" className="link-btn approval__toggle" onClick={() => setShowInput((v) => !v)} aria-expanded={showInput}>{showInput ? 'Hide input' : 'Show tool input'}</button>
          {showInput ? <pre className="approval__input">{JSON.stringify(approval.input, null, 2)}</pre> : null}
        </>
      ) : null}
      <div className="approval__actions">
        <Button variant="primary" size="sm" busy={busy === 'approved'} disabled={busy !== null} onClick={() => decide('approved')}>Approve</Button>
        <Button size="sm" busy={busy === 'denied'} disabled={busy !== null} onClick={() => decide('denied')}>Deny</Button>
        <span className="approval__note">Applies to this action only.</span>
      </div>
    </section>
  );
}

export function SessionPane() {
  const project = useProject();
  const session = useActiveSession();
  const hasSessions = useRelay((s) => (s.boot?.sessions ?? []).some((x) => x.projectId === s.activeProjectId));
  const messages = useSessionMessages(session);
  const approvals = useRelay((s) => s.boot?.approvals);
  const pending = useMemo(() => (approvals ?? []).filter((a) => a.sessionId === session?.id && a.status === 'pending'), [approvals, session?.id]);
  const { openDialog } = useRelay.getState();
  const creatingSession = useRelay((s) => s.creatingSession);

  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  const last = messages[messages.length - 1];
  const sig = `${session?.id}|${messages.length}|${last?.content.length ?? 0}|${pending.length}`;

  useEffect(() => { stick.current = true; setAway(false); }, [session?.id]);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [sig]);

  if (!project) {
    return (
      <EmptyState icon={<FolderPlus size={20} />} title="Open a project to begin" action={<Button variant="primary" onClick={() => openDialog({ kind: 'project' })}>Open project…</Button>}>
        Relay works inside a local folder. Add one to start isolated agent sessions.
      </EmptyState>
    );
  }
  if (!session) {
    return (
      <EmptyState title={hasSessions ? 'Select a session' : 'No sessions yet'} action={<Button variant="primary" busy={creatingSession} disabled={creatingSession} onClick={() => void useRelay.getState().createSession()}>New session</Button>}>
        {hasSessions ? 'Choose a session from the sidebar.' : 'Start a session to work in this project.'}
      </EmptyState>
    );
  }

  return (
    <div className="chat">
      <div
        className="chat__scroll" ref={scroller} role="log" aria-live="polite" aria-label={`Conversation with ${session.name}`}
        onScroll={(e) => {
          const el = e.currentTarget;
          const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          stick.current = near;
          setAway(!near);
        }}
      >
        <div className="chat__inner">
          {!messages.some(message => message.role === 'user' || message.role === 'assistant') ? (
            <div className="chat__empty">
              <h3>Start a conversation</h3>
              <p>Send a message to {PROVIDER_NAME[session.provider]} in this session.</p>
            </div>
          ) : null}
          {messages.map((m) => <MessageRow key={m.id} m={m} session={session} />)}
          {session.status === 'running' ? (
            <div className="working" role="status"><span className="dots" aria-hidden="true"><i /><i /><i /></span> {PROVIDER_NAME[session.provider]} is working…</div>
          ) : null}
          {session.error && session.status === 'error' ? <div className="chat__error" role="alert"><strong>Session error</strong><span>{session.error}</span></div> : null}
          {pending.map((a) => <ApprovalCard key={a.id} approval={a} />)}
        </div>
      </div>
      {away ? (
        <button type="button" className="jump" onClick={() => { const el = scroller.current; if (el) { el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); } }}>
          <ArrowDown size={13} /> Latest
        </button>
      ) : null}
      <Composer key={session.id} session={session} />
    </div>
  );
}
