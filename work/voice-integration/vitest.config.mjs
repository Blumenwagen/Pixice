import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', setupFiles: [], include: ['tests/voice-application.test.js', 'tests/voice-native-security.test.js', 'tests/focus-session-renewal.test.js', 'tests/focus-coordinator-context.test.js'] } });
