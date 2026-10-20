import type { GroupMode, GroupMember } from '@relay/contracts';
import { redactSecrets, truncate } from '../util.ts';
import type { DeliveryKind } from './repo.ts';

export const LIMITS = {
  instructions: 6000, request: 1500, deliveryText: 12000, summary: 1400, inboxMessage: 1500, inboxCount: 20, message: 12000,
} as const;

export const clean = (text: string, max: number): string => truncate(redactSecrets(text).replaceAll('\0', ''), max);

export const MODE_LABEL: Record<GroupMode, string> = { cowork: 'Cowork', orchestrated: 'Orchestrated', 'current-leads': 'Current agent leads' };

export interface RosterEntry { handle: string; role: GroupMember['role']; provider: string; model: string; state: string; you: boolean }

export interface InstructionData {
  title: string; mode: GroupMode; self: RosterEntry; roster: RosterEntry[]; canAssign: boolean; leaseHolder: string | null;
  requestExcerpt: string; deliveryKind: DeliveryKind; hop: number; maxHops: number; turnsUsed: number; maxTurns: number; unread: number;
  assignment: { id: string; taskId: string; scope: string[] } | null;
}

const ROLE_RULE: Record<GroupMember['role'], string> = {
  peer: 'You are an equal peer. The human directs the work; you may message peers but assign work only while you hold the request planning lease.',
  orchestrator: 'You are the orchestrator: split work, assign scoped tasks to workers with team_assign, review their results and answer the human.',
  worker: 'You are a worker: do the assigned scope, report with team_status/team_artifact, and ask the orchestrator through team_message when blocked. You cannot assign work.',
};

const WORKER_COMPLETION = 'Completion: send one concise completion, not repeats. For each committed file revision you actually produced, call team_artifact (one revision per call; never invent an artifact when nothing is committed), then team_status review, then your final summary of changes, checks you ran and caveats. Do not send team_message completion acknowledgments or wake peers just to repeat completion.';
const COORDINATOR_COMPLETION = 'Final answer to the human: begin with the outcome, Implemented, Partially complete or Blocked, plus material caveats. Then state each @agent\'s contribution; where the work is actually integrated (worktree, branch or commit; the selected checkout only if that was authorized and done); which checks you ran yourself versus which a peer reported; and what still needs review or user action. If any worker is still running, say Pending instead of claiming it is done. Review tasks are not Done until a human accepts them.';

/** Bounded per-run guidance. Native history, roster and request excerpt only; never other members' transcripts. */
export function buildInstructions(d: InstructionData): string {
  const lines = [
    `[Relay group conversation "${clean(d.title, 80)}" · ${MODE_LABEL[d.mode]}]`,
    `You are @${d.self.handle} (${d.self.role}). ${ROLE_RULE[d.self.role]}`,
  ];
  if (d.mode === 'cowork') {
    lines.push(d.leaseHolder === d.self.handle
      ? 'You hold this request\'s temporary planning lease: propose a split, do your own share, and use team_assign for each other peer\'s concrete scope. Peers wait for your assignment before editing.'
      : 'Cowork request receipt is not execution. Edit only after you receive an assignment with a concrete scope, or when the human addresses you directly.');
  }
  const context = ['', 'Team:'];
  for (const row of d.roster.slice(0, 12)) context.push(`- @${row.handle} · ${row.role} · ${row.provider}/${clean(row.model, 60)} · ${row.state}${row.you ? ' (you)' : ''}`);
  context.push('', `Request: ${clean(d.requestExcerpt, LIMITS.request)}`);
  context.push(`This turn: ${d.deliveryKind} delivery, message hop ${d.hop}/${d.maxHops}, request turns used ${d.turnsUsed}/${d.maxTurns}.`);
  if (d.assignment) context.push(`Assignment ${d.assignment.id} (task ${d.assignment.taskId}). Edit only within: ${d.assignment.scope.join(', ')}.`);
  if (d.unread > 0) context.push(`${d.unread} unread team message(s) are waiting; call team_inbox.`);
  const rules = [
    '',
    'Rules: your own earlier conversation is in your native history; other members\' transcripts are not shared, so ask with team_message or read team_inbox.',
    'Use the team_* tools to reach teammates. Writing @handle in prose never dispatches anything. Tool success means queued or recorded, not completed.',
    'team_message expectsReply:false records information without waking a model. Set expectsReply:true only when the recipient needs a turn, including an answer that should let a blocked teammate continue. Use replyToId when answering so Relay can cancel a redundant queued question turn.',
    'Report completion in your final answer; a human reviews task results before they are marked done.',
    d.canAssign
      ? 'You may prepare integration in your own scoped worktree under the selected permission policy. Never push or publish, or modify the human-selected checkout, without explicit human authorization.'
      : 'Keep edits inside your assignment and own worktree. Ask the coordinator or human before integration; never push or publish without explicit human authorization.',
    d.canAssign ? COORDINATOR_COMPLETION : WORKER_COMPLETION,
  ];
  // Completion guidance is kept whole: only the roster and request context yield when the bound is reached.
  const fixed = [...lines, ...rules].join('\n');
  const room = Math.max(0, LIMITS.instructions - fixed.length - 1);
  const body = truncate(context.join('\n'), room);
  return truncate([...lines, body, ...rules].join('\n'), LIMITS.instructions);
}

