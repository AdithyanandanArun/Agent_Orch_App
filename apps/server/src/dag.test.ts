import { describe, expect, it } from 'vitest';
import { checkTransition, findCycle, topologicalOrder, unfinishedDeps } from './dag.ts';

const graph = (edges: Record<string, string[]>) => (id: string) => edges[id];

describe('task dependency graph', () => {
  it('detects direct, indirect and self cycles', () => {
    expect(findCycle('a', ['a'], graph({}))).toEqual(['a', 'a']);
    expect(findCycle('a', ['b'], graph({ b: ['a'] }))).toEqual(['a', 'b', 'a']);
    expect(findCycle('a', ['b'], graph({ b: ['c'], c: ['d'], d: ['a'] }))).toEqual(['a', 'b', 'c', 'd', 'a']);
  });

  it('accepts diamonds and shared prerequisites', () => {
    const edges = { b: ['root'], c: ['root'], root: [] };
    expect(findCycle('d', ['b', 'c'], graph(edges))).toBeNull();
  });

  it('orders a DAG topologically and rejects cycles', () => {
    const order = topologicalOrder([
      { id: 'c', projectId: 'p', status: 'blocked', dependsOn: ['a', 'b'] },
      { id: 'b', projectId: 'p', status: 'blocked', dependsOn: ['a'] },
      { id: 'a', projectId: 'p', status: 'ready', dependsOn: [] },
    ]);
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('c'));
    expect(() => topologicalOrder([{ id: 'a', projectId: 'p', status: 'ready', dependsOn: ['b'] }, { id: 'b', projectId: 'p', status: 'ready', dependsOn: ['a'] }])).toThrow(/cycle/);
  });

  it('reports unfinished dependencies', () => {
    const status = (id: string) => ({ a: 'done', b: 'review', c: undefined } as const)[id as 'a'];
    expect(unfinishedDeps(['a', 'b', 'c'], status)).toEqual(['b', 'c']);
  });

  it('only allows transitions past unfinished dependencies when they are blocking states', () => {
    expect(checkTransition('blocked', 'ready', 1).ok).toBe(false);
    expect(checkTransition('ready', 'done', 1).ok).toBe(false);
    expect(checkTransition('backlog', 'ready', 0).ok).toBe(true);
    expect(checkTransition('review', 'done', 0).ok).toBe(true);
    expect(checkTransition('blocked', 'done', 0).ok).toBe(false);
    expect(checkTransition('ready', 'running', 0).ok).toBe(false);
    expect(checkTransition('running', 'ready', 0).ok).toBe(false);
  });
});
