/** Original neutral glyph for OpenCode sessions: a square frame with a small base block. Not the OpenCode wordmark or logo. */
export function OpenCodeMark({ className, size = 16 }: { className?: string; size?: number }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
    <rect x="4.5" y="3.5" width="15" height="17" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
    <rect x="8.5" y="13" width="7" height="3.5" rx="1" fill="currentColor" />
  </svg>;
}
