import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Renders `children` once, into a detached element that is moved between the in-pane slot and a full-window
 * overlay. Moving the element (rather than re-rendering elsewhere) keeps a single viewer socket, canvas and
 * input state alive when the user expands the browser.
 */
export function BrowserHost({ expanded, onDismiss, children }: { expanded: boolean; onDismiss(): void; children: ReactNode }) {
  const host = useMemo(() => {
    const element = document.createElement('div');
    element.className = 'browser';
    return element;
  }, []);
  const inline = useRef<HTMLDivElement>(null);
  const [overlaySlot, setOverlaySlot] = useState<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const target = expanded ? overlaySlot : inline.current;
    if (!target || host.parentNode === target) return;
    const focused = document.activeElement instanceof HTMLElement && host.contains(document.activeElement) ? document.activeElement : null;
    target.appendChild(host);
    if (focused?.isConnected) focused.focus({ preventScroll: true });
  }, [expanded, overlaySlot, host]);

  return (
    <>
      <div className="browser-slot" ref={inline} />
      {expanded ? createPortal(
        <div className="browser-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onDismiss(); }}>
          <div className="browser-overlay__panel" role="dialog" aria-label="Shared browser" ref={setOverlaySlot} />
        </div>,
        document.body,
      ) : null}
      {createPortal(children, host)}
    </>
  );
}
