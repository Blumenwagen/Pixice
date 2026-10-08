import type { VoiceApi, VoiceHandle, VoiceSessionEvent } from '../pixice-api';

type OwnerDisconnected = { type: 'owner_disconnected' };
export type VoiceClient = Omit<VoiceApi, 'stop'> & {
  stop(scope: VoiceHandle & { reason?: string }, reason?: string): Promise<{ stopped: true }>;
  subscribe(listener: (event: VoiceSessionEvent | OwnerDisconnected) => void): () => void;
};
export function createVoiceClient(options: {
  invoke: (channel: string, payload: unknown) => Promise<unknown>;
  subscribe: (listener: (event: { type: string; payload?: unknown }) => void) => () => void;
}): VoiceClient;
