import { memo, useEffect, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronRight, CircleHelp, Info, Pencil, Play, Plus, ShieldAlert, Terminal, Trash2, X } from 'lucide-react';
import { Quote } from 'lucide-react';
import type { Approval, Provider, SessionPlan, UserQuestion, UserInputAnswers } from '@mingle/contracts';
import { useMingle } from '../store/store';
import { api, errorMessage } from '../lib/api';
import { clockTime, cx } from '../lib/format';
import { ROLE_LABEL } from '../lib/groups';
import type { DisplayMessage } from '../lib/conversation';
import type { QuoteCitation } from '@mingle/contracts';
import type { Speaker } from '../lib/groupTimeline';
import { Markdown } from './Markdown';
import { Button, PROVIDER_NAME } from './ui';
import { AgentIdentity } from './group/AgentIdentity';
import { AttachmentHistory } from './AttachmentHistory';
import { ContextReferenceChips, quoteFromSelection } from './MessageContextControls';

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

export const MessageRow = memo(function MessageRow({ m, provider, speaker, onAskAboutThis }: { m: DisplayMessage; provider?: keyof typeof PROVIDER_NAME; speaker?: Speaker | null; onAskAboutThis?: (quote: QuoteCitation) => void }) {
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
      <article className="msg msg--user" aria-label="Your message" data-message-id={m.id}>
        <div className="msg__bubble"><Markdown text={m.content} /><AttachmentHistory attachments={m.attachments} /><ContextReferenceChips refs={m.contextRefs ?? []} /></div>
        {m.createdAt ? <time className="msg__time" dateTime={m.createdAt} title={clockTime(m.createdAt)}>{clockTime(m.createdAt)}</time> : null}
      </article>
    );
  }
  return (
    <article className="msg msg--assistant" aria-label={speaker ? `Response from @${speaker.handle}, ${ROLE_LABEL[speaker.role]}` : `Assistant response${provider ? ` from ${PROVIDER_NAME[provider]}` : ''}`} data-message-id={m.id}>
      <div className="msg__main">
        {speaker ? <SpeakerLabel speaker={speaker} provider={provider} identityKey={speaker.sessionId} /> : <span className="sr-only">Assistant</span>}
        <div className={cx('msg__content', m.live && 'is-live')}><Markdown text={m.content || '…'} /></div>
        {onAskAboutThis && !m.live && m.sessionId ? <button type="button" className="msg__quote-action" onMouseDown={(event) => event.preventDefault()} onClick={() => {
          const quote = quoteFromSelection({ id: m.id, sessionId: m.sessionId!, content: m.content });
          if (quote) onAskAboutThis(quote);
        }}><Quote size={12} aria-hidden="true" /> Ask about this</button> : null}
        <ContextReferenceChips refs={m.contextRefs ?? []} />
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
      await useMingle.getState().refreshNow();
    } catch (e) {
      useMingle.getState().toast('error', `Approval failed: ${errorMessage(e)}`);
      void useMingle.getState().refreshNow();
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

const PLAN_STATUS: Record<SessionPlan['status'], string> = {
  review: 'Needs review', approved: 'Approved', executing: 'Executing', completed: 'Completed', interrupted: 'Interrupted', failed: 'Failed',
};

export function SessionPlanCard({ plan, reviewReady, speaker }: { plan: SessionPlan; reviewReady: boolean; speaker?: Pick<Speaker, 'handle' | 'memberId'> | null }) {
  const [editing, setEditing] = useState(false);
  const [explanation, setExplanation] = useState(plan.explanation);
  const [steps, setSteps] = useState(plan.steps);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canReview = plan.status === 'review' && reviewReady;
  const canRevise = canReview || plan.status === 'failed' || plan.status === 'interrupted';
  useEffect(() => {
    setEditing(false); setExplanation(plan.explanation); setSteps(plan.steps); setError(null);
  }, [plan.id, plan.revision, plan.updatedAt]);
  const mutate = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true); setError(null);
    try {
      await action();
      setEditing(false);
      await useMingle.getState().refreshNow();
      useMingle.getState().toast('success', success);
    } catch (cause) {
      setError(errorMessage(cause));
      void useMingle.getState().refreshNow();
    } finally { setBusy(false); }
  };
  const save = () => mutate(() => api.editPlan(plan.id, { explanation: explanation.trim(), steps }), 'Plan saved. Review the revised steps before approving.');
  const approve = () => mutate(() => api.approvePlan(plan.id, plan.revision), 'Plan approved.');
  const execute = () => mutate(() => api.executePlan(plan.id), 'Approved plan execution started.');
  return (
    <section className="plan-card" aria-label={`Session plan, ${PLAN_STATUS[plan.status]}`}>
      <header className="plan-card__header">
        <strong>Native plan</strong>
        {speaker ? <AgentIdentity className="plan-card__who" handle={speaker.handle} identityKey={speaker.memberId} /> : null}
        <span className={`plan-card__status is-${plan.status}`}>{canReview ? 'Needs review' : plan.status === 'review' ? 'Generating' : PLAN_STATUS[plan.status]}</span>
      </header>
      {editing ? (
        <div className="plan-card__editor">
          <label>Plan context<textarea maxLength={4000} rows={3} value={explanation} onChange={(event) => setExplanation(event.target.value)} /></label>
          {steps.map((step, index) => (
            <fieldset key={step.id} className="plan-card__step-editor" disabled={busy}>
              <legend>Step {index + 1}</legend>
              <div className="plan-card__step-order">
                <span>Execution order</span>
                <button type="button" className="link-btn" aria-label={`Move step ${index + 1} up`} title="Move up" disabled={index === 0} onClick={() => setSteps((current) => { const next = [...current]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]; return next; })}><ArrowUp size={13} /></button>
                <button type="button" className="link-btn" aria-label={`Move step ${index + 1} down`} title="Move down" disabled={index === steps.length - 1} onClick={() => setSteps((current) => { const next = [...current]; [next[index], next[index + 1]] = [next[index + 1]!, next[index]!]; return next; })}><ArrowDown size={13} /></button>
                <button type="button" className="link-btn plan-card__remove-step" aria-label={`Remove step ${index + 1}`} title="Remove step" onClick={() => setSteps((current) => current.filter((item) => item.id !== step.id).map((item) => ({ ...item, dependsOn: item.dependsOn.filter((id) => id !== step.id) })))}><Trash2 size={13} /></button>
              </div>
              <label>Title<input maxLength={200} value={step.title} onChange={(event) => setSteps((current) => current.map((item) => item.id === step.id ? { ...item, title: event.target.value } : item))} /></label>
              <label>Description<textarea maxLength={4000} rows={3} value={step.description} onChange={(event) => setSteps((current) => current.map((item) => item.id === step.id ? { ...item, description: event.target.value } : item))} /></label>
              <label>Acceptance criteria<textarea maxLength={4000} rows={2} value={step.acceptanceCriteria.join('\n')} onChange={(event) => setSteps((current) => current.map((item) => item.id === step.id ? { ...item, acceptanceCriteria: event.target.value.split('\n').map((value) => value.trim()).filter(Boolean).slice(0, 20) } : item))} placeholder="One criterion per line" /></label>
            </fieldset>
          ))}
          <Button size="sm" disabled={busy} onClick={() => setSteps((current) => [...current, { id: crypto.randomUUID(), providerId: null, title: 'New step', description: '', acceptanceCriteria: [], dependsOn: [], status: 'pending' }])}><Plus size={13} /> Add step</Button>
          <div className="plan-card__actions">
            <Button variant="primary" size="sm" busy={busy} disabled={busy || steps.some((step) => !step.title.trim())} onClick={save}><Check size={13} /> Save revision</Button>
            <Button size="sm" disabled={busy} onClick={() => { setExplanation(plan.explanation); setSteps(plan.steps); setEditing(false); setError(null); }}>Cancel</Button>
          </div>
        </div>
      ) : (
        <>
          {plan.explanation ? <div className="plan-card__context"><Markdown text={plan.explanation} /></div> : null}
          <ol className="plan-card__steps">
            {plan.steps.map((step) => (
              <li key={step.id}>
                <strong>{step.title}</strong>
                {step.description ? <p>{step.description}</p> : null}
                {step.acceptanceCriteria.length ? <ul>{step.acceptanceCriteria.map((criterion, index) => <li key={`${step.id}:${index}`}>{criterion}</li>)}</ul> : null}
                {step.dependsOn.length ? <small>Depends on {step.dependsOn.map((id) => plan.steps.find((candidate) => candidate.id === id)?.title ?? id).join(', ')}</small> : null}
              </li>
            ))}
          </ol>
          <div className="plan-card__actions">
            {canRevise ? <>
              <Button size="sm" disabled={busy} onClick={() => { setExplanation(plan.explanation); setSteps(plan.steps); setEditing(true); }}><Pencil size={13} /> {canReview ? 'Edit' : 'Revise plan'}</Button>
            </> : null}
            {canReview ? <>
              <Button variant="primary" size="sm" busy={busy} disabled={busy || !plan.steps.length} onClick={approve}><Check size={13} /> Approve plan</Button>
            </> : null}
            {canReview && !plan.steps.length ? <span className="plan-card__hint">Add at least one step to approve this plan.</span> : null}
            {plan.status === 'approved' ? <Button variant="primary" size="sm" busy={busy} disabled={busy} onClick={execute}><Play size={13} /> Execute approved plan</Button> : null}
            {plan.status === 'review' && !reviewReady ? <span className="plan-card__hint">Plan review becomes available when the provider finishes.</span> : null}
            {plan.status === 'executing' && plan.executionRunId ? <span className="plan-card__hint">Execution run {plan.executionRunId}</span> : null}
          </div>
        </>
      )}
      {error ? <p className="plan-card__error" role="alert">{error}</p> : null}
      <footer>Revision {plan.revision} · {PLAN_STATUS[plan.status]} · {plan.provider}</footer>
    </section>
  );
}

