import { create } from 'zustand';
import type { BrowserSessionState, BrowserTab } from '@relay/contracts';

interface BrowserUiState {
  /** Last session state the visible pane fetched; lets other surfaces (tab marker) read it without polling. */
  states: Record<string, BrowserSessionState>;
  /** Tab each session's viewer was explicitly pointed at; absent means follow the server's active tab. */
  selected: Record<string, string>;
  publish(sessionId: string, state: BrowserSessionState): void;
  select(sessionId: string, tabId: string | null): void;
}

export const useBrowserStore = create<BrowserUiState>((set) => ({
  states: {},
  selected: {},
  publish: (sessionId, state) => set((s) => ({ states: { ...s.states, [sessionId]: state } })),
  select: (sessionId, tabId) => set((s) => {
    const selected = { ...s.selected };
    if (tabId) selected[sessionId] = tabId; else delete selected[sessionId];
    return { selected };
  }),
}));

/** The tab a viewer should show: its own choice when still open, otherwise the server's active tab. */
export function resolveTab(state: BrowserSessionState | undefined, selectedId: string | undefined): BrowserTab | null {
  if (!state || state.status !== 'connected') return null;
  return state.tabs.find((t) => t.id === selectedId) ?? state.tabs.find((t) => t.id === state.activeTabId) ?? state.tabs[0] ?? null;
}
