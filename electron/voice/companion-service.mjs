import { z } from 'zod';

const contextSchema = z.object({ projectId: z.string().uuid(), threadId: z.string().min(1).max(128),
  model: z.string().max(128).optional(), effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional(),
  permissionMode: z.enum(['read-only', 'workspace-write', 'auto-approve', 'full-access']).optional(),
  deviceId: z.string().max(512).optional(), accent: z.string().max(64).optional() }).strict();
const reportSchema = z.object({ phase: z.enum(['connecting', 'connected', 'playback-blocked', 'ended', 'error']).optional(),
  micLevel: z.number().finite().min(0).max(1).optional(), speakerLevel: z.number().finite().min(0).max(1).optional(), error: z.string().max(2000).optional() }).strict();
const idle = () => ({ phase: 'idle', projectId: null, threadId: null, muted: false, detached: false, micLevel: 0, speakerLevel: 0, needsApproval: false });

export class VoiceCompanionService {
  constructor({ presentation, call, publish = () => {}, returnToMain, notifyApproval = () => {}, describeContext = async () => ({}) }) {
    Object.assign(this, { presentation, call, publish, returnToMain, notifyApproval, describeContext });
    this.public = idle(); this.generation = 0; this.approvals = new Set();
    presentation.onClose = () => { void this.end().catch(() => {}); };
    presentation.onFailure = (error) => { void this.end(error).catch(() => {}); };
    presentation.onDetach = () => this.update({ detached: true });
  }
  state() { return { ...this.public }; }
  update(patch) { this.public = { ...this.public, ...patch }; const state = this.state(); this.publish('VoiceCompanionState', state); this.presentation.send('VoiceCompanionState', state); return state; }
  ownsMedia() { return Boolean(this.context || this.ending || this.session || this.starting); }
  async open(payload) {
    const context = contextSchema.parse(payload);
    if (this.ending) throw new Error('Voice is still ending. Retry End before starting another conversation.');
    if (this.public.phase === 'cleanup-failed') {
      if (context.projectId !== this.context?.projectId || context.threadId !== this.context?.threadId) throw new Error('Retry End on the pinned Voice conversation before opening another thread.');
      // Reopen controls only. Configuration's phase prevents capture or a new Start.
      await this.presentation.open();
      return this.update({ detached: false });
    }
    if (this.context) {
      if (context.projectId !== this.context.projectId || context.threadId !== this.context.threadId) throw new Error('End the pinned Voice conversation before speaking in another thread.');
      this.presentation.window?.show(); return this.state();
    }
    // Reserve synchronously before either support discovery or window loading.
    this.context = context; this.generation++;
    this.approvals.clear();
    const generation = this.generation;
    this.update({ ...idle(), phase: 'connecting', projectId: context.projectId, threadId: context.threadId });
    try {
      if (!this.presentation.supported) throw new Error('Floating Voice is unavailable on this desktop. Use composer dictation, or an X11 desktop on Linux.');
      const support = await this.call('voice.state');
      if (generation !== this.generation) return this.state();
      if (support.session) throw new Error('End the existing Voice session before starting the companion.');
      if (!support.available) throw new Error(support.reason || 'Codex Voice is unavailable.');
      this.labels = await this.describeContext({ projectId: context.projectId, threadId: context.threadId }).catch(() => ({}));
      if (generation !== this.generation) return this.state();
      await this.presentation.open();
      return this.state();
    } catch (error) {
      if (generation === this.generation) { this.presentation.destroy(); this.context = null; this.update({ phase: 'error', error: error.message, micLevel: 0, speakerLevel: 0 }); }
      throw error;
    }
  }
  configuration() { if (!this.context) throw new Error('Voice has ended.'); return { context: this.context, state: this.state(), labels: this.labels }; }
  async start(payload) {
    const { sdp } = z.object({ sdp: z.string().min(1).max(128_000) }).strict().parse(payload);
    if (!this.context || this.starting || this.session || this.ending) throw new Error('Voice already started or ended.');
    const { deviceId: _device, accent: _accent, ...context } = this.context;
    this.starting = this.call('voice.start', { ...context, sdp }).then((session) => { this.session = session; return session; });
    try { return await this.starting; }
    catch (error) { this.startUncertain = true; throw error; }
  }
  // Renderer Stop never accepts a caller-selected session or thread.
  stop() { return this.end(); }
  report(payload) {
    const value = reportSchema.parse(payload);
    if (!this.context || this.ending) return this.state();
    if (value.phase === 'ended' || value.phase === 'error') { void this.end(value.error).catch(() => {}); return this.state(); }
    return this.update(value);
  }
  mute(payload) {
    const { muted } = z.object({ muted: z.boolean() }).strict().parse(payload);
    if (!this.context || this.ending) return this.state();
    this.presentation.send('Mute', { muted });
    return this.update({ muted, ...(muted ? { micLevel: 0 } : {}) });
  }
  detach() { if (this.context) { this.presentation.detach(); this.update({ detached: true }); } return this.state(); }
  async attach() { if (this.context) { await this.returnToPixice(); this.presentation.attach(); this.update({ detached: false }); } return this.state(); }
  async returnToPixice() { if (this.public.projectId) await this.returnToMain({ projectId: this.public.projectId, threadId: this.public.threadId, needsApproval: this.public.needsApproval }); return this.state(); }
  handle(event) {
    if (!this.context) return;
    const p = event.payload ?? {};
    if (event.type === 'VoiceEvent' && p.projectId === this.context.projectId && p.threadId === this.context.threadId) this.presentation.send('VoiceEvent', p);
    if (event.type === 'AttentionRequired' && p.params?.threadId === this.context.threadId && p.method?.toLowerCase().includes('approval')) {
      const wasPending = this.approvals.size > 0;
      this.approvals.add(p.id); this.update({ needsApproval: true });
      if (!wasPending) this.notifyApproval(() => { void this.returnToPixice(); });
    }
    if (event.type === 'AttentionResolved' || event.type === 'ServerRequestResolved') {
      this.approvals.delete(p.requestId ?? p.id); this.update({ needsApproval: this.approvals.size > 0 });
    }
    if (event.type === 'AttentionReset') {
      this.approvals.clear();
      for (const request of p.requests ?? []) if (request.params?.threadId === this.context.threadId && request.method?.toLowerCase().includes('approval')) this.approvals.add(request.id);
      this.update({ needsApproval: this.approvals.size > 0 });
    }
    if (event.type === 'ApplicationResync') { void this.end('The backend connection changed. Start Voice again after it reconnects.').catch(() => {}); }
  }
  end(message) {
    if (this.ending) return this.ending;
    if (!this.ownsMedia()) return Promise.resolve(this.state());
    this.generation++;
    this.update({ phase: 'stopping', detached: false, micLevel: 0, speakerLevel: 0 });
    // Destroy synchronously: even hung backend cleanup cannot retain capture/playback.
    this.presentation.destroy();
    this.ending = (async () => {
      await this.starting?.catch(() => {});
      if (!this.session && this.startUncertain) {
        const status = await this.call('voice.state');
        if (status.session?.threadId === this.context?.threadId && status.session?.projectId === this.context?.projectId) this.session = status.session;
      }
      if (this.session) await this.call('voice.stop', { sessionId: this.session.id });
      this.context = null; this.session = null; this.starting = null; this.startUncertain = false; this.approvals.clear();
      return this.update({ phase: message ? 'error' : 'ended', ...(message ? { error: message } : { error: undefined }), muted: false, needsApproval: false });
    })().catch((error) => { this.update({ phase: 'cleanup-failed', error: `Microphone stopped. Codex cleanup needs retry: ${error.message}` }); throw error; }).finally(() => { this.ending = null; });
    return this.ending;
  }
}

export function registerVoiceCompanionIpc({ ipcMain, service, mainWindow }) {
  for (const [action, method] of Object.entries({ open: 'open', state: 'state', mute: 'mute', end: 'end', detach: 'detach', attach: 'attach', return: 'returnToPixice' })) {
    ipcMain.handle(`voice:companion:${action}`, (event, payload) => {
      if (event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('Untrusted Voice controller');
      return service[method](payload);
    });
  }
  for (const [action, method] of Object.entries({ configuration: 'configuration', state: 'state', report: 'report', start: 'start', stop: 'stop', mute: 'mute', end: 'end', detach: 'detach', attach: 'attach', return: 'returnToPixice' })) {
    ipcMain.handle(`voice-companion:${action}`, (event, payload) => {
      if (!service.presentation.trusted(event)) throw new Error('Untrusted Voice companion');
      return service[method](payload);
    });
  }
}
