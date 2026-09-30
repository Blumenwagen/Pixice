import React from 'react';
import { createRoot } from 'react-dom/client';
import { CompanionApp } from '../../src/voice/CompanionApp.jsx';
// Chromium uses its synthetic microphone device. No account or physical mic.
window.__voiceHarness = { captures: 0, peers: 0, stops: 0, playback: 0, analysisContexts: 0 };
const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
navigator.mediaDevices.getUserMedia = async (options) => {
  window.__voiceHarness.captures++;
  const stream = await capture(options);
  for (const track of stream.getTracks()) { const stop = track.stop.bind(track); track.stop = () => { window.__voiceHarness.stops++; stop(); }; }
  window.__voiceHarness.media = stream;
  return stream;
};
const RealAudioContext = window.AudioContext;
window.AudioContext = class extends RealAudioContext { constructor(...args) { super(...args); window.__voiceHarness.analysisContexts++; } };
window.Audio = class {
  play() { window.__voiceHarness.playback++; return Promise.resolve(); }
  pause() {}
};
// Fake signalling with genuine local/remote MediaStreams and WebAudio analysis.
window.RTCPeerConnection = class {
  constructor() { window.__voiceHarness.peers++; this.iceGatheringState = 'complete'; this.connectionState = 'new'; }
  addTrack() {}
  createDataChannel() { return { close() {} }; }
  async createOffer() { return { type: 'offer', sdp: 'fake-harness-offer' }; }
  async setLocalDescription(value) { this.localDescription = value; }
  async setRemoteDescription() {
    this.remoteAudio = new RealAudioContext();
    this.oscillator = this.remoteAudio.createOscillator(); this.oscillator.frequency.value = 440;
    const gain = this.remoteAudio.createGain(); gain.gain.value = 0.12;
    const destination = this.remoteAudio.createMediaStreamDestination();
    this.oscillator.connect(gain); gain.connect(destination); this.oscillator.start(); await this.remoteAudio.resume();
    this.ontrack?.({ streams: [destination.stream], track: destination.stream.getAudioTracks()[0] });
    this.connectionState = 'connected'; this.onconnectionstatechange?.();
  }
  close() { this.oscillator?.stop(); void this.remoteAudio?.close(); this.connectionState = 'closed'; }
};
createRoot(document.getElementById('root')).render(<CompanionApp />);
