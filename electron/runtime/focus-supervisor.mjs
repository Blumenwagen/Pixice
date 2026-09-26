import { FOCUS_WORKER_PERMISSION_MODE } from "./focus-permissions.mjs";

const ACTIVE_STATUSES = new Set(["starting", "running", "cancelling"]);
const TERMINAL_STATUSES = new Set(["done", "completed", "failed", "cancelled"]);
const RECOVERABLE_STATUSES = new Set(["starting", "running", "cancelling"]);
const DEFERRED_RECOVERY_PREFIX = "Worker recovery deferred until provider is ready:";

const bounded = (value, limit = 24_000) => String(value ?? "").slice(0, limit);
const asArray = (value) => Array.isArray(value) ? value : [];
const errorMessage = (error) => bounded(error?.message ?? error ?? "Unknown error", 4_000);
const recoverableProviderError = (error) => {
  const code = String(error?.code ?? "").toLowerCase();
  const message = errorMessage(error).toLowerCase();
  return ["runtime_missing", "provider_unavailable", "not_connected", "runtime_unavailable"].includes(code)
    || /(?:provider|runtime|codex|claude).*(?:unavailable|not connected|not ready|offline)/.test(message)
    || /(?:unavailable|not connected|not ready|offline).*(?:provider|runtime|codex|claude)/.test(message);
};
const shouldRecover = (work) => RECOVERABLE_STATUSES.has(work?.status)
  || (work?.status === "needs-attention" && String(work.error ?? "").startsWith(DEFERRED_RECOVERY_PREFIX));

function payloadOf(event) {
  if (!event || typeof event !== "object") return null;
  return event.payload && typeof event.payload === "object" ? event.payload : event;
}

function completedAnswer(payload) {
  const turn = payload?.turn ?? payload;
  return bounded(asArray(turn?.items)
    .filter((item) => item?.type === "agentMessage")
    .map((item) => item.text ?? item.content ?? "")
    .filter(Boolean)
    .at(-1) ?? payload?.answer ?? "");
}

function normalizedResources(work) {
  const resources = asArray(work.resources).map(String).map((value) => value.trim().replaceAll("\\", "/").replace(/\/{2,}/g, "/").replace(/\/$/, "")).filter(Boolean);
  return work.access === "write" && resources.length === 0 ? ["*"] : resources;
}

function overlaps(left, right) {
  const a = normalizedResources(left);
  const b = normalizedResources(right);
  return a.includes("*") || b.includes("*") || a.some((resource) => b.some((other) =>
    resource === other || resource.startsWith(`${other}/`) || other.startsWith(`${resource}/`)
  ));
}

function conflicts(left, right) {
  if (left.access !== "write" && right.access !== "write") return false;
  return overlaps(left, right);
}

function decisionApplies(decision, workId) {
  const ids = asArray(decision?.workIds);
  return ids.length === 0 || ids.includes(workId);
}

function workerPrompt(work, decisions, { continuation = false, direction = null } = {}) {
  const scoped = decisions.filter((decision) => decisionApplies(decision, work.id));
  const latest = scoped.reduce((revision, decision) => Math.max(revision, Number(decision.revision) || 0), 0);
  const decisionText = scoped.length
    ? scoped.map((decision) => `- Direction r${decision.revision}: ${bounded(decision.text, 4_000)}`).join("\n")
    : "- No scoped coordinator directions are currently recorded.";
  const prefix = continuation
    ? `Continue durable Focus work ${work.id}. Keep the same work identity and thread.`
    : `Execute durable Focus work ${work.id} for project ${work.projectId}.`;
  const requested = direction ? `\nNew direction to apply:\n${bounded(direction, 8_000)}\n` : "\n";
  const visualNote = !direction && asArray(work.visuals).length
    ? `\nAttached visuals in this model turn:\n${work.visuals.map((visual, index) => `- Image ${index + 1}: ${bounded(visual.label || visual.source, 120)} (${bounded(visual.source, 240)})`).join("\n")}\n`
    : "";
  return `${prefix}

Work request:
${bounded(work.prompt, 40_000)}
${requested}${visualNote}
Coordinator directions:
${decisionText}

Before presenting a result, inspect current project context, apply every scoped direction, and acknowledge direction revision ${latest} through the Focus acknowledgement tool. Report a concrete result for coordinator review, including verification performed and reviewable artifacts. Completion submits the work for review; it does not grant authority to mark it done. Do not delegate or spawn unmanaged worker threads; delegation belongs to the Focus coordinator and supervisor. Your runtime has full access. The work item's access field (${work.access}) only defines behavioral scope and resource-conflict scheduling. Do not broaden the coordinator's decisions or task scope.`;
}

