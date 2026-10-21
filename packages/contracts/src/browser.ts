import { z } from 'zod';

export interface BrowserSource { id: string; name: string; userDataDir: string; debuggingAvailable: boolean }
export interface BrowserDiscovery {
  sources: BrowserSource[]; managedAvailable: boolean; managedExecutable: string | null;
  installing: boolean; notices: string[];
}
export interface BrowserTab {
  id: string; url: string; title: string; managed: boolean;
  viewport: { width: number; height: number }; controlOwner: string | null;
  dialog: { type: string; message: string } | null;
}
export interface BrowserSessionState {
  sessionId: string; status: 'disconnected' | 'connecting' | 'connected' | 'error';
  mode: 'managed' | 'existing' | null; tabs: BrowserTab[]; activeTabId: string | null;
  error: string | null; notices: string[];
}
export interface BrowserSnapshot {
  tab: BrowserTab; accessibility: string; text: string; truncated: boolean;
  screenshot?: { data: string; mimeType: 'image/png' };
}
export const BrowserConnectSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('managed') }).strict(),
  z.object({ mode: z.literal('existing'), sourceId: z.string().min(1).max(200).optional(), endpoint: z.string().min(1).max(2048).optional(), consent: z.literal(true) }).strict(),
]);
export type BrowserConnect = z.infer<typeof BrowserConnectSchema>;
/** Bounded per-viewer stream settings. These are transport caps, not an FPS guarantee. */
export const BrowserStreamProfileSchema = z.enum(['saver', 'balanced', 'sharp', 'smooth']);
export type BrowserStreamProfile = z.infer<typeof BrowserStreamProfileSchema>;
const target = {
  selector: z.string().min(1).max(2000).optional(), ref: z.string().min(1).max(100).optional(),
  role: z.string().min(1).max(80).optional(), name: z.string().max(500).optional(),
};
const coordinate = z.number().finite().min(0).max(16384);
export const BrowserActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('navigate'), url: z.string().min(1).max(4096) }).strict(),
  z.object({ type: z.enum(['back', 'forward', 'reload', 'close']) }).strict(),
  z.object({ type: z.literal('click'), ...target, x: coordinate.optional(), y: coordinate.optional(), button: z.enum(['left', 'middle', 'right']).optional() }).strict(),
  z.object({ type: z.literal('hover'), ...target }).strict(),
  z.object({ type: z.literal('type'), ...target, text: z.string().max(10000), clear: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('select'), ...target, values: z.array(z.string().max(500)).min(1).max(30) }).strict(),
  z.object({ type: z.literal('press'), key: z.string().min(1).max(100) }).strict(),
  z.object({ type: z.literal('text'), text: z.string().max(10000) }).strict(),
  z.object({ type: z.literal('scroll'), deltaX: z.number().finite().min(-10000).max(10000).default(0), deltaY: z.number().finite().min(-10000).max(10000), x: coordinate.optional(), y: coordinate.optional() }).strict(),
  z.object({ type: z.literal('resize'), width: z.number().int().min(320).max(2560), height: z.number().int().min(240).max(1600) }).strict(),
  z.object({ type: z.literal('evaluate'), expression: z.string().min(1).max(20000) }).strict(),
  z.object({ type: z.literal('wait'), ...target, text: z.string().max(500).optional(), timeoutMs: z.number().int().min(1).max(10000).optional() }).strict(),
  z.object({ type: z.literal('dialog'), accept: z.boolean(), promptText: z.string().max(10000).optional() }).strict(),
  z.object({ type: z.literal('pointer'), phase: z.enum(['move', 'down', 'up']), x: coordinate, y: coordinate, button: z.enum(['left', 'middle', 'right']).optional() }).strict(),
]);
export type BrowserAction = z.infer<typeof BrowserActionSchema>;
export const BrowserClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ack'), sequence: z.number().int().min(0) }).strict(),
  z.object({ type: z.literal('control'), owner: z.enum(['human', 'agent']) }).strict(),
  z.object({ type: z.literal('input'), action: BrowserActionSchema }).strict(),
]);
export type BrowserServerMessage =
  | { type: 'hello'; clientId: string; tab: BrowserTab }
  | { type: 'state'; tab: BrowserTab }
  | { type: 'frame'; sequence: number; width: number; height: number }
  | { type: 'error'; message: string };
/** Ephemeral capability supplied only to a provider process; never persisted or exposed in bootstrap. */
export interface BrowserMcpConnection { url: string; token: string }
