import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../../lib/format';
import { usePresence } from '../../lib/motion';

interface Geometry { left: number; top: number; width: number; height: number }

function initialGeometry(): Geometry {
  return {
    left: Math.max(12, window.innerWidth - 500), top: Math.max(12, window.innerHeight - 380),
    width: Math.min(480, Math.max(320, window.innerWidth - 24)), height: Math.min(360, Math.max(240, window.innerHeight - 24)),
  };
}

function clampGeometry(value: Geometry): Geometry {
  const width = Math.min(Math.max(320, value.width), Math.max(320, window.innerWidth - 24));
  const height = Math.min(Math.max(240, value.height), Math.max(240, window.innerHeight - 24));
  return {
    left: Math.max(12, Math.min(window.innerWidth - width - 12, value.left)),
    top: Math.max(12, Math.min(window.innerHeight - height - 12, value.top)), width, height,
  };
}

/**
 * Moves one browser host between its docked slot, a modeless in-app picture-in-picture panel, and a full-window
 * overlay. The host is never cloned, so its socket, canvas and held-input cleanup survive layout changes.
 */
export function BrowserHost({
  expanded, floating, onDismiss, onDock, onPopout, children,
}: {
  expanded: boolean; floating: boolean; onDismiss(): void; onDock(): void; onPopout?: () => void; children: ReactNode;
}) {
  const host = useMemo(() => {
    const element = document.createElement('div');
    element.className = 'browser';
    return element;
  }, []);
  const inline = useRef<HTMLDivElement>(null);
  const floatingSlot = useRef<HTMLDivElement>(null);
  const floatingPanel = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const dragCleanup = useRef<(() => void) | null>(null);
  const [overlaySlot, setOverlaySlot] = useState<HTMLDivElement | null>(null);
  const [geometry, setGeometry] = useState<Geometry>(initialGeometry);
  const { present: overlayPresent, closing: overlayClosing } = usePresence(expanded);

  useLayoutEffect(() => {
    const target = expanded ? overlaySlot : floating ? floatingSlot.current : inline.current;
    if (!target || host.parentNode === target) return;
    const focused = document.activeElement instanceof HTMLElement && host.contains(document.activeElement) ? document.activeElement : null;
    if (expanded && focused) returnFocus.current = focused;
    target.appendChild(host);
    const next = focused ?? (!expanded ? returnFocus.current : null);
    if (next?.isConnected) next.focus({ preventScroll: true });
    if (!expanded) returnFocus.current = null;
  }, [expanded, floating, overlaySlot, host]);

  useEffect(() => () => dragCleanup.current?.(), []);
  useEffect(() => {
    if (!floating || expanded) return;
    const panel = floatingPanel.current;
    if (!panel) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const bounds = panel.getBoundingClientRect();
      setGeometry((previous) => {
        const next = clampGeometry({ ...previous, width: bounds.width, height: bounds.height });
        return next.width === previous.width && next.height === previous.height ? previous : next;
      });
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, [floating, expanded]);
  useEffect(() => {
    const resize = () => setGeometry((value) => clampGeometry(value));
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useLayoutEffect(() => {
    if (!expanded || !overlaySlot) return;
    const focusable = () => Array.from(host.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])'))
      .filter((element) => element.getClientRects().length > 0);
    if (!host.contains(document.activeElement)) (focusable()[0] ?? overlaySlot).focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss.current(); return; }
      if (event.key !== 'Tab') return;
      const items = focusable();
      const first = items[0], last = items.at(-1);
      if (!first || !last) { event.preventDefault(); overlaySlot.focus(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    overlaySlot.addEventListener('keydown', onKey);
    return () => overlaySlot.removeEventListener('keydown', onKey);
  }, [expanded, overlaySlot, host]);

  const onDragStart = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
    const origin = floatingPanel.current?.getBoundingClientRect();
    if (!origin) return;
    event.preventDefault();
    const startX = event.clientX, startY = event.clientY, left = origin.left, top = origin.top;
    const move = (next: PointerEvent) => {
      if (next.pointerId !== event.pointerId) return;
      setGeometry((previous) => clampGeometry({ ...previous, left: left + next.clientX - startX, top: top + next.clientY - startY }));
    };
    const finish = (next: PointerEvent) => {
      if (next.pointerId !== event.pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      dragCleanup.current = null;
    };
    dragCleanup.current?.();
    dragCleanup.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  }, []);

  const onDragKey = (event: React.KeyboardEvent<HTMLElement>) => {
    const delta = event.shiftKey ? 40 : 12;
    const next = { ...geometry };
    if (event.key === 'ArrowLeft') next.left -= delta;
    else if (event.key === 'ArrowRight') next.left += delta;
    else if (event.key === 'ArrowUp') next.top -= delta;
    else if (event.key === 'ArrowDown') next.top += delta;
    else return;
    event.preventDefault();
    setGeometry(clampGeometry(next));
  };

  return (
    <>
      <div className="browser-slot" ref={inline} />
      {floating && !expanded ? createPortal(
        <section
          className="browser-pip" ref={floatingPanel}
          style={{ left: geometry.left, top: geometry.top, width: geometry.width, height: geometry.height }}
          aria-label="Floating shared browser"
        >
          <header className="browser-pip__handle" tabIndex={0} aria-label="Move floating browser with arrow keys; hold Shift to move farther" onPointerDown={onDragStart} onKeyDown={onDragKey}>
            <span className="browser-pip__title">Shared browser</span>
            {onPopout ? <button type="button" className="browser-pip__action" onClick={onPopout}>Open desktop window</button> : null}
            <button type="button" className="browser-pip__action" onClick={onDock}>Dock browser</button>
          </header>
          <div className="browser-pip__content" ref={floatingSlot} />
        </section>, document.body,
      ) : null}
      {overlayPresent ? createPortal(
        <div className={cx('browser-overlay', overlayClosing && 'is-closing')} aria-hidden={overlayClosing || undefined} inert={overlayClosing} onMouseDown={(e) => { if (!overlayClosing && e.target === e.currentTarget) onDismiss(); }}>
          <div className="browser-overlay__panel" role="dialog" aria-modal="true" aria-label="Shared browser" tabIndex={-1} ref={setOverlaySlot} />
        </div>,
        document.body,
      ) : null}
      {createPortal(children, host)}
    </>
  );
}