/**
 * Durable, event-driven supervision for one coordinator and its project workers.
 * The store is the source of truth; in-memory maps only serialize operations.
 */
export class FocusSupervisor {
  constructor({
    store,
    visuals,
    runtime,
    contextForProject,
    startWorker,
    continueWorker,
    interruptWorker,
    deliver,
    onChange = () => {}
  }) {
    if (!store) throw new Error("FocusSupervisor requires a store");
    this.store = store;
    this.visuals = visuals;
    this.runtime = runtime;
    this.contextForProject = contextForProject;
    this.startWorker = startWorker;
    this.continueWorker = continueWorker;
    this.interruptWorker = interruptWorker;
    this.deliver = deliver;
    this.onChange = onChange;
    this.disposed = false;
    this.drains = new Map();
    this.drainAgain = new Set();
    this.delivery = new Map();
    this.deliveryAgain = new Set();
    this.recovery = null;
    this.recoveryProjects = new Set();
    this.recoverAll = false;
    this.threadIndex = new Map();
    this.startReservations = new Set();

    this.onRuntimeEvent = (event) => {
      Promise.resolve(this.#handleRuntimeEvent(event)).catch((error) => {
        const payload = payloadOf(event);
        const indexed = this.threadIndex.get(payload?.threadId);
        if (indexed) this.#recordFailure(indexed.projectId, indexed.workId, "runtime-listener-error", error);
      });
    };
    this.onRuntimeReady = () => {
      Promise.resolve(this.reconcile()).catch(() => {});
    };
    runtime?.on?.("event", this.onRuntimeEvent);
    runtime?.on?.("ready", this.onRuntimeReady);
  }

  state(projectId) {
    const work = this.store.listWork(projectId, { limit: 200 });
    const decisions = this.store.listDecisions(projectId, { limit: 100 });
    const policy = this.store.getPolicy(projectId);
    const seenSequence = Number(this.store.getSeen(projectId) ?? 0);
    const latestSequence = Number(this.store.latestSequence(projectId) ?? 0);
    const events = this.store.listEvents(projectId, { after: Math.max(0, latestSequence - 200), limit: 200 });
    const unseenEvents = this.store.listEvents(projectId, { after: seenSequence, limit: 200 });
    return { work, decisions, policy, events, seenSequence, latestSequence, unseenEvents };
  }

  inspect(projectId, id) {
    const work = this.store.getWork(projectId, id);
    if (!work) return null;
    const latestSequence = Number(this.store.latestSequence(projectId) ?? 0);
    const events = this.store.listEvents(projectId, { after: Math.max(0, latestSequence - 200), limit: 200 })
      .filter((event) => event.workId === id);
    const decisions = this.store.listDecisions(projectId, { workId: id, limit: 100 })
      .filter((decision) => decisionApplies(decision, id));
    return { ...work, events, decisions };
  }

  async dispatch(projectId, input) {
    if (this.disposed) throw new Error("Focus supervisor is disposed");
    const context = await this.contextForProject(projectId);
    if (!context?.coordinatorThreadId) throw new Error("Focus mode requires a coordinator thread");
    const access = input?.access === "read" ? "read" : "write";
    const stagedVisuals = input?.visuals?.length
      ? await this.visuals?.stage(projectId, context.coordinatorThreadId, input.visuals) : [];
    if (input?.visuals?.length && stagedVisuals?.length !== input.visuals.length) throw new Error("Focus visual staging failed; no worker was queued.");
    const created = this.store.createWork(projectId, {
      coordinatorThreadId: context.coordinatorThreadId,
      title: bounded(input?.title || input?.prompt || "Focus work", 160),
      prompt: bounded(input?.prompt, 80_000),
      model: input?.model || this.store.getPolicy(projectId).workerModel,
      effort: input?.effort ?? null,
      permissionMode: FOCUS_WORKER_PERMISSION_MODE,
      access,
      resources: normalizedResources({ access, resources: input?.resources }),
      visuals: stagedVisuals,
      dependsOn: asArray(input?.dependsOn),
      reviewOf: input?.reviewOf ?? null,
      status: "queued"
    });
    this.store.appendEvent(projectId, { workId: created.id, kind: "queued", message: "Work queued for supervision." });
    this.#changed(projectId);
    this.#scheduleDrain(projectId);
    return this.store.getWork(projectId, created.id) ?? created;
  }

  async followUp(projectId, id, { prompt, visuals = [] }) {
    let work = this.#requiredWork(projectId, id);
    if (!TERMINAL_STATUSES.has(work.status) && work.permissionMode !== FOCUS_WORKER_PERMISSION_MODE) {
      work = this.store.updateWork(projectId, id, { permissionMode: FOCUS_WORKER_PERMISSION_MODE });
    }
    if (["cancelled", "cancelling"].includes(work.status)) throw new Error("Cancelled work cannot be continued");
    const nextPrompt = bounded(prompt, 80_000);
    const stagedVisuals = visuals.length ? await this.visuals?.stage(projectId, work.coordinatorThreadId, visuals) : [];
    if (visuals.length && stagedVisuals?.length !== visuals.length) throw new Error("Focus visual staging failed; follow-up was not sent.");
    if (ACTIVE_STATUSES.has(work.status) && work.threadId && work.turnId) {
      const decisions = this.store.listDecisions(projectId, { workId: work.id, limit: 100 });
      const imageUrls = stagedVisuals.length ? await this.visuals.load(projectId, work.coordinatorThreadId, stagedVisuals) : [];
      const steered = await this.continueWorker({ projectId, workId: work.id, threadId: work.threadId, turnId: work.turnId,
        prompt: workerPrompt({ ...work, prompt: nextPrompt, visuals: stagedVisuals }, decisions, { continuation: true }), images: imageUrls,
        model: work.model, effort: work.effort, permissionMode: FOCUS_WORKER_PERMISSION_MODE });
      const updated = this.store.updateWork(projectId, id, {
        prompt: nextPrompt,
        visuals: stagedVisuals,
        turnId: steered?.turnId ?? steered?.turn?.id ?? work.turnId,
        answer: "",
        error: null,
        verification: null
      });
      this.#index(updated);
      this.store.appendEvent(projectId, { workId: id, kind: "continued", message: "Follow-up steered to the active worker." });
      this.#changed(projectId);
      return updated;
    }
    if (work.status === "starting") throw new Error("Worker dispatch is still starting; retry the follow-up after its thread is available");
    const updated = this.store.updateWork(projectId, id, {
      prompt: nextPrompt,
      visuals: stagedVisuals,
      status: "queued",
      turnId: null,
      answer: "",
      error: null,
      verification: null
    });
    this.store.appendEvent(projectId, { workId: id, kind: "continued", message: "Follow-up queued on the existing durable work item." });
    this.#changed(projectId);
    this.#scheduleDrain(projectId);
    return updated;
  }

  async control(projectId, id, { action }) {
    let work = this.#requiredWork(projectId, id);
    if (!TERMINAL_STATUSES.has(work.status) && work.permissionMode !== FOCUS_WORKER_PERMISSION_MODE) {
      work = this.store.updateWork(projectId, id, { permissionMode: FOCUS_WORKER_PERMISSION_MODE });
    }
    if (action === "pause") {
      const updated = this.store.updateWork(projectId, id, { status: "paused" });
      if (ACTIVE_STATUSES.has(work.status) && work.threadId && work.turnId) {
        try { await this.interruptWorker({ projectId, threadId: work.threadId, turnId: work.turnId }); }
        catch (error) {
          const attention = this.store.updateWork(projectId, id, { status: "needs-attention", error: errorMessage(error) });
          this.#changed(projectId);
          return attention;
        }
      }
      this.store.appendEvent(projectId, { workId: id, kind: "paused", message: "Work paused by the coordinator." });
      this.#changed(projectId);
      this.#scheduleDrain(projectId);
      return updated;
    }
    if (action === "resume") {
      if (work.status !== "paused" && work.status !== "needs-attention") throw new Error("Only paused or attention-required work can be resumed");
      if (!work.threadId) {
        const updated = this.store.updateWork(projectId, id, { status: "queued", error: null });
        this.#changed(projectId);
        this.#scheduleDrain(projectId);
        return updated;
      }
      const updated = this.store.updateWork(projectId, id, { status: "queued", turnId: null, error: null });
      this.#changed(projectId);
      this.#scheduleDrain(projectId);
      return updated;
    }
    if (action === "cancel") {
      if (TERMINAL_STATUSES.has(work.status)) return work;
      this.store.updateWork(projectId, id, { status: "cancelling" });
      if (work.threadId && work.turnId) {
        try { await this.interruptWorker({ projectId, threadId: work.threadId, turnId: work.turnId }); }
        catch (error) {
          const attention = this.store.updateWork(projectId, id, { status: "needs-attention", error: errorMessage(error) });
          this.#changed(projectId);
          return attention;
        }
      }
      const updated = this.store.updateWork(projectId, id, { status: "cancelled" });
      this.store.appendEvent(projectId, { workId: id, kind: "cancelled", message: "Work cancelled by the coordinator." });
      this.#changed(projectId);
      this.#scheduleDrain(projectId);
      return updated;
    }
    throw new Error(`Unsupported Focus control action: ${action}`);
  }

  async decide(projectId, { text, workIds = [], sourceThreadId = null }) {
    const decision = this.store.recordDecision(projectId, { text: bounded(text, 20_000), workIds, sourceThreadId });
    const affected = asArray(this.store.listRecoverableWork())
      .filter((work) => work.projectId === projectId && !TERMINAL_STATUSES.has(work.status) && decisionApplies(decision, work.id));
    for (const work of affected) this.store.updateWork(projectId, work.id, { decisionRevision: decision.revision });
    const targets = affected.filter((work) => ACTIVE_STATUSES.has(work.status) && work.threadId);
    const deliveredWorkIds = [];
    await Promise.allSettled(targets.map(async (work) => {
      try {
        const next = await this.continueWorker({ projectId, threadId: work.threadId, turnId: work.turnId,
          prompt: workerPrompt(work, [decision], { continuation: true, direction: bounded(text, 20_000) }),
          model: work.model, effort: work.effort, permissionMode: FOCUS_WORKER_PERMISSION_MODE });
        const turnId = next?.turnId ?? next?.turn?.id;
        if (turnId) {
          const updated = this.store.updateWork(projectId, work.id, { turnId });
          this.#index(updated);
        }
        deliveredWorkIds.push(work.id);
        this.store.appendEvent(projectId, { workId: work.id, kind: "direction-delivered", message: `Direction r${decision.revision} was delivered; worker acknowledgement is pending.`, decisionRevision: decision.revision });
      } catch (error) {
        this.store.appendEvent(projectId, { workId: work.id, kind: "direction-delivery-failed", message: errorMessage(error), decisionRevision: decision.revision });
      }
    }));
    this.#changed(projectId);
    return { ...decision, affectedWorkIds: affected.map((work) => work.id), deliveredWorkIds };
  }

  acknowledge(projectId, id, { revision }) {
    const work = this.#requiredWork(projectId, id);
    const value = Number(revision);
    if (!Number.isInteger(value) || value < 0 || value > Number(work.decisionRevision ?? 0)) {
      throw new Error("Acknowledgement revision is outside this work item's delivered direction range");
    }
    if (value < Number(work.acknowledgedDecisionRevision ?? 0)) return work;
    const updated = this.store.updateWork(projectId, id, { acknowledgedDecisionRevision: value });
    this.store.appendEvent(projectId, { workId: id, kind: "direction-acknowledged", message: `Worker acknowledged direction r${value}.`, decisionRevision: value });
    this.#changed(projectId);
    return updated;
  }

  resolve(projectId, id, { summary, verification, artifacts = [] }) {
    const work = this.#requiredWork(projectId, id);
    if (work.status !== "review") throw new Error("Work must be in coordinator review before it can be completed");
    if (Number(work.acknowledgedDecisionRevision ?? 0) < Number(work.decisionRevision ?? 0)) {
      throw new Error("This result is stale because the worker has not acknowledged the latest coordinator direction");
    }
    const status = verification?.status;
    const evidence = bounded(verification?.evidence, 20_000).trim();
    if (!new Set(["passed", "not-required"]).has(status) || !evidence) {
      throw new Error("Completion requires passed verification evidence or a concrete not-required justification");
    }
    const updated = this.store.updateWork(projectId, id, {
      status: "done",
      answer: bounded(summary, 40_000),
      verification: { status, evidence },
      artifacts: asArray(artifacts).slice(0, 32)
    });
    this.store.appendEvent(projectId, { workId: id, kind: "completed", message: bounded(summary, 4_000) || "Work reviewed and completed." });
    this.#changed(projectId);
    this.#scheduleDelivery(projectId);
    this.#scheduleDrain(projectId);
    return updated;
  }

  markSeen(projectId, sequence) {
    this.store.markSeen(projectId, Number(sequence));
    this.#changed(projectId);
    return this.state(projectId);
  }

  /** Explicitly retries recovery and pending coordinator delivery; no idle loop is used. */
  reconcile(projectId = null) {
    if (this.disposed) return Promise.resolve([]);
    if (projectId === null) {
      this.recoverAll = true;
      this.recoveryProjects.clear();
    } else if (!this.recoverAll) {
      this.recoveryProjects.add(projectId);
    }
    if (this.recovery) return this.recovery;
    const operation = (async () => {
      const results = [];
      while (!this.disposed && (this.recoverAll || this.recoveryProjects.size)) {
        const scope = this.recoverAll ? null : this.recoveryProjects.values().next().value;
        this.recoverAll = false;
        if (scope === null) this.recoveryProjects.clear();
        else this.recoveryProjects.delete(scope);
        results.push(...await this.#reconcileOnce(scope));
      }
      return results;
    })();
    this.recovery = operation;
    operation.finally(() => {
      if (this.recovery === operation) this.recovery = null;
    }).catch(() => {});
    return operation;
  }

  async #reconcileOnce(projectId) {
    if (this.disposed) return [];
    const records = asArray(this.store.listRecoverableWork(projectId));
    const results = [];
    for (const work of records) {
      if (projectId && work.projectId !== projectId) continue;
      if (this.startReservations.has(work.id)) continue;
      results.push(await this.#recover(work));
    }
    const projects = new Set(records.map((work) => work.projectId));
    if (projectId) projects.add(projectId);
    for (const id of projects) {
      await this.#requestDelivery(id);
      this.#scheduleDrain(id);
    }
    return results;
  }

  ready(projectId = null) {
    return this.reconcile(projectId);
  }

  recover(projectId = null) {
    return this.reconcile(projectId);
  }

  drain(projectId) {
    this.#scheduleDrain(projectId);
  }

  policyChanged(projectId) {
    this.#scheduleDrain(projectId);
  }

  providerUnavailable(provider, affectedWorkIds = []) {
    if (this.disposed) return [];
    const explicit = new Set(asArray(affectedWorkIds));
    const affected = [];
    for (const work of asArray(this.store.listRecoverableWork())) {
      if (!ACTIVE_STATUSES.has(work.status)) continue;
      const matches = explicit.has(work.id)
        || (work.threadId && this.runtime?.providerForThread?.(work.threadId) === provider);
      if (!matches) continue;
      const message = `${DEFERRED_RECOVERY_PREFIX} ${provider || "worker"} is unavailable.`;
      const updated = this.store.updateWork(work.projectId, work.id, { status: "needs-attention", error: message });
      this.store.appendEvent(work.projectId, { workId: work.id, kind: "needs-attention", message, recoverable: true, provider });
      this.#changed(work.projectId);
      this.#scheduleDelivery(work.projectId);
      this.#scheduleDrain(work.projectId);
      affected.push(updated);
    }
    return affected;
  }

  /** Explicit delivery retry hook, intended for coordinator turn completion. */
  flush(projectId) {
    return this.#requestDelivery(projectId);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.runtime?.off?.("event", this.onRuntimeEvent);
    this.runtime?.off?.("ready", this.onRuntimeReady);
    this.drains.clear();
    this.drainAgain.clear();
    this.delivery.clear();
    this.deliveryAgain.clear();
    this.recoveryProjects.clear();
    this.recoverAll = false;
    this.threadIndex.clear();
    this.startReservations.clear();
  }

  #requiredWork(projectId, id) {
    const work = this.store.getWork(projectId, id);
    if (!work) throw new Error(`Unknown Focus work item: ${id}`);
    return work;
  }

  #changed(projectId) {
    try { this.onChange(projectId); } catch { /* Change observers cannot break supervision. */ }
  }

  #index(work) {
    if (work?.threadId) this.threadIndex.set(work.threadId, { projectId: work.projectId, workId: work.id });
  }

  #scheduleDrain(projectId) {
    if (this.disposed) return;
    if (this.drains.has(projectId)) {
      this.drainAgain.add(projectId);
      return;
    }
    const operation = Promise.resolve().then(() => this.#drain(projectId));
    this.drains.set(projectId, operation);
    operation.catch((error) => this.#recordFailure(projectId, null, "queue-drain-error", error)).finally(() => {
      if (this.drains.get(projectId) === operation) this.drains.delete(projectId);
      if (this.drainAgain.delete(projectId)) this.#scheduleDrain(projectId);
    }).catch(() => {});
  }

  async #drain(projectId) {
    if (this.disposed) return;
    let work = asArray(this.store.listRecoverableWork()).filter((item) => item.projectId === projectId)
      .map((item) => item.permissionMode === FOCUS_WORKER_PERMISSION_MODE
        ? item
        : this.store.updateWork(projectId, item.id, { permissionMode: FOCUS_WORKER_PERMISSION_MODE }));
    for (const queued of work.filter((item) => ["queued", "blocked"].includes(item.status))) {
      const dependencies = asArray(queued.dependsOn).map((id) => this.store.getWork(projectId, id));
      const failed = dependencies.find((item) => !item || ["failed", "cancelled", "needs-attention"].includes(item.status));
      const waiting = dependencies.some((item) => item && item.status !== "done");
      const status = failed || waiting ? "blocked" : "queued";
      const reason = failed ? `Dependency ${failed?.id ?? "missing"} cannot complete.` : waiting ? "Waiting for dependencies to complete." : null;
      if (queued.status !== status || queued.error !== reason) this.store.updateWork(projectId, queued.id, { status, error: reason });
    }
    work = asArray(this.store.listRecoverableWork()).filter((item) => item.projectId === projectId);
    const active = work.filter((item) => ACTIVE_STATUSES.has(item.status)
      || this.startReservations.has(item.id)
      || (item.status === "needs-attention" && item.threadId && item.turnId && String(item.error ?? "").startsWith(DEFERRED_RECOVERY_PREFIX)));
    const selected = [];
    for (const candidate of work.filter((item) => item.status === "queued")) {
      if ([...active, ...selected].some((other) => conflicts(candidate, other))) continue;
      this.startReservations.add(candidate.id);
      const starting = this.store.updateWork(projectId, candidate.id, { status: "starting", error: null });
      selected.push(starting);
      this.#changed(projectId);
    }
    for (const candidate of selected) {
      void this.#launch(candidate).catch((error) => this.#recordFailure(projectId, candidate.id, "worker-start-failed", error));
    }
  }

  async #launch(work) {
    try {
      let current = this.store.getWork(work.projectId, work.id);
      if (!current || current.status !== "starting") return;
      const decisions = this.store.listDecisions(work.projectId, { workId: work.id, limit: 100 });
      const scopedRevision = decisions.filter((decision) => decisionApplies(decision, work.id))
        .reduce((revision, decision) => Math.max(revision, Number(decision.revision) || 0), 0);
      if (Number(current.decisionRevision ?? 0) < scopedRevision) {
        current = this.store.updateWork(work.projectId, work.id, { decisionRevision: scopedRevision });
      }
      const request = {
        projectId: work.projectId,
        workId: work.id,
        coordinatorThreadId: work.coordinatorThreadId,
        prompt: workerPrompt(current, decisions, { continuation: Boolean(current.threadId) }),
        images: asArray(current.visuals).length ? await this.visuals.load(work.projectId, current.coordinatorThreadId, current.visuals) : [],
        model: work.model,
        effort: work.effort,
        permissionMode: FOCUS_WORKER_PERMISSION_MODE
      };
      const started = current.threadId
        ? await this.continueWorker({ ...request, threadId: current.threadId })
        : await this.startWorker(request);
      if (this.disposed) return;
      const latest = this.store.getWork(work.projectId, work.id);
      if (!latest) return;
      const startedThreadId = started?.threadId ?? started?.thread?.id ?? latest.threadId;
      const startedTurnId = started?.turnId ?? started?.turn?.id ?? latest.turnId;
      if (["paused", "cancelled", "cancelling"].includes(latest.status)) {
        if (startedThreadId && startedTurnId) {
          await this.interruptWorker({ projectId: work.projectId, threadId: startedThreadId, turnId: startedTurnId }).catch(() => {});
        }
        if (!this.disposed && latest.status === "cancelling") {
          this.store.updateWork(work.projectId, work.id, { status: "cancelled", threadId: startedThreadId, turnId: startedTurnId });
        }
        return;
      }
      // startWorker may emit a synchronous completion before its promise resolves.
      if (latest.status !== "starting") {
        this.#index(latest);
        return;
      }
      const updated = this.store.updateWork(work.projectId, work.id, {
        status: "running",
        threadId: startedThreadId,
        turnId: startedTurnId,
        decisionRevision: Math.max(Number(latest.decisionRevision ?? 0), scopedRevision)
      });
      this.#index(updated);
      this.store.appendEvent(work.projectId, { workId: work.id, kind: "started", message: "Worker started." });
      this.#changed(work.projectId);
    } catch (error) {
      if (this.disposed) return;
      const current = this.store.getWork(work.projectId, work.id);
      if (current && current.status !== "cancelled") {
        this.store.updateWork(work.projectId, work.id, { status: "failed", error: errorMessage(error) });
        this.store.appendEvent(work.projectId, { workId: work.id, kind: "failed", message: errorMessage(error) });
        this.#changed(work.projectId);
        this.#scheduleDelivery(work.projectId);
      }
    } finally {
      this.startReservations.delete(work.id);
      queueMicrotask(() => this.#scheduleDrain(work.projectId));
    }
  }

  async #handleRuntimeEvent(event) {
    if (this.disposed) return;
    const payload = payloadOf(event);
    if (!payload?.threadId) return;
    let indexed = this.threadIndex.get(payload.threadId);
    if (!indexed) {
      const recoverable = this.store.getWorkByThread?.(payload.threadId)
        ?? asArray(this.store.listRecoverableWork()).find((work) => work.threadId === payload.threadId);
      if (!recoverable) return;
      this.#index(recoverable);
      indexed = { projectId: recoverable.projectId, workId: recoverable.id };
    }
    const work = this.store.getWork(indexed.projectId, indexed.workId);
    if (!work) return;
    if (payload.method === "turn/started") {
      const turnId = payload.turn?.id ?? payload.turnId;
      if (turnId && ["starting", "running"].includes(work.status) && (!work.turnId || work.status === "starting")) {
        this.store.updateWork(work.projectId, work.id, { turnId, status: "running" });
      }
      return;
    }
    if (payload.method !== "turn/completed") return;
    if (["queued", "blocked", "paused", "cancelled"].includes(work.status) || (work.status === "starting" && !work.turnId)) return;
    const turnId = payload.turn?.id ?? payload.turnId;
    if (work.turnId && turnId && work.turnId !== turnId) return;
    if (["review", "done"].includes(work.status)) return;
    const turnStatus = payload.turn?.status ?? payload.status ?? "completed";
    if (work.status === "cancelling") {
      this.store.updateWork(work.projectId, work.id, { status: "cancelled" });
      this.store.appendEvent(work.projectId, { workId: work.id, kind: "cancelled", message: "Worker stopped after cancellation." });
      this.#changed(work.projectId);
      this.#scheduleDrain(work.projectId);
      return;
    }
    if (turnStatus === "interrupted" && work.status === "paused") return;
    if (turnStatus !== "completed") {
      const status = work.status === "cancelling" ? "cancelled" : "failed";
      this.store.updateWork(work.projectId, work.id, { status, error: errorMessage(payload.turn?.error ?? payload.error ?? turnStatus) });
      this.store.appendEvent(work.projectId, { workId: work.id, kind: status, message: `Worker turn ${turnStatus}.` });
      this.#changed(work.projectId);
      this.#scheduleDelivery(work.projectId);
      this.#scheduleDrain(work.projectId);
      return;
    }
    let answer = completedAnswer(payload);
    if (!answer && work.threadId) {
      try {
        const response = await this.runtime.request("thread/read", { threadId: work.threadId, includeTurns: true });
        if (this.disposed) return;
        const current = this.store.getWork(work.projectId, work.id);
        if (!current || current.status !== work.status || current.turnId !== work.turnId) return;
        const detail = asArray((response?.thread ?? response)?.turns).find((candidate) => candidate.id === (turnId ?? work.turnId));
        if (detail) answer = completedAnswer({ ...payload, turn: detail });
      } catch {
        if (this.disposed) return;
        const current = this.store.getWork(work.projectId, work.id);
        if (!current || current.status !== work.status || current.turnId !== work.turnId) return;
      }
    }
    const updated = this.store.updateWork(work.projectId, work.id, {
      status: "review",
      answer,
      error: null
    });
    const stale = Number(updated.acknowledgedDecisionRevision ?? 0) < Number(updated.decisionRevision ?? 0);
    this.store.appendEvent(work.projectId, {
      workId: work.id,
      kind: stale ? "review-stale" : "review-ready",
      message: stale ? "Worker result needs the latest direction acknowledgement before review can complete." : "Worker result is ready for coordinator review."
    });
    this.#changed(work.projectId);
    this.#scheduleDelivery(work.projectId);
    this.#scheduleDrain(work.projectId);
  }

  #scheduleDelivery(projectId) {
    void this.#requestDelivery(projectId);
  }

  #requestDelivery(projectId) {
    if (this.disposed) return Promise.resolve(null);
    if (this.delivery.has(projectId)) {
      this.deliveryAgain.add(projectId);
      return this.delivery.get(projectId).then(() => {
        if (this.disposed || !this.deliveryAgain.delete(projectId)) return null;
        return this.#requestDelivery(projectId);
      });
    }
    const operation = Promise.resolve().then(() => this.#deliverPending(projectId));
    this.delivery.set(projectId, operation);
    operation.finally(() => {
      if (this.delivery.get(projectId) === operation) this.delivery.delete(projectId);
    }).catch(() => {});
    return operation;
  }

  async #deliverPending(projectId) {
    const significantKinds = new Set(["review-ready", "review-stale", "failed", "cancelled", "needs-attention", "completed", "direction-delivery-failed", "question-answered"]);
    let events = [];
    while (!this.disposed && events.length === 0) {
      const pending = asArray(this.store.pendingEvents(projectId, 200));
      if (!pending.length) return null;
      events = pending.filter((event) => significantKinds.has(event.kind)).slice(0, 25);
      const informationalIds = pending.filter((event) => !significantKinds.has(event.kind)).map((event) => event.id);
      if (informationalIds.length) this.store.markEventsDelivered(projectId, informationalIds);
      if (events.length === 0 && pending.length < 200) return null;
    }
    if (!events.length || this.disposed) return null;
    try {
      const context = await this.contextForProject(projectId);
      if (this.disposed) return null;
      if (!context?.coordinatorThreadId) return null;
      const accepted = await this.deliver({ projectId, coordinatorThreadId: context.coordinatorThreadId, events });
      if (this.disposed) return accepted;
      if (accepted === false || accepted?.accepted === false) return accepted;
      const acceptedIds = asArray(accepted?.eventIds).length ? accepted.eventIds : events.map((event) => event.id);
      this.store.markEventsDelivered(projectId, acceptedIds);
      for (const workId of new Set(events.filter((event) => acceptedIds.includes(event.id)).map((event) => event.workId).filter(Boolean))) {
        const work = this.store.getWork(projectId, workId);
        if (work && ["review", "done", "failed", "cancelled", "needs-attention"].includes(work.status)) {
          this.store.updateWork(projectId, workId, { completionReported: true });
        }
      }
      this.#changed(projectId);
      return accepted;
    } catch (error) {
      // Delivery retries only on a later explicit ready/reconcile or a new completion.
      return { accepted: false, error: errorMessage(error) };
    }
  }

  async #recover(work) {
    let current = this.store.getWork(work.projectId, work.id);
    if (!current || !shouldRecover(current)) return current ?? work;
    if (current.permissionMode !== FOCUS_WORKER_PERMISSION_MODE) {
      current = this.store.updateWork(current.projectId, current.id, { permissionMode: FOCUS_WORKER_PERMISSION_MODE });
    }
    this.#index(current);
    if (this.startReservations.has(current.id)) return current;
    if (!current.threadId || !current.turnId) {
      const attention = this.store.updateWork(current.projectId, current.id, {
        status: "needs-attention",
        error: "Pixice stopped while worker dispatch was ambiguous. Review before resuming; it was not restarted automatically."
      });
      this.store.appendEvent(current.projectId, { workId: current.id, kind: "needs-attention", message: attention.error });
      this.#changed(current.projectId);
      this.#scheduleDelivery(current.projectId);
      return attention;
    }
    const expected = { revision: current.revision, status: current.status, threadId: current.threadId, turnId: current.turnId };
    try {
      const response = await this.runtime.request("thread/read", { threadId: current.threadId, includeTurns: true });
      if (this.disposed) return current;
      current = this.store.getWork(current.projectId, current.id);
      if (!current || current.revision !== expected.revision || current.status !== expected.status
        || current.threadId !== expected.threadId || current.turnId !== expected.turnId) return current ?? work;
      const thread = response?.thread ?? response;
      const turn = asArray(thread?.turns).find((candidate) => candidate.id === current.turnId);
      if (!turn) throw new Error("The worker turn is missing from its thread");
      if (["inProgress", "running", "started"].includes(turn.status)) {
        const running = this.store.updateWork(current.projectId, current.id, { status: "running", error: null });
        this.#index(running);
        return running;
      }
      await this.#handleRuntimeEvent({ method: "turn/completed", threadId: current.threadId, turn });
      return this.store.getWork(current.projectId, current.id);
    } catch (error) {
      if (this.disposed) return current;
      const latest = this.store.getWork(current.projectId, current.id);
      if (!latest || latest.revision !== expected.revision || latest.status !== expected.status
        || latest.threadId !== expected.threadId || latest.turnId !== expected.turnId) return latest ?? current;
      const deferred = recoverableProviderError(error);
      const attention = this.store.updateWork(current.projectId, current.id, {
        status: "needs-attention",
        error: deferred
          ? `${DEFERRED_RECOVERY_PREFIX} ${errorMessage(error)}`
          : `Worker recovery needs attention: ${errorMessage(error)}`
      });
      this.store.appendEvent(current.projectId, { workId: current.id, kind: "needs-attention", message: attention.error, recoverable: deferred });
      this.#changed(current.projectId);
      this.#scheduleDelivery(current.projectId);
      return attention;
    }
  }

  #recordFailure(projectId, workId, kind, error) {
    try {
      const message = errorMessage(error);
      const work = workId ? this.store.getWork(projectId, workId) : null;
      if (work && !TERMINAL_STATUSES.has(work.status)) {
        this.store.updateWork(projectId, workId, { status: "needs-attention", error: message });
        this.store.appendEvent(projectId, { workId, kind: "needs-attention", message, source: kind });
      } else {
        this.store.appendEvent(projectId, { workId, kind, message });
      }
      this.#changed(projectId);
      this.#scheduleDelivery(projectId);
    } catch { /* Listener containment must remain best effort. */ }
  }
}

export default FocusSupervisor;
