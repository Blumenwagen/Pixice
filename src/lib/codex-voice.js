// Native Codex negotiates the call and delegates into the existing thread.
// The renderer owns media tracks; it never receives provider credentials.
export class CodexVoiceConnection {
  constructor({ api, context, deviceId, onState = () => {}, onTranscript = () => {}, onNotice = () => {}, onLevels = () => {}, peerFactory = () => new RTCPeerConnection(), capture = (options) => navigator.mediaDevices.getUserMedia(options), audioFactory = () => new Audio(), audioContextFactory = () => new AudioContext() }) {
    Object.assign(this, { api, context, deviceId, onState, onTranscript, onNotice, onLevels, peerFactory, capture, audioFactory, audioContextFactory });
    this.closed = false;
    this.session = null;
    this.remoteEvents = [];
    this.playbackBlocked = false;
    this.playbackAttempt = 0;
  }
  async open() {
    if (this.opened || this.closed) throw new Error('This Voice connection already started or ended.');
    this.opened = true;
    try {
      this.onState('connecting');
      const media = await this.capture({ audio: this.deviceId ? { deviceId: { exact: this.deviceId } } : true });
      this.media = media;
      if (this.closed) { media.getTracks().forEach((track) => track.stop()); return; }
      media.getAudioTracks?.().forEach((track) => { track.enabled = !this.muted; });
      this.beginAnalysis(media);
      this.peer = this.peerFactory();
      this.audio = this.audioFactory();
      this.audio.autoplay = true;
      this.peer.ontrack = ({ streams, track }) => {
        if (this.closed) return;
        this.audio.srcObject = streams[0] ?? new MediaStream([track]);
        this.analyseRemote(this.audio.srcObject);
        if (!this.playbackBlocked) void this.playAudio().catch(() => {});
      };
      this.peer.onconnectionstatechange = () => {
        if (this.closed) return;
        if (this.peer.connectionState === 'connected') { clearTimeout(this.negotiationTimer); this.onState(this.playbackBlocked ? 'playback-blocked' : 'connected'); }
        else if (['failed', 'disconnected', 'closed'].includes(this.peer.connectionState)) { this.onState('ended'); void this.close().catch(() => {}); }
      };
      media.getTracks().forEach((track) => this.peer.addTrack(track, media));
      this.channel = this.peer.createDataChannel('oai-events');
      this.unsubscribe = this.api.events.subscribe((event) => {
        const p = event.payload;
        if (event.type !== 'VoiceEvent' || p.projectId !== this.context.projectId || p.threadId !== this.context.threadId) return;
        if (!this.session) { this.remoteEvents.push(p); return; }
        if (p.id === this.session.id) this.handle(p);
      });
      const offer = await this.peer.createOffer();
      if (this.closed) return;
      await this.peer.setLocalDescription(offer);
      if (this.closed) return;
      await this.waitForIce();
      if (this.closed) return;
      this.startRequest = this.api.voice.start({ ...this.context, sdp: this.peer.localDescription.sdp });
      this.session = await this.startRequest;
      if (this.closed) { await this.close(); return; }
      this.negotiationTimer = setTimeout(() => { if (!this.closed && this.peer.connectionState !== 'connected') { this.onState('error', 'Voice negotiation timed out. Check your Codex account and try again.'); void this.close().catch(() => {}); } }, 25_000);
      for (const event of this.remoteEvents.splice(0)) if (event.id === this.session.id) this.handle(event);
    } catch (error) {
      if (!this.closed) this.onState('error', error.message);
      await this.close();
      throw error;
    }
  }
  beginAnalysis(media) {
    try {
      this.audioContext = this.audioContextFactory();
      void this.audioContext.resume().catch(() => {});
      this.localSource = this.audioContext.createMediaStreamSource(media);
      this.micAnalyser = this.audioContext.createAnalyser();
      this.micAnalyser.fftSize = 256;
      this.localSource.connect(this.micAnalyser);
      const read = (analyser) => {
        if (!analyser) return 0;
        const samples = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(samples);
        return Math.min(1, Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length) * 3);
      };
      this.levelTimer = setInterval(() => { if (!this.closed) this.onLevels({ micLevel: this.muted ? 0 : read(this.micAnalyser), speakerLevel: read(this.speakerAnalyser) }); }, 100);
    } catch { this.onLevels({ micLevel: 0, speakerLevel: 0 }); }
  }
  analyseRemote(media) {
    if (!this.audioContext) return;
    this.remoteSource?.disconnect();
    this.speakerAnalyser?.disconnect();
    this.remoteSource = this.audioContext.createMediaStreamSource(media);
    this.speakerAnalyser = this.audioContext.createAnalyser();
    this.speakerAnalyser.fftSize = 256;
    this.remoteSource.connect(this.speakerAnalyser);
  }
  waitForIce() {
    if (this.peer.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => { if (this.peer.iceGatheringState === 'complete') finish(); };
      const finish = (error) => { clearTimeout(timeout); this.peer.removeEventListener('icegatheringstatechange', done); this.cancelIce = null; error ? reject(error) : resolve(); };
      const timeout = setTimeout(() => finish(new Error('Microphone connection negotiation timed out.')), 8_000);
      this.cancelIce = () => finish(new Error('Voice was cancelled.'));
      this.peer.addEventListener('icegatheringstatechange', done);
    });
  }
  handle(event) {
    if (this.closed) return;
    if (event.method === 'thread/realtime/sdp') void this.peer.setRemoteDescription({ type: 'answer', sdp: event.sdp }).catch((error) => { this.onState('error', error.message); void this.close().catch(() => {}); });
    if (event.method === 'thread/realtime/transcript/done') this.onTranscript({ role: event.role, text: event.text });
    if (event.method === 'thread/realtime/notice') this.onNotice(event.message ?? 'Codex reported Voice ended. End this conversation if audio has stopped.');
    if (event.method === 'thread/realtime/closed' || event.method === 'thread/realtime/error') { this.onState(event.method.endsWith('/error') ? 'error' : 'ended', event.message); void this.close(false).catch(() => {}); }
  }
  mute(muted) { this.muted = muted; this.media?.getAudioTracks().forEach((track) => { track.enabled = !muted; }); }
  async playAudio(explicit = false) {
    if (this.closed || !this.audio) throw new Error('Voice playback has ended.');
    const attempt = ++this.playbackAttempt;
    try {
      await this.audio.play();
      if (this.closed || attempt !== this.playbackAttempt) return;
      if (explicit) {
        this.playbackBlocked = false;
        this.onState(this.peer.connectionState === 'connected' ? 'connected' : 'connecting');
      }
    } catch (error) {
      if (!this.closed && attempt === this.playbackAttempt) {
        this.playbackBlocked = true;
        this.onState('playback-blocked');
      }
      throw error;
    }
  }
  play() { void this.audioContext?.resume().catch(() => {}); return this.playAudio(true); }
  close(stopHost = true) {
    if (this.closing) return this.closing;
    this.closed = true;
    clearTimeout(this.negotiationTimer);
    clearInterval(this.levelTimer);
    this.localSource?.disconnect(); this.remoteSource?.disconnect(); this.micAnalyser?.disconnect(); this.speakerAnalyser?.disconnect();
    void this.audioContext?.close().catch(() => {});
    this.onLevels({ micLevel: 0, speakerLevel: 0 });
    this.cancelIce?.();
    this.unsubscribe?.();
    this.media?.getTracks().forEach((track) => track.stop());
    this.channel?.close();
    this.peer?.close();
    this.audio?.pause();
    if (this.audio) this.audio.srcObject = null;
    this.closing = (async () => {
      const session = this.session ?? await this.startRequest?.catch(() => null);
      if (stopHost && session) await this.api.voice.stop({ sessionId: session.id });
    })();
    return this.closing;
  }
}
