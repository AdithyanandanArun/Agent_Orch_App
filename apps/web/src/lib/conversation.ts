import type { Message } from '@relay/contracts';

/** A stored message merged with any live streamed text, as the conversation renders it. */
export interface DisplayMessage { id: string; role: Message['role']; content: string; createdAt: string; kind?: string; runId?: string; live: boolean }
