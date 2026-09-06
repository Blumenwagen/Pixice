import { randomUUID } from 'node:crypto';
import { readServiceDescriptor, serviceCall } from '../backend/manager.mjs';
import { BrowserSessions } from './browser-sessions.mjs';
import { NATIVE_METHODS } from '../backend/native-bridge.mjs';
export class NativeHelperClient {
  constructor({ directory, browser, invokeDesktop, crypto, sessions = new BrowserSessions(directory) }) {
    Object.assign(this, { directory, browser, invokeDesktop, crypto, sessions }); this.clientId = randomUUID(); this.closed = false;
  }
  start() { void this.run(); }
  async run() {
    while (!this.closed) {
      try {
        const descriptor = await readServiceDescriptor(this.directory);
        const { leaseId } = await serviceCall(descriptor, 'native.register', { clientId: this.clientId, capabilities: [...NATIVE_METHODS] });
        this.registration = { descriptor, leaseId };
        while (!this.closed) {
          const { commands } = await serviceCall(descriptor, 'native.poll', { leaseId }, { timeout: 25_000 });
          for (const command of commands) void this.execute(command, { descriptor, leaseId });
        }
      } catch { this.registration = null; if (!this.closed) await new Promise((resolve) => { this.wake = resolve; this.timer = setTimeout(resolve, 1000); }); }
    }
  }
  async execute(command, registration) {
    if (this.closed) return;
    let result, error;
    try {
      if (!NATIVE_METHODS.has(command.method) || !Array.isArray(command.arguments)) throw new Error('Unsupported native command');
      const [group, method] = command.method.split('.');
      if (group === 'browser') {
        const first = command.arguments[0];
        this.sessions.restore(this.browser, typeof first === 'string' ? first : first?.workspaceId || first?.threadId);
        result = await this.browser[method](...command.arguments);
        if (method === 'destroyWorkspace' || method === 'adoptWorkspace') this.sessions.update({ workspaceId: first, tabs: [] }, this.browser);
      }
      else if (group === 'desktop') result = await this.invokeDesktop(method, command.arguments);
      else {
        if (!this.crypto.isEncryptionAvailable() || this.crypto.getSelectedStorageBackend?.() === 'basic_text') throw new Error('Secure OS credential storage is unavailable');
        result = method === 'encrypt' ? this.crypto.encryptString(command.arguments[0]).toString('base64') : this.crypto.decryptString(Buffer.from(command.arguments[0], 'base64'));
      }
    } catch (cause) { error = String(cause.message).slice(0, 2000); }
    await serviceCall(registration.descriptor, 'native.respond', { leaseId: registration.leaseId, id: command.id, ...(error ? { error } : { result }) }).catch(() => {});
    if (!error && ['desktop.shutdown', 'desktop.serviceStopped'].includes(command.method) && result?.exitHelper) await this.invokeDesktop('finishShutdown', []);
  }
  event(event) {
    if (event.type === 'BrowserState') this.sessions.update(event.payload, this.browser);
    const registration = this.registration;
    if (registration && !this.closed) void serviceCall(registration.descriptor, 'native.event', { leaseId: registration.leaseId, event }).catch(() => {});
  }
  close() {
    this.sessions.flush();
    this.closed = true; clearTimeout(this.timer); this.wake?.();
    if (this.registration) void serviceCall(this.registration.descriptor, 'native.disconnect', { leaseId: this.registration.leaseId }).catch(() => {});
  }
}
