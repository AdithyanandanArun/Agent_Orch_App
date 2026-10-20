import { useEffect, useState, type RefObject } from 'react';
import type { GroupMode } from '@mingle/contracts';

/** Illustrative flow only: nothing here reflects a live run. */
export function ModeDiagram({ mode, existing, added, svgRef }: { mode: GroupMode; existing: string; added: string; svgRef?: (el: SVGSVGElement | null) => void }) {
  const common = { className: 'gm-diagram', viewBox: '0 0 360 210', 'aria-hidden': true, focusable: false, 'data-mode': mode, ref: svgRef } as const;
  if (mode === 'cowork') {
    return (
      <svg {...common}>
        <path className="gm-wire" d="M180 48V78M180 78H86V124M180 78H274V124" />
        <path className="gm-wire gm-wire--peer" d="M151 151H209" />
        <rect className="gm-node gm-node--you" x="147" y="18" width="66" height="30" rx="8" /><text className="gm-label" x="180" y="37">You</text>
        <rect className="gm-node" x="21" y="124" width="130" height="54" rx="9" /><text className="gm-label" x="86" y="146">@{existing}</text><text className="gm-note" x="86" y="163">Peer · current agent</text>
        <rect className="gm-node" x="209" y="124" width="130" height="54" rx="9" /><text className="gm-label" x="274" y="146">@{added}</text><text className="gm-note" x="274" y="163">Peer · new agent</text>
        <text className="gm-split" x="86" y="110">Proposes this split</text><text className="gm-note" x="180" y="199">Direct questions &amp; results</text>
        <circle className="gm-packet" r="3"><animateMotion dur="5.5s" repeatCount="indefinite" path="M180 48V78H86V124" /></circle>
        <circle className="gm-packet" r="3"><animateMotion dur="5.5s" repeatCount="indefinite" path="M180 48V78H274V124" /></circle>
        <circle className="gm-packet gm-packet--return" r="2.5"><animateMotion dur="4s" repeatCount="indefinite" path="M151 151H209H151" /></circle>
      </svg>
    );
  }
  if (mode === 'orchestrated') {
    return (
      <svg {...common}>
        <path className="gm-wire" d="M180 35V65M180 99V119H86V144M180 119H274V144" />
        <rect className="gm-node gm-node--you" x="147" y="5" width="66" height="30" rx="8" /><text className="gm-label" x="180" y="24">You</text>
        <rect className="gm-node" x="112" y="65" width="136" height="34" rx="8" /><text className="gm-label" x="180" y="86">Orchestrator</text><text className="gm-note" x="278" y="85">From Settings</text>
        <rect className="gm-node" x="21" y="144" width="130" height="48" rx="9" /><text className="gm-label" x="86" y="164">@{existing}</text><text className="gm-note" x="86" y="180">Worker · current agent</text>
        <rect className="gm-node" x="209" y="144" width="130" height="48" rx="9" /><text className="gm-label" x="274" y="164">@{added}</text><text className="gm-note" x="274" y="180">Worker · new agent</text>
        <circle className="gm-packet" r="3"><animateMotion dur="7s" repeatCount="indefinite" path="M180 35V65V99V119H86V144V119H180V99V65V35" /></circle>
        <circle className="gm-packet gm-packet--return" r="2.5"><animateMotion dur="7s" repeatCount="indefinite" path="M180 99V119H274V144V119H180V99" /></circle>
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path className="gm-wire" d="M180 35V65M180 115V147" />
      <rect className="gm-node gm-node--you" x="147" y="5" width="66" height="30" rx="8" /><text className="gm-label" x="180" y="24">You</text>
      <rect className="gm-node" x="91" y="65" width="178" height="50" rx="9" /><text className="gm-label" x="180" y="86">@{existing}</text><text className="gm-note" x="180" y="102">Orchestrator · current agent</text>
      <rect className="gm-node" x="91" y="147" width="178" height="48" rx="9" /><text className="gm-label" x="180" y="167">@{added}</text><text className="gm-note" x="180" y="183">Worker · new agent</text>
      <circle className="gm-packet" r="3"><animateMotion dur="6s" repeatCount="indefinite" path="M180 35V65V115V147" /></circle>
      <circle className="gm-packet gm-packet--return" r="2.5"><animateMotion dur="6s" repeatCount="indefinite" path="M180 147V115V65V35" /></circle>
    </svg>
  );
}

/** User-controlled pause plus the system reduced-motion preference. Only the selected (or, before a choice, every) diagram animates. */
export function useDiagramMotion(root: RefObject<HTMLElement | null>, selected: GroupMode | null): { paused: boolean; reduced: boolean; toggle: () => void } {
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    for (const svg of root.current?.querySelectorAll<SVGSVGElement>('svg.gm-diagram') ?? []) {
      const play = !paused && !reduced && (!selected || svg.dataset.mode === selected);
      if (typeof svg.pauseAnimations === 'function') { if (play) svg.unpauseAnimations(); else svg.pauseAnimations(); }
    }
  });
  return { paused: paused || reduced, reduced, toggle: () => setPaused((value) => !value) };
}
