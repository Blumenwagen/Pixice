import { randomUUID } from 'node:crypto';
import { readServiceDescriptor, serviceCall } from '../backend/manager.mjs';
import { BrowserSessions } from './browser-sessions.mjs';
import { NATIVE_METHODS } from '../backend/native-bridge.mjs';
export class NativeHelperClient {
  constructor({ directory, browser, invokeDesktop, crypto, desktopAuthority, sessions = new BrowserSessions(directory) }) {
    Object.assign(this, { directory, browser, invokeDesktop, crypto, desktopAuthority, sessions }); this.clientId = randomUUID(); this.closed = false;
  }
  start() { void this.run(); }
  async voiceCall(operation, payload, onEvent) {
    if (!this.registration || this.closed) throw new Error('The authenticated native helper is unavailable');
    if (!this.voiceTask) {
      const registration = this.registration;
      const task = (async () => {
        const owner = await serviceCall(registration.descriptor, 'native.voiceAttach', { leaseId: registration.leaseId, desktopAuthority: registration.desktopAuthority });
        const voice = { ...registration, ...owner, onEvent };
        if (this.closed || this.registration !== registration || this.voiceTask !== task) {
          await serviceCall(registration.descriptor, 'native.voiceDisconnect', { leaseId: registration.leaseId, desktopAuthority: registration.desktopAuthority, ...owner }).catch(() => {});
          throw new Error('The local voice owner disconnected');
        }
        this.voice = voice;
        void this.pollVoice(voice);
        return voice;
      })();
      this.voiceTask = task;
      task.catch(() => { if (this.voiceTask === task) this.voiceTask = null; });
    }
    const voice = await this.voiceTask;
    if (voice !== this.voice || voice.leaseId !== this.registration?.leaseId) throw new Error('The local voice owner disconnected');
    return serviceCall(voice.descriptor, 'native.voiceCall', { leaseId: voice.leaseId, desktopAuthority: voice.desktopAuthority, ownerHandle: voice.ownerHandle, operation, payload }, { timeout: 60000 });
  }
  async pollVoice(voice) {
    try {
      while (!this.closed && this.voice === voice) {
        const { events } = await serviceCall(voice.descriptor, 'native.voicePoll', { leaseId: voice.leaseId, desktopAuthority: voice.desktopAuthority, ownerHandle: voice.ownerHandle }, { timeout: 25000 });
        if (this.closed || this.voice !== voice) return;
        for (const event of events) voice.onEvent(event);
      }
    } catch {
      if (this.voice === voice) {
        this.closeVoice();
      }
    }
  }
  closeVoice() {
    const voice = this.voice;
    this.voice = null; this.voiceTask = null;
    if (voice) { try { voice.onEvent({ type: 'owner_disconnected' }); } catch { /* Cleanup must survive a renderer subscriber failure. */ } }
    if (voice) void serviceCall(voice.descriptor, 'native.voiceDisconnect', { leaseId: voice.leaseId, desktopAuthority: voice.desktopAuthority, ownerHandle: voice.ownerHandle }).catch(() => {});
  }
  async run() {
    while (!this.closed) {
      try {
        const descriptor = await readServiceDescriptor(this.directory);
        const desktopAuthority = await this.desktopAuthority?.(descriptor);
        const proof = desktopAuthority ? { desktopAuthority } : {};
        const { leaseId } = await serviceCall(descriptor, 'native.register', { clientId: this.clientId, capabilities: [...NATIVE_METHODS], ...proof });
        this.registration = { descriptor, leaseId, ...proof };
        while (!this.closed) {
          const { commands } = await serviceCall(descriptor, 'native.poll', { leaseId, ...proof }, { timeout: 25_000 });
          for (const command of commands) void this.execute(command, this.registration);
        }
      } catch { this.closeVoice(); this.registration = null; if (!this.closed) await new Promise((resolve) => { this.wake = resolve; this.timer = setTimeout(resolve, 1000); }); }
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
    await serviceCall(registration.descriptor, 'native.respond', { leaseId: registration.leaseId, desktopAuthority: registration.desktopAuthority, id: command.id, ...(error ? { error } : { result }) }).catch(() => {});
    if (!error && ['desktop.shutdown', 'desktop.serviceStopped'].includes(command.method) && result?.exitHelper) await this.invokeDesktop('finishShutdown', []);
  }
  event(event) {
    if (event.type === 'BrowserState') this.sessions.update(event.payload, this.browser);
    const registration = this.registration;
    if (registration && !this.closed) void serviceCall(registration.descriptor, 'native.event', { leaseId: registration.leaseId, desktopAuthority: registration.desktopAuthority, event }).catch(() => {});
  }
  close() {
    this.closeVoice();
    this.sessions.flush();
    this.closed = true; clearTimeout(this.timer); this.wake?.();
    if (this.registration) void serviceCall(this.registration.descriptor, 'native.disconnect', { leaseId: this.registration.leaseId, desktopAuthority: this.registration.desktopAuthority }).catch(() => {});
  }
}