interface QuestionValue { selected: string[]; other: string; otherSelected: boolean }
const initialQuestionValues = (question: UserQuestion): Record<string, QuestionValue> => Object.fromEntries(question.questions.map((field) => {
  const saved = field.secret ? [] : question.answers?.[field.id] ?? [];
  const allowed = new Set(field.options.map((option) => option.label));
  const custom = saved.filter((value) => !allowed.has(value));
  return [field.id, { selected: saved.filter((value) => allowed.has(value)), other: custom.join(', '), otherSelected: custom.length > 0 }];
}));

export function UserQuestionCard({ question, speaker }: { question: UserQuestion; speaker?: Pick<Speaker, 'handle' | 'memberId'> | null }) {
  const [values, setValues] = useState<Record<string, QuestionValue>>(() => initialQuestionValues(question));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = question.status === 'pending';
  useEffect(() => {
    setValues(initialQuestionValues(question)); setError(null);
  }, [question.id, question.status, question.resolvedAt]);
  const setValue = (fieldId: string, update: (value: QuestionValue) => QuestionValue) => setValues((current) => ({ ...current, [fieldId]: update(current[fieldId] ?? { selected: [], other: '', otherSelected: false }) }));
  const act = async (action: 'answer' | 'cancel') => {
    setBusy(true); setError(null);
    try {
      if (action === 'answer') {
        const answers: UserInputAnswers = Object.fromEntries(question.questions.map((field) => {
          const value = values[field.id] ?? { selected: [], other: '', otherSelected: false };
          return [field.id, [...value.selected, ...(field.allowOther && value.otherSelected && value.other.trim() ? [value.other.trim()] : [])]];
        }));
        await api.answerQuestion(question.id, answers);
        // Clear sensitive text as soon as it has been handed to the active provider request.
        setValues((current) => Object.fromEntries(Object.entries(current).map(([id, value]) => [id, question.questions.find((field) => field.id === id)?.secret ? { selected: [], other: '', otherSelected: false } : value])));
      } else await api.cancelQuestion(question.id);
      await useMingle.getState().refreshNow();
    } catch (cause) {
      setError(errorMessage(cause));
      void useMingle.getState().refreshNow();
    } finally { setBusy(false); }
  };
  return (
    <section className="question-card" aria-label={`Provider question, ${question.status}`}>
      <header className="question-card__header">
        <CircleHelp size={15} aria-hidden="true" />
        <strong>{pending ? 'Provider needs your input' : question.status === 'answered' ? 'Provider question answered' : 'Provider question cancelled'}</strong>
        {speaker ? <AgentIdentity className="question-card__who" handle={speaker.handle} identityKey={speaker.memberId} /> : null}
      </header>
      {question.questions.map((field) => {
        const value = values[field.id] ?? { selected: [], other: '', otherSelected: false };
        const saved = field.secret ? [] : question.answers?.[field.id] ?? [];
        return (
          <fieldset className="question-card__field" key={field.id} disabled={!pending || busy}>
            <legend>{field.header ? `${field.header} · ` : ''}{field.question}{field.secret ? <span>Secret</span> : null}</legend>
            {field.options.map((option) => (
              <label className="question-card__option" key={option.label}>
                <input type={field.multiSelect ? 'checkbox' : 'radio'} name={`question-${question.id}-${field.id}`} checked={value.selected.includes(option.label)} onChange={(event) => setValue(field.id, (current) => ({ ...current, selected: field.multiSelect ? event.target.checked ? [...current.selected, option.label] : current.selected.filter((item) => item !== option.label) : [option.label], otherSelected: field.multiSelect ? current.otherSelected : false }))} />
                <span><strong>{option.label}</strong>{option.description ? <small>{option.description}</small> : null}</span>
              </label>
            ))}
            {field.allowOther ? (
              <label className="question-card__other">
                <input type={field.multiSelect ? 'checkbox' : 'radio'} name={`question-${question.id}-${field.id}`} checked={value.otherSelected} onChange={(event) => setValue(field.id, (current) => ({ ...current, otherSelected: event.target.checked, selected: field.multiSelect || !event.target.checked ? current.selected : [] }))} />
                <span>Other</span>
                <input aria-label={`Other answer for ${field.question}`} type={field.secret ? 'password' : 'text'} autoComplete="off" maxLength={1000} value={value.other} onChange={(event) => setValue(field.id, (current) => ({ ...current, other: event.target.value, otherSelected: true, selected: field.multiSelect ? current.selected : [] }))} />
              </label>
            ) : null}
            {!pending && (field.secret ? <p className="question-card__saved">Secret response sent; the value is not retained.</p> : saved.length ? <p className="question-card__saved">Response: {saved.join(', ')}</p> : null)}
          </fieldset>
        );
      })}
      {pending ? <div className="question-card__actions"><Button variant="primary" size="sm" busy={busy} disabled={busy || question.questions.some((field) => { const value = values[field.id] ?? { selected: [], other: '', otherSelected: false }; return !value.selected.length && !(field.allowOther && value.otherSelected && value.other.trim()); })} onClick={() => void act('answer')}><Check size={13} /> Submit answers</Button><Button size="sm" disabled={busy} onClick={() => void act('cancel')}><X size={13} /> Cancel request</Button><span>Answers are sent directly to {question.provider}.</span></div> : question.reason ? <p className="question-card__saved">{question.reason}</p> : null}
      {error ? <p className="question-card__error" role="alert">{error}</p> : null}
    </section>
  );
}
