import type { VoiceAvailability, VoiceSettings } from '../pixice-api';
type SettingsCapabilities = { catalog?: VoiceAvailability['catalog'] | null; version?: 'v1' | 'v2' | 'v3' | null; volume?: boolean; outputDevice?: boolean; microphone?: boolean };
export const DEFAULT_VOICE_SETTINGS: Readonly<VoiceSettings>;
export function voiceOptions(catalog: VoiceAvailability['catalog'] | null, version?: 'v1' | 'v2' | 'v3' | null): string[];
export function normalizeVoiceSettings(input?: Partial<VoiceSettings>, capabilities?: SettingsCapabilities): VoiceSettings;
export function describeVoiceSettings(capabilities?: SettingsCapabilities): Array<{ key: keyof VoiceSettings; source: string; supported: boolean; choices?: string[]; requiresRestart?: boolean; requiresUserAction?: boolean }>;
