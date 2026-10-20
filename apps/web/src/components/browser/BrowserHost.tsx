import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../../lib/format';
import { usePresence } from '../../lib/motion';

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
  const returnFocus = useRef<HTMLElement | null>(null);
  const [overlaySlot, setOverlaySlot] = useState<HTMLDivElement | null>(null);
  const { present: overlayPresent, closing: overlayClosing } = usePresence(expanded);

  useLayoutEffect(() => {
    const target = expanded ? overlaySlot : inline.current;
    if (!target || host.parentNode === target) return;
    const focused = document.activeElement instanceof HTMLElement && host.contains(document.activeElement) ? document.activeElement : null;
    if (expanded && focused) returnFocus.current = focused;
    target.appendChild(host);
    const next = focused ?? (!expanded ? returnFocus.current : null);
    if (next?.isConnected) next.focus({ preventScroll: true });
    if (!expanded) returnFocus.current = null;
  }, [expanded, overlaySlot, host]);

  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useLayoutEffect(() => {
    if (!expanded || !overlaySlot) return;
    const focusable = () => Array.from(host.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])'))
      .filter((element) => element.getClientRects().length > 0);
    if (!host.contains(document.activeElement)) (focusable()[0] ?? overlaySlot).focus({ preventScroll: true });
    // Native bubbling also covers children rendered through the separate host portal. The page surface stops
    // propagation for remote keys, so Escape and Tab still reach the browser while it owns keyboard focus.
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
    return () => {
      overlaySlot.removeEventListener('keydown', onKey);
    };
  }, [expanded, overlaySlot, host]);

  return (
    <>
      <div className="browser-slot" ref={inline} />
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
