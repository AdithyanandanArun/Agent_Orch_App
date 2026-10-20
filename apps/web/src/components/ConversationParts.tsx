import { memo, useState, type ReactNode } from 'react';
import { ChevronRight, ShieldAlert, Terminal, Info } from 'lucide-react';
import type { Approval, Provider } from '@mingle/contracts';
import { useRelay } from '../store/store';
import { api, errorMessage } from '../lib/api';
import { clockTime, cx } from '../lib/format';
import { ROLE_LABEL } from '../lib/groups';
import type { DisplayMessage } from '../lib/conversation';
import type { Speaker } from '../lib/groupTimeline';
import { Markdown } from './Markdown';
import { Button, PROVIDER_NAME } from './ui';
import { AgentIdentity } from './group/AgentIdentity';
import { AttachmentHistory } from './AttachmentHistory';

function legacyToolTitle(m: DisplayMessage): string {
  const candidates = [m.kind, ...m.content.split('\n')];
  for (const value of candidates) {
    const text = value?.trim();
    if (!text || /^(?:tool(?:\s+.*)?|shell|command|tool output)$/i.test(text)) continue;
    return text.slice(0, 120);
  }
  return 'Tool output';
}

function normalizedCommand(value: string): string {
  return value.trim().replace(/^(?:\$|❯)\s*/, '');
}

export const LegacyToolGroup = memo(function LegacyToolGroup({ messages }: { messages: DisplayMessage[] }) {
  const previews = messages.map(legacyToolTitle);
  return (
    <details className="conversation-detail conversation-detail--tool legacy-tool-group">
      <summary className="conversation-detail__summary">
        <ChevronRight size={12} className="conversation-detail__chevron" aria-hidden="true" />
        <Terminal size={13} aria-hidden="true" />
        <span className="conversation-detail__label">Tool activity · {messages.length} output {messages.length === 1 ? 'record' : 'records'}</span>
        <span className="conversation-detail__preview">{previews.slice(0, 2).join(' · ')}</span>
      </summary>
      <div className="legacy-tool-group__items">
        {messages.map((m, index) => {
          const first = m.content.split('\n').find(line => line.trim() && !/^(?:tool(?:\s+.*)?|shell|command|tool output)$/i.test(line.trim())) ?? '';
          const title = previews[index] ?? 'Tool output';
          const showPreview = first && normalizedCommand(first) !== normalizedCommand(title);
          return (
            <details key={m.id} className="legacy-tool-item">
              <summary><ChevronRight size={12} aria-hidden="true" /><span>{title}</span>{showPreview ? <code>{first.slice(0, 160)}</code> : null}</summary>
              <pre>{m.content}</pre>
            </details>
          );
        })}
      </div>
    </details>
  );
});

/** Names who is speaking in a shared conversation; standalone assistant responses remain provider-icon-free. */
export function SpeakerLabel({ speaker, provider, identityKey, trailing }: { speaker: Pick<Speaker, 'handle' | 'role' | 'removed' | 'memberId'>; provider?: Provider | null; identityKey?: string; trailing?: ReactNode }) {
  return (
    <div className="speaker">
      <AgentIdentity handle={speaker.handle} identityKey={identityKey ?? speaker.memberId} provider={provider} role={ROLE_LABEL[speaker.role]} removed={speaker.removed} />
      {trailing}
    </div>
  );
}

export const MessageRow = memo(function MessageRow({ m, provider, speaker }: { m: DisplayMessage; provider?: keyof typeof PROVIDER_NAME; speaker?: Speaker | null }) {
  if (m.role === 'tool') return null;
  if (m.role === 'system') {
    const preview = m.content.split('\n').find((line) => line.trim()) ?? '';
    return (
      <details className="conversation-detail conversation-detail--system">
        <summary className="conversation-detail__summary">
          <ChevronRight size={12} className="conversation-detail__chevron" aria-hidden="true" />
          <Info size={13} aria-hidden="true" />
          <span className="conversation-detail__label">{m.kind ?? 'Session update'}</span>
          <span className="conversation-detail__preview">{preview.slice(0, 180)}</span>
        </summary>
        <div className="conversation-detail__body"><Markdown text={m.content} /></div>
      </details>
    );
  }
  if (m.role === 'user') {
    return (
      <article className="msg msg--user" aria-label="Your message">
        <div className="msg__bubble"><Markdown text={m.content} /><AttachmentHistory attachments={m.attachments} /></div>
        {m.createdAt ? <time className="msg__time" dateTime={m.createdAt} title={clockTime(m.createdAt)}>{clockTime(m.createdAt)}</time> : null}
      </article>
    );
  }
  return (
    <article className="msg msg--assistant" aria-label={speaker ? `Response from @${speaker.handle}, ${ROLE_LABEL[speaker.role]}` : `Assistant response${provider ? ` from ${PROVIDER_NAME[provider]}` : ''}`}>
      <div className="msg__main">
        {speaker ? <SpeakerLabel speaker={speaker} provider={provider} identityKey={speaker.sessionId} /> : <span className="sr-only">Assistant</span>}
        <div className={cx('msg__content', m.live && 'is-live')}><Markdown text={m.content || '…'} /></div>
        {m.createdAt ? <time className="msg__time" dateTime={m.createdAt} title={clockTime(m.createdAt)}>{clockTime(m.createdAt)}</time> : null}
      </div>
    </article>
  );
});

export function ApprovalCard({ approval, speaker, provider }: { approval: Approval; speaker?: Pick<Speaker, 'handle' | 'memberId'> | null; provider?: Provider | null }) {
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
    <section className="approval" aria-label={`Approval requested for ${approval.tool}${speaker ? ` by @${speaker.handle}` : ''}`}>
      <div className="approval__head">
        <ShieldAlert size={15} aria-hidden="true" />
        <strong>Approval needed</strong>
        {speaker ? <AgentIdentity className="approval__who" handle={speaker.handle} identityKey={speaker.memberId} provider={provider} /> : null}
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
