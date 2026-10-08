// Adapter for an injected preload/Connect invoker and the existing Pixice event bus.
// This file registers nothing and never gains access to credentials or the mic.
export function createVoiceClient({ invoke, subscribe }) {
  if (typeof invoke !== "function" || typeof subscribe !== "function") throw new TypeError("invoke and subscribe are required");
  const client = {};
  for (const name of ["availability", "prepare", "start", "stop", "appendText", "appendSpeech", "appendAudio", "snapshot"]) {
    client[name] = (payload, reason) => invoke(`voice:${name}`, { ...payload, ...(reason ? { reason } : {}) });
  }
  client.subscribe = (listener) => subscribe((event) => {
    if (event?.type === "VoiceSessionEvent" && event.payload) listener(event.payload);
  });
  return Object.freeze(client);
}
