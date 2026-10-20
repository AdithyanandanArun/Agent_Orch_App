# UI motion

Mingle uses shared motion tokens rather than a separate animation framework. Keep the conversation readable and controls predictable: animate an interaction once, not each streamed token, elapsed-time update or background refresh.

## Timing and behavior

- Small feedback uses `--motion-fast` (120 ms).
- General feedback uses `--motion-ui` (180 ms).
- Overlay entry and exit use `--motion-overlay` (160 ms).
- Workspace panels use `--motion-panel` (260 ms).
- `--ease-out` handles reveals; `--ease-standard` handles state changes.
- Respect `prefers-reduced-motion: reduce`. Decoration must not delay a command, dismissal, focus return or provider action.

The helpers in `apps/web/src/lib/motion.ts` retain a surface briefly after logical dismissal. Closing content becomes inert and hidden from assistive technology immediately. A reopening cancels an old close timer. Dialog openings have distinct identities so an earlier form does not survive into a different opening.

Keep editors, browser hosts and terminals stable where their lifecycle requires it. Animation must not start another process, navigate a browser again or issue another provider request. Use explicit CSS transition properties rather than `transition: all`.

## Review guidance

Check dismissal by keyboard, outside click and explicit close; rapid close/reopen; focus restoration; viewport edges; narrow screens; reduced motion; and whether a hidden surface can still receive keyboard focus. Check shared primitives as well as independent dialogs and expandable panels.

Build and type checking establish compilation only. They do not establish smooth frame delivery on every desktop. Record browser automation limitations separately from observed behavior.
