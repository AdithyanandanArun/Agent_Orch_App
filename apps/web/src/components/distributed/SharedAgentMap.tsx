import { useMemo, useState } from 'react';
import { Background, Controls, Position, ReactFlow, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useMingle } from '../../store/store';
import type { DistributedRecord } from './api';
import { idOf, nameOf, readText } from './viewModels';

/** All edges come from reported ownership, assignment or explicit dependency IDs. */
export function SharedAgentMap({ members, devices, agents, tasks }: {
  members: DistributedRecord[]; devices: DistributedRecord[]; agents: DistributedRecord[]; tasks: DistributedRecord[];
}) {
  const theme = useMingle((state) => state.boot?.settings.theme ?? 'dark');
  const [selected, setSelected] = useState<Node | null>(null);
  const graph = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const ids = new Set<string>();
    const add = (id: string, column: number, row: number, label: string, kind: string) => {
      if (ids.has(id)) return;
      ids.add(id);
      nodes.push({ id, data: { label, kind }, position: { x: column * 290, y: row * 100 }, sourcePosition: Position.Right, targetPosition: Position.Left, className: `dw-map-node dw-map-node--${kind}` });
    };
    const ownerIds = [...new Set([...members.map((row) => readText(row, ['userId'])), ...devices.map((row) => readText(row, ['ownerId']))].filter(Boolean))];
    ownerIds.slice(0, 40).forEach((id, i) => add(`owner:${id}`, 0, i, `Developer\n${id}`, 'owner'));
    devices.slice(0, 60).forEach((row, i) => add(`device:${idOf(row)}`, 1, i, `${nameOf(row, 'Device')}\n${readText(row, ['status'], 'unknown')}`, 'device'));
    agents.slice(0, 80).forEach((row, i) => add(`agent:${idOf(row)}`, 2, i, `${nameOf(row, 'Agent')}\n${readText(row, ['provider'])} / ${readText(row, ['presence'], 'unknown')}\nQuota ${readText(row, ['quotaState'], 'unknown')}`, 'agent'));
    const taskKey = (row: DistributedRecord, id = idOf(row)) => `task:${readText(row, ['deviceId'])}:${readText(row, ['sharedProjectId'])}:${id}`;
    tasks.slice(0, 80).forEach((row, i) => add(taskKey(row), 3, i, `${nameOf(row, 'Task')}\n${readText(row, ['status'], 'unknown')}`, 'task'));
    const link = (source: string, target: string, label: string) => {
      if (ids.has(source) && ids.has(target)) edges.push({ id: `${source}:${label}:${target}`, source, target, label, type: 'smoothstep', animated: false });
    };
    devices.slice(0, 60).forEach((row) => link(`owner:${readText(row, ['ownerId'])}`, `device:${idOf(row)}`, 'owns'));
    agents.slice(0, 80).forEach((row) => link(`device:${readText(row, ['deviceId'])}`, `agent:${idOf(row)}`, 'hosts'));
    tasks.slice(0, 80).forEach((row) => {
      link(`agent:${readText(row, ['agentId'])}`, taskKey(row), 'assigned');
      if (Array.isArray(row.dependsOn)) row.dependsOn.forEach((id) => { if (typeof id === 'string') link(taskKey(row, id), taskKey(row), 'required by'); });
    });
    return { nodes, edges, truncated: ownerIds.length > 40 || devices.length > 60 || agents.length > 80 || tasks.length > 80 };
  }, [members, devices, agents, tasks]);
  return <section className="dw-card">
    <div className="dw-section-head"><div><h3>Shared agent map</h3><p>Developers → devices → agents → tasks. Dependency edges use explicit task records.</p></div></div>
    {graph.nodes.length ? <div className="dw-shared-map"><ReactFlow nodes={graph.nodes} edges={graph.edges} colorMode={theme} fitView minZoom={0.08} maxZoom={1.5} nodesConnectable={false} nodesDraggable={false} onNodeClick={(_, node) => setSelected(node)} aria-label="Shared developers, devices, agents and tasks"><Background /><Controls showInteractive={false} /></ReactFlow></div> : <p className="dw-empty">No shared relationships have been reported.</p>}
    {selected && graph.nodes.some((node) => node.id === selected.id) ? <p className="dw-owner-note">{String(selected.data.label)} · {selected.id}</p> : null}
    {graph.truncated ? <p className="dw-owner-note">Map display limited to 40 developers, 60 devices, 80 agents and 80 tasks. The lists retain the remaining records.</p> : null}
  </section>;
}
