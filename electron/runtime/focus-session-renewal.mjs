// Context pressure uses the provider's last-turn input, never cumulative billing.
export function renewalEvidence({ usage, transcript, session }) {
  const tokens = Number(usage?.last?.inputTokens);
  const window = Number(usage?.modelContextWindow);
  if (tokens > 0 && window > 0) return tokens / window >= 0.75 ? { reason: "context-pressure", inputTokens: tokens, contextWindow: window } : null;
  const chars = JSON.stringify(transcript?.turns ?? []).length;
  // Conservative fallback for providers without a context-window notification.
  if (session.sessionTurnCount >= 24 && chars >= 160_000) return { reason: "bounded-history", turns: session.sessionTurnCount, transcriptChars: chars };
  return null;
}

export class FocusSessionRenewal {
  constructor({ database, createSession, safeBoundary, handoff, onChange = () => {} }) {
    Object.assign(this, { database, createSession, safeBoundary, handoff, onChange });
    this.operations = new Map();
    this.voiceGuard = () => false;
  }

  // Voice integration installs a synchronous host-authoritative guard. Unknown
  // or throwing voice state fails closed. It is checked before and after create.
  setVoiceGuard(guard) { this.voiceGuard = guard; }

  withProject(projectId, run) {
    const previous = this.operations.get(projectId) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(run);
    this.operations.set(projectId, operation);
    return operation.finally(() => { if (this.operations.get(projectId) === operation) this.operations.delete(projectId); });
  }

  assertSafe(session) {
    const defer = (message) => { const error = new Error(message); error.code = "focus_renewal_deferred"; throw error; };
    let voice;
    try { voice = this.voiceGuard(session.projectId, session.threadId); }
    catch { defer("Focus renewal is deferred because voice state is unavailable."); }
    if (voice !== false) defer("Focus renewal is deferred while voice is active or its state is unknown.");
    if (!this.safeBoundary(session)) defer("Focus renewal requires an idle boundary; retry after the active turn or request finishes.");
  }

  refresh(projectId, { expectedGeneration, evidence = { reason: "manual" } }) {
    return this.withProject(projectId, () => this.rotate(projectId, { expectedGeneration, evidence }));
  }

  // Caller must hold withProject through turn admission as well as rotation.
  async rotate(projectId, { expectedGeneration, evidence }) {
    const before = this.database.getProjectFocusSession(projectId);
    if (!before || before.generation !== expectedGeneration) throw new Error("Focus session changed. Reload the authoritative coordinator before refreshing.");
    this.assertSafe(before);
    const handoff = this.handoff(before);
    const candidate = await this.createSession(projectId, before, evidence);
    if (!candidate?.thread?.id || candidate.thread.id === before.threadId) throw new Error("Provider did not create a fresh Focus session.");
    this.assertSafe(before);
    const session = this.database.replaceProjectFocusSession({ projectId, threadId: candidate.thread.id,
      expectedGeneration, expectedRevision: before.revision, handoff, evidence });
    // Failure before CAS leaves the old session authoritative. The orphan
    // candidate is retained for diagnosis, never started or deleted.
    let notificationError;
    try { this.onChange({ projectId, session, previousThreadId: before.threadId, evidence }); }
    catch (error) { notificationError = String(error.message); }
    return { ...candidate, ...(candidate.memory ? { memory: { ...candidate.memory, session } } : {}), session, replacedThreadId: before.threadId, renewed: true, ...(notificationError ? { notificationError } : {}) };
  }
}
