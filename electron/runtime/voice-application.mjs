import { createVoiceSessionBridge, VoiceSessionError } from './voice-session.mjs';

const operations = ['availability', 'prepare', 'start', 'stop', 'appendText', 'appendSpeech', 'appendAudio', 'snapshot'];
const key = (scope) => JSON.stringify([scope.projectId, scope.threadId]);
const reject = (code, message) => { throw new VoiceSessionError(code, message); };

export function installVoiceApplication({ application, runtime, handlers, resolveScope, authorizeOwner, deliverEvent, prepareTimeoutMs }) {
  const owners = new Map();
  let accepting = true;
  const admitInput = () => { if (application.isFrozen?.()) reject('voice_host_frozen', 'The host is frozen. Voice starts and input are unavailable until admission reopens.'); };
  const bridge = createVoiceSessionBridge({ runtime, resolveScope, capabilities: () => runtime.voiceCapabilities, admitInput, prepareTimeoutMs });
  // Must precede handler publication. Scope reads never acquire this lock.
  application.setFocusVoiceGuard((projectId, threadId) => bridge.blocksRollover({ projectId, threadId }));
  function authority(scope) {
    const current = resolveScope(scope);
    if (!current || current.projectId !== scope.projectId || current.threadId !== scope.threadId || !Number.isInteger(current.generation)) {
      reject('voice_thread_changed', 'The authoritative Focus session changed. Start voice on the current session.');
    }
    if (current.provider !== 'codex') reject('voice_provider_unsupported', 'Native voice requires a Codex Focus session.');
    if (scope.generation != null && current.generation !== scope.generation) reject('voice_thread_changed', 'The Focus generation changed.');
    return current;
  }
  bridge.subscribe((event) => {
    const binding = owners.get(key(event));
    if (!binding) return;
    try {
      const current = authority(event);
      if (current.generation === binding.generation && authorizeOwner(binding.context) === binding.owner) deliverEvent(binding.owner, event);
    } catch { /* Owner or authority is gone. Teardown retains uncertain stops. */ }
    if (event.type === 'closed') owners.delete(key(event));
  });
  for (const operation of operations) handlers.handle(`voice:${operation}`, async (context, input) => {
    if (!input || ![input.projectId, input.threadId].every((v) => typeof v === 'string' && v.trim())) reject('voice_invalid_request', 'A project and current Focus thread are required.');
    const owner = authorizeOwner(context);
    const current = authority(input);
    const binding = owners.get(key(input));
    if (binding && (binding.owner !== owner || binding.generation !== current.generation)) reject('voice_owner_mismatch', 'This voice session belongs to another local renderer.');
    if (!['availability', 'prepare'].includes(operation)) {
      const session = bridge.snapshot(input);
      if (!binding || !session || typeof input.sessionHandle !== 'string' || session.sessionHandle !== input.sessionHandle) reject('voice_session_stale', 'This voice handle is no longer current.');
    }
    if (!accepting && operation !== 'stop' && operation !== 'snapshot') reject('voice_stopping', 'Voice is stopping. Start again explicitly after cleanup.');
    const run = async () => {
      const admitsWork = () => {
        if (!['stop', 'snapshot', 'availability'].includes(operation)) admitInput();
      };
      admitsWork();
      if (['availability', 'prepare'].includes(operation)) await runtime.verifyVoiceSupport();
      admitsWork();
      if (!accepting && operation !== 'stop' && operation !== 'snapshot') reject('voice_stopping', 'Voice is stopping.');
      const latest = authority(input);
      if (authorizeOwner(context) !== owner) reject('voice_owner_mismatch', 'The local renderer disconnected.');
      if (operation === 'prepare') {
        if (owners.has(key(input))) reject('voice_session_busy', 'Voice is already reserved on this Focus session.');
        owners.set(key(input), { owner, context, generation: latest.generation });
        try {
          const prepared = await bridge.prepare(input);
          await bridge.availability(input);
          if (authorizeOwner(context) !== owner || bridge.snapshot(input)?.sessionHandle !== prepared.sessionHandle) reject('voice_session_stale', 'Voice preparation expired or the renderer disconnected.');
          return prepared;
        }
        catch (error) {
          await bridge.stopProject(input.projectId, 'preparation_failed');
          if (!bridge.blocksRollover(input)) owners.delete(key(input));
          throw error;
        }
      }
      if (operation === 'snapshot') return bridge.snapshot(input);
      return bridge[operation](input, input.reason);
    };
    try { return operation === 'prepare' ? await application.withFocusSessionAdmission(input, run) : await run(); }
    catch (error) {
      if (typeof error.code === 'string' && /^(voice_|focus_)/.test(error.code)) throw error;
      throw new VoiceSessionError('voice_operation_failed', `Voice ${operation} failed. Check the native runtime and explicitly retry cleanup if needed.`);
    }
  });
  return {
    bridge,
    async ownerDisconnected(owner) {
      const ids = [...owners.entries()].filter(([, entry]) => entry.owner === owner).map(([scope]) => JSON.parse(scope)[0]);
      const results = await Promise.allSettled([...new Set(ids)].map((id) => bridge.stopProject(id, 'owner_disconnected')));
      if (results.some((r) => r.status === 'rejected')) reject('voice_stop_failed', 'Native voice stop failed after the renderer disconnected. Focus renewal remains blocked.');
    },
    async stopProject(projectId, reason) {
      try { await bridge.stopProject(projectId, reason); }
      catch { reject('voice_stop_failed', 'Native voice could not stop for this project. Focus renewal remains blocked. Retry cleanup explicitly.'); }
    },
    async stopAll(reason) {
      accepting = false;
      const results = await Promise.allSettled([...new Set([...owners.keys()].map((scope) => JSON.parse(scope)[0]))].map((id) => bridge.stopProject(id, reason)));
      if (results.some((r) => r.status === 'rejected')) reject('voice_stop_failed', 'Native voice could not stop. Focus renewal remains blocked.');
    },
    allowStarts() { accepting = true; },
    async dispose() { accepting = false; await bridge.dispose(); },
  };
}