export function describeSender(handle: string | null): string { return handle ? `@${handle}` : 'Relay'; }

export function requestDeliveryText(d: { content: string; handle: string; planner: boolean; mode: GroupMode; directed: boolean }): string {
  const lines = ['Request from the human in the group conversation:', clean(d.content, 100_000)];
  if (d.mode === 'cowork' && !d.directed) {
    lines.push('', d.planner
      ? 'You are the temporary planner for this request. Propose a non-overlapping split, then use team_assign to give each other peer a concrete scope; do your own share.'
      : 'Wait for an assignment.');
  }
  return lines.join('\n');
}

export function assignmentText(d: {
  id: string; taskId: string; from: string; to: string; title: string; objective: string; acceptance: string; scope: string[];
  request: string; dependsOn: Array<{ taskId: string; title: string; status: string }>; inputs: Array<{ taskId: string; path: string; reference: string | null }>;
}): string {
  const lines = [
    `Assignment ${d.id} from @${d.from} to @${d.to} (task ${d.taskId}): ${clean(d.title, 200)}`,
    '', 'Original request:', clean(d.request, LIMITS.request),
    '', 'Objective:', clean(d.objective, 6000),
  ];
  if (d.acceptance.trim()) lines.push('', 'Acceptance criteria:', clean(d.acceptance, 2000));
  lines.push('', 'Edit scope (stay inside these paths):', ...d.scope.map((scope) => `- ${scope}`));
  if (d.dependsOn.length) lines.push('', 'Prerequisite tasks:', ...d.dependsOn.map((dep) => `- ${dep.taskId}: ${clean(dep.title, 120)} (${dep.status})`));
  if (d.inputs.length) {
    lines.push('', 'Expected input artifacts (verified handoff messages appear in your session when published):', ...d.inputs.map((input) => `- task ${input.taskId}: ${input.path}${input.reference ? ` · ${input.reference}` : ''}`));
  }
  lines.push('', 'Report progress with team_status; finish with one completion (team_artifact per committed file revision, team_status review, then a summary of changes and verification). The task goes to Review, not Done.');
  return truncate(lines.join('\n'), LIMITS.message);
}

export function messageDeliveryText(d: { from: string; content: string }): string {
  return `Message from @${d.from} (a reply is requested; answer with team_message to them):\n${clean(d.content, LIMITS.deliveryText)}`;
}

export interface ResultLine { handle: string; title: string; outcome: string; summary: string }
export function resultText(lines: ResultLine[]): string {
  const rows = lines.flatMap((row) => [`- @${row.handle} · ${clean(row.title, 120)} · ${row.outcome}`, row.summary ? `  ${clean(row.summary, LIMITS.summary).replaceAll('\n', '\n  ')}` : '']).filter(Boolean);
  return truncate([
    'Delegated work from your latest batch has finished. Native results below are bounded excerpts; inspect worker worktrees or artifacts for detail.',
    ...rows, '', 'Inspect the actual artifacts and worktrees, integrate authorized work within your own scope or location, then send one self-contained final summary for the human (outcome first, each agent\'s contribution, where it landed, checks run versus peer-reported, remaining review or action). Do not claim Done for tasks in Review. Use team_assign only if specific work remains.',
  ].join('\n'), LIMITS.message);
}
