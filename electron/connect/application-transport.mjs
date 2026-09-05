import { EventEmitter } from 'node:events';
// Shared registration, not IPC forwarding. Only named capabilities can call these handlers remotely.
export const applicationHandlers = new Map();
export const applicationEvents = new EventEmitter();
export function applicationIpc(nativeIpc) {
  return {
    handle(channel, handler) {
      nativeIpc.handle(channel, handler);
      applicationHandlers.set(channel, handler);
    },
    removeHandler(channel) {
      applicationHandlers.delete(channel);
      nativeIpc.removeHandler(channel);
    }
  };
}
