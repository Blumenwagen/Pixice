export const DEFAULT_VOICE_SETTINGS = Object.freeze({
  voice: null, microphoneDeviceId: "", muted: false, outputVolume: 1,
  outputDeviceId: "", captions: true,
});

export function voiceOptions(catalog, version = null) {
  if (!catalog) return [];
  // The runtime exposes v1 and v2 catalogs only. Keep v3 on its default voice.
  if (version === "v3") return [];
  return [...new Set(version ? catalog[version] ?? [] : [...catalog.v1, ...catalog.v2])];
}

export function normalizeVoiceSettings(input = {}, { catalog = null, version = null, volume = true, outputDevice = true } = {}) {
  const settings = { ...DEFAULT_VOICE_SETTINGS };
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(settings, key)) throw new TypeError(`Unsupported voice setting: ${key}`);
    if (["muted", "captions"].includes(key)) {
      if (typeof value !== "boolean") throw new TypeError(`${key} must be boolean`);
    } else if (key === "outputVolume") {
      if (!Number.isFinite(value) || value < 0 || value > 1) throw new TypeError("outputVolume must be between 0 and 1");
      if (!volume && value !== DEFAULT_VOICE_SETTINGS.outputVolume) throw new TypeError("Output volume is unsupported in this browser");
    } else if (key === "voice") {
      if (value !== null && (typeof value !== "string" || !value)) throw new TypeError("voice must be null or a voice identifier");
      if (value !== null && catalog && !voiceOptions(catalog, version).includes(value)) throw new TypeError("Voice is absent from the live catalog for this version");
    } else {
      if (typeof value !== "string") throw new TypeError(`${key} must be a device identifier`);
      if (key === "outputDeviceId" && value && !outputDevice) throw new TypeError("Output device selection is unsupported in this browser");
    }
    settings[key] = value;
  }
  return settings;
}

export function describeVoiceSettings({ catalog, version = null, volume = false, outputDevice = false, microphone = true } = {}) {
  return [
    { key: "voice", source: "native-start", supported: Boolean(catalog) && version !== "v3", choices: voiceOptions(catalog, version), requiresRestart: true },
    { key: "microphoneDeviceId", source: "browser", supported: microphone, requiresUserAction: true },
    { key: "muted", source: "browser-track", supported: microphone },
    { key: "outputVolume", source: "browser-media", supported: volume },
    { key: "outputDeviceId", source: "browser-media", supported: outputDevice },
    { key: "captions", source: "local-display", supported: true },
  ];
}
