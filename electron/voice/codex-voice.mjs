import { randomUUID } from 'node:crypto';

export class CodexVoice {
  constructor({ runtime, prepareThread, authSource = () => null, onEvent = () => {} }) {
    this.runtime = runtime;
    this.prepareThread = prepareThread;
    this.authSource = authSource;
    this.onEvent = onEvent;
    this.session = null;
    this.generation = 0;
  }
  async state() {
    if (this.authSource()) return { available: false, reason: 'Conversational Voice needs the existing Codex account. ChatGPT app sign-in grants Responses inference only.', session: this.publicSession() };
    if (!this.runtime.connected) return { available: false, reason: 'Connect Codex in Providers to use conversational Voice.', session: this.publicSession() };
    try {
      const { voices } = await this.runtime.request('thread/realtime/listVoices', {});
      return { available: true, experimental: true, voices, session: this.publicSession() };
    } catch { return { available: false, reason: 'This Codex CLI does not expose native conversational Voice. Update Codex in Providers.', session: this.publicSession() }; }
  }
  publicSession() {
    if (!this.session) return null;
    const { id, projectId, threadId, phase } = this.session;
    return { id, projectId, threadId, phase };
  }
  async start(value) {
    if (this.session) throw new Error('End the current Voice conversation first.');
    if (this.authSource()) throw new Error('Switch to the existing Codex account for conversational Voice.');
    const session = { id: randomUUID(), generation: this.generation, projectId: value.projectId, threadId: value.threadId, phase: 'connecting', starting: null };
    this.session = session;
    session.starting = (async () => {
      await this.prepareThread(value);
      if (this.session !== session || session.phase === 'stopping') throw new Error('Voice was cancelled.');
      await this.runtime.request('thread/realtime/start', {
        threadId: value.threadId, realtimeSessionId: session.id, version: 'v3', outputModality: 'audio', transport: { type: 'webrtc', sdp: value.sdp },
        clientManagedHandoffs: false, includeStartupContext: true,
        realtimeStartInstructions: 'The user is speaking through Pixice Voice. Continue this existing thread and its project directions. Follow its tools, permission settings, and approval boundaries. Spoken discussion is not approval for a pending action. Request explicit approval in Pixice when required.',
        ...(value.voice ? { voice: value.voice } : {})
      });
    })();
    try {
      await session.starting;
      if (this.session !== session || session.phase === 'stopping') throw new Error('Voice ended before connecting.');
      return this.publicSession();
    }
    catch (error) {
      if (this.session === session) await this.stop({ sessionId: session.id }).catch(() => {});
      throw new Error(`Voice could not start: ${error.message}`);
    }
  }
  handle(payload) {
    const session = this.session;
    if (!session || payload.threadId !== session.threadId || !payload.method?.startsWith('thread/realtime/')) return;
    if (payload.realtimeSessionId && payload.realtimeSessionId !== session.id) return;
    let method = payload.method;
    let data = {};
    if (method === 'thread/realtime/sdp') data = { sdp: payload.sdp };
    else if (method === 'thread/realtime/transcript/done') data = { role: payload.role, text: payload.text };
    else if (method === 'thread/realtime/transcript/delta') data = { role: payload.role, delta: payload.delta };
    else if (method === 'thread/realtime/started') { if (session.phase !== 'stopping') session.phase = 'connected'; }
    else if (method === 'thread/realtime/closed' || method === 'thread/realtime/error') {
      data = { message: payload.message ?? payload.reason ?? null };
      // This CLI's terminal notifications contain only a thread ID. They cannot
      // identify a replacement session, so they are advisory. The owned WebRTC
      // connection, explicit Stop, failed Start RPC, or runtime reset ends it.
      if (!payload.realtimeSessionId) method = 'thread/realtime/notice';
      else void this.stop({ sessionId: session.id }).catch(() => {});
    } else return;
    this.onEvent({ ...this.publicSession(), id: session.id, projectId: session.projectId, threadId: session.threadId, method, ...data });
  }
  async stop({ sessionId }) {
    const session = this.session;
    if (!session) return { stopped: true };
    if (session.id !== sessionId) throw new Error('Voice session changed.');
    if (session.stopping) return session.stopping;
    session.phase = 'stopping';
    session.stopping = (async () => {
      await session.starting?.catch(() => {});
      try {
        if (this.session === session && session.generation === this.generation) await this.runtime.request('thread/realtime/stop', { threadId: session.threadId });
        if (this.session === session) this.session = null;
        this.onEvent({ id: session.id, projectId: session.projectId, threadId: session.threadId, method: 'thread/realtime/closed', message: null });
      } catch (error) {
        if (this.session === session) { session.phase = 'cleanup-failed'; session.stopping = null; }
        throw error;
      }
      return { stopped: true };
    })();
    return session.stopping;
  }
  reset(message = 'Codex disconnected. Voice has ended.') {
    this.generation++;
    const session = this.session;
    this.session = null;
    if (session) this.onEvent({ id: session.id, projectId: session.projectId, threadId: session.threadId, method: 'thread/realtime/closed', message });
  }
}
