// Development-only UI fixture. It cannot create vendor sessions or cloud jobs.
export function withDevDayPreview(api) {
  const blocked = async () => { throw new Error('Preview fixture only. Open the host desktop to use this action.'); };
  api.chatgpt = {
    state: async () => ({ profiles: [{ id: 'preview-profile', email: 'preview@example.test', name: 'Preview account', subject: 'preview', clientId: 'oaiapp_preview_workspace', signedIn: true, planEnabled: true, scopes: ['chatgpt.tokens.use.direct'], expiresAt: null }], selectedProfileId: null, pending: false, error: null, signOutResult: new URLSearchParams(window.location.search).has('revocation-warning-preview') ? { profileId: 'previous-preview-profile', status: 'unconfirmed', message: 'Signed out on this device. Remote session revocation was not confirmed. Disconnect Pixice in ChatGPT Settings to end its remote access.' } : null }),
    signIn: blocked, cancel: blocked, select: blocked, signOut: blocked, manage: blocked
  };
  const parameters = new URLSearchParams(window.location.search);
  if (parameters.has('dictation-ready-preview')) {
    api.transcription = { state: async () => ({ ready: true, selectedModelId: 'preview-model', models: [] }), transcribe: blocked };
  }
  if (parameters.has('composer-idle-preview')) {
    const read = api.threads.read;
    api.threads.read = async (payload) => {
      const value = await read(payload);
      return { ...value, thread: { ...value.thread, status: { type: 'idle' }, turns: (value.thread.turns ?? []).map((turn) => ({ ...turn, status: 'completed' })) } };
    };
  }
  let companion = { phase: 'idle', projectId: null, threadId: null, muted: false, detached: false, micLevel: 0, speakerLevel: 0 };
  api.voice = { state: async () => ({ available: true, experimental: true, session: null }), start: blocked, stop: blocked,
    companion: {
      state: async () => companion,
      open: async (context) => { companion = { ...companion, ...context, phase: 'idle', error: 'Browser fixture only. Native companion window and microphone were not started.' }; return companion; },
      mute: blocked, end: blocked, detach: blocked, attach: blocked, returnToPixice: blocked
    }
  };
  api.cloud = {
    state: async () => ({ available: true, experimental: true, environments: parameters.has('cloud-empty-preview') ? [] : [{ id: 'env_preview', name: 'Project environment' }, { id: 'env_release_preview', name: 'Release environment' }], environmentDiscovery: 'manual', reason: 'The CLI supports Cloud tasks. Save an exact environment ID for this project.', authentication: 'Uses the existing Codex CLI account, separately from ChatGPT app sign-in.' }),
    list: async () => ({ data: { tasks: [{ id: 'task_preview', title: 'Example completed Cloud task', status: 'ready', environment_label: 'Project environment', summary: { files_changed: 2 }, updated_at: '2026-09-30T08:00:00Z' }], cursor: null }, warnings: '' }),
    status: async () => ({ output: 'Example task completed. Two files changed.', warnings: '' }),
    diff: async () => ({ output: 'diff --git a/src/example.js b/src/example.js\n--- a/src/example.js\n+++ b/src/example.js\n@@ -1 +1 @@\n-export const ready = false;\n+export const ready = true;\n', warnings: '', diffHash: 'a'.repeat(64), reviewId: '11111111-1111-4111-8111-111111111111', attempt: 1 }),
    saveEnvironment: blocked, removeEnvironment: blocked, submit: blocked, apply: blocked, open: blocked
  };
  return api;
}
