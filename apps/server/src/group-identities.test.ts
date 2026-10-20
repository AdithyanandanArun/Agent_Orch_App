import { expect, it } from 'vitest';
import type { GroupMember } from '@mingle/contracts';
import { AGENT_PALETTE, groupAgentColors } from '../../web/src/lib/agentColors';

const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
const member = (index: number, joined = index): GroupMember => ({
  id: `member-${index}`, groupId: 'group', sessionId: `session-${index}`, handle: `codex${index + 1}`,
  role: 'peer', joinedAt: at(joined), removedAt: null,
});

it('gives all eight active agents distinct colors, including agents using the same provider', () => {
  const members = Array.from({ length: 8 }, (_, index) => member(index));
  const colors = groupAgentColors(members);
  expect(new Set([...colors.values()].map(color => color.dark)).size).toBe(8);
  expect(new Set([...colors.values()].map(color => color.light)).size).toBe(8);
  expect(groupAgentColors(JSON.parse(JSON.stringify(members)))).toEqual(colors);
});

it('retains historical and surviving colors when a later agent takes a freed membership slot', () => {
  const members = Array.from({ length: 8 }, (_, index) => member(index));
  const before = groupAgentColors(members);
  members[1] = { ...members[1]!, removedAt: at(9) };
  members.push(member(8, 10));
  const after = groupAgentColors(members);
  for (const old of members.slice(0, 8)) expect(after.get(old.sessionId)).toEqual(before.get(old.sessionId));
  expect(after.get('session-8')).toEqual(AGENT_PALETTE[1]);
  expect(new Set(members.filter(row => !row.removedAt).map(row => after.get(row.sessionId)?.dark)).size).toBe(8);
});
