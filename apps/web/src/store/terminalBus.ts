/** Output fan-out for the terminal. Kept outside React state so high-rate PTY data never re-renders the app. */
const MAX_BUFFER = 400_000;
let buffer = '';
const sinks = new Set<(data: string | null) => void>();

export const terminalBus = {
  push(data: string): void {
    buffer += data;
    if (buffer.length > MAX_BUFFER) buffer = buffer.slice(buffer.length - MAX_BUFFER);
    sinks.forEach((s) => s(data));
  },
  reset(): void {
    buffer = '';
    sinks.forEach((s) => s(null));
  },
  snapshot: (): string => buffer,
  subscribe(sink: (data: string | null) => void): () => void {
    sinks.add(sink);
    return () => {
      sinks.delete(sink);
    };
  },
};
