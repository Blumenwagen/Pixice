import http from "node:http";
import { randomUUID } from "node:crypto";
import { normalizeWorkflowNodeConfig } from "./workflow-node-catalog.mjs";
import { workflowNextScheduleDate } from "./workflow-cron.mjs";
import { workflowCredentialAuthorizesRequest } from "./workflow-credential-store.mjs";

const MAX_TIMER_DELAY = 2_147_000_000;

function statusKey(workflowId, nodeId) {
  return `${workflowId}:${nodeId}`;
}

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (_key, entry) => typeof entry === "bigint" ? entry.toString() : entry));
}

function sendJson(response, statusCode, value) {
  const body = Buffer.from(JSON.stringify(jsonSafe(value)), "utf8");
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.byteLength),
    "cache-control": "no-store"
  });
  response.end(body);
}

function queryObject(searchParams) {
  const result = {};
  for (const [key, value] of searchParams) {
    if (!Object.prototype.hasOwnProperty.call(result, key)) result[key] = value;
    else if (Array.isArray(result[key])) result[key].push(value);
    else result[key] = [result[key], value];
  }
  return result;
}

async function readRequestBody(request, maximumBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.byteLength;
    if (total > maximumBytes) throw Object.assign(new Error(`Webhook request exceeded ${maximumBytes} bytes`), { statusCode: 413 });
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  const contentType = String(request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
  if (!buffer.length) return null;
  if (contentType === "application/json" || contentType.endsWith("+json")) {
    try { return JSON.parse(buffer.toString("utf8")); } catch (error) {
      throw Object.assign(new Error(`Webhook JSON body is invalid: ${error.message}`), { statusCode: 400 });
    }
  }
  if (contentType === "application/x-www-form-urlencoded") return queryObject(new URLSearchParams(buffer.toString("utf8")));
  if (contentType.startsWith("text/") || !contentType) return buffer.toString("utf8");
  return { encoding: "base64", contentType, data: buffer.toString("base64"), bytes: buffer.byteLength };
}

function promiseWithTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    })
  ]);
}

export class WorkflowTriggerHost {
  constructor({
    store,
    workflows,
    database,
    credentialStore,
    prepareCredentials = async () => {},
    onChange,
    notify,
    createServer = http.createServer,
    now = () => new Date(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    onAttention
  }) {
    this.store = store;
    this.workflows = workflows;
    this.database = database;
    this.credentialStore = credentialStore;
    this.prepareCredentials = prepareCredentials;
    this.onChange = onChange;
    this.notify = notify;
    this.onAttention = onAttention;
    this.createServer = createServer;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.scheduleTimers = new Map();
    this.taskTimers = new Map();
    this.servers = new Map();
    this.statuses = new Map();
    this.pendingMissed = new Map();
    this.startupFired = new Set();
    this.generation = 0;
    this.refreshPromise = Promise.resolve();
    this.closed = false;
    this.unsubscribeBoardEvents = null;
  }

  start() {
    this.unsubscribeBoardEvents = this.database?.subscribeBoardEvents?.((event) => void this.handleBoardEvent(event));
    return this.refresh();
  }

  refresh() {
    this.refreshPromise = this.refreshPromise
      .catch(() => null)
      .then(() => this.#refresh());
    return this.refreshPromise;
  }

  list(projectId) {
    return [...this.statuses.values()]
      .filter((status) => !projectId || status.projectId === projectId)
      .sort((left, right) => left.workflowName.localeCompare(right.workflowName) || left.nodeName.localeCompare(right.nodeName));
  }

  async close() {
    this.closed = true;
    this.generation += 1;
    for (const timer of this.scheduleTimers.values()) this.clearTimer(timer);
    this.scheduleTimers.clear();
    for (const timer of this.taskTimers.values()) this.clearTimer(timer);
    this.taskTimers.clear();
    this.unsubscribeBoardEvents?.();
    this.unsubscribeBoardEvents = null;
    await this.#closeServers();
    this.statuses.clear();
    this.pendingMissed.clear();
  }

  async #refresh() {
    if (this.closed) return;
    const generation = ++this.generation;
    for (const timer of this.scheduleTimers.values()) this.clearTimer(timer);
    this.scheduleTimers.clear();
    for (const timer of this.taskTimers.values()) this.clearTimer(timer);
    this.taskTimers.clear();
    await this.#closeServers();
    this.statuses.clear();

    const enabled = this.store.listAllWorkflows().filter((workflow) => workflow.enabled);
    const webhookGroups = new Map();
    for (const workflow of enabled) {
      for (const node of workflow.graph.nodes) {
        if (node.type === "scheduleTrigger") this.#installSchedule(workflow, node, generation);
        if (node.type === "webhookTrigger") {
          const config = normalizeWorkflowNodeConfig(node);
          const routes = webhookGroups.get(config.port) ?? [];
          routes.push({ workflow, node, config });
          webhookGroups.set(config.port, routes);
        }
      }
    }
    this.#installTaskBindings(enabled, generation);
    await Promise.all([...webhookGroups].map(([port, routes]) => this.#installWebhookServer(port, routes, generation)));
    this.#publish();
  }

  async handleBoardEvent(event) {
    if (this.closed || !event?.task) return;
    if (["binding-updated", "binding-deleted", "deleted", "plan-applied"].includes(event.action)) void this.refresh();
    if (event.action === "deleted") return;
    const task = event.task;
    const eventTypes = [];
    if (event.action === "moved" && event.previous?.column !== "ready" && task.column === "ready") eventTypes.push("entered-ready");
    if (["created", "updated", "plan-applied"].includes(event.action)
      && JSON.stringify(event.previous?.schedule ?? null) !== JSON.stringify(task.schedule ?? null)) eventTypes.push("schedule-changed");
    if (task.column === "done") {
      for (const candidate of this.database.listBoardTasks(task.projectId)) {
        if (!candidate.dependencies?.some((dependency) => dependency.dependsOnTaskId === task.id)) continue;
        const dependenciesDone = candidate.dependencies.every((dependency) => this.database.getBoardTask(dependency.dependsOnTaskId)?.column === "done");
        if (dependenciesDone) await this.#fireBindings(candidate, "dependencies-completed", new Date().toISOString(), false);
      }
    }
    for (const eventType of eventTypes) await this.#fireBindings(task, eventType, new Date().toISOString(), false);
  }

  #installTaskBindings(enabledWorkflows, generation) {
    if (!this.database) return;
    const enabledById = new Map(enabledWorkflows.map((workflow) => [workflow.id, workflow]));
    const projects = [...new Set(enabledWorkflows.map((workflow) => workflow.projectId))];
    for (const projectId of projects) {
      for (const binding of this.database.listBoardTaskWorkflowBindings(null, projectId).filter((candidate) => candidate.enabled)) {
        const workflow = enabledById.get(binding.workflowId);
        const task = this.database.getBoardTask(binding.taskId);
        if (!workflow || !task) continue;
        const node = this.#taskTriggerNode(workflow, binding);
        const key = `task:${binding.id}`;
        const status = this.#baseStatus(workflow, node ?? { id: binding.triggerNodeId ?? binding.id, name: "Task event" }, "task");
        status.taskId = task.id;
        status.bindingId = binding.id;
        this.statuses.set(key, status);
        const config = node ? normalizeWorkflowNodeConfig(node) : { eventType: binding.triggerType, leadMinutes: 1_440 };
        let dueAt = null;
        if (binding.triggerType === "planned-start-reached") dueAt = task.schedule?.plannedStart;
        if (binding.triggerType === "deadline-approaching" && task.schedule?.hardDeadline) {
          dueAt = new Date(new Date(task.schedule.hardDeadline).getTime() - config.leadMinutes * 60_000).toISOString();
        }
        if (binding.triggerType === "became-overdue") dueAt = task.schedule?.hardDeadline;
        if (!dueAt || task.column === "done") continue;
        status.nextRunAt = dueAt;
        const delay = new Date(dueAt).getTime() - this.now().getTime();
        if (delay <= 0) {
          const timer = this.setTimer(() => void this.#fireTaskBinding(task, binding, binding.triggerType, dueAt, true, generation), 0);
          timer.unref?.();
          this.taskTimers.set(key, timer);
        } else {
          const timer = this.setTimer(() => {
            this.taskTimers.delete(key);
            if (delay > MAX_TIMER_DELAY) void this.refresh();
            else void this.#fireTaskBinding(task, binding, binding.triggerType, dueAt, false, generation);
          }, Math.min(MAX_TIMER_DELAY, delay));
          timer.unref?.();
          this.taskTimers.set(key, timer);
        }
      }
    }
  }

  #taskTriggerNode(workflow, binding) {
    return workflow.graph.nodes.find((node) => node.type === "taskEventTrigger"
      && (!binding.triggerNodeId || node.id === binding.triggerNodeId)
      && normalizeWorkflowNodeConfig(node).eventType === binding.triggerType) ?? null;
  }

  async #fireBindings(task, eventType, effectiveAt, missed) {
    const bindings = this.database.listBoardTaskWorkflowBindings(task.id).filter((binding) => binding.enabled && binding.triggerType === eventType);
    for (const binding of bindings) await this.#fireTaskBinding(task, binding, eventType, effectiveAt, missed, this.generation);
  }

  async #fireTaskBinding(task, binding, eventType, effectiveAt, missed, generation) {
    if (this.closed || generation !== this.generation) return;
    const workflow = this.store.getWorkflow(binding.workflowId);
    const node = workflow && this.#taskTriggerNode(workflow, binding);
    const status = this.statuses.get(`task:${binding.id}`);
    if (!workflow?.enabled || !node) {
      if (status) Object.assign(status, { status: "error", error: "The enabled binding has no matching enabled Task Event Trigger." });
      this.#publish();
      return;
    }
    if (missed && binding.missedTriggerPolicy === "ask") {
      const requestId = `workflow-missed:${binding.id}:${task.revision}:${eventType}`;
      if (!this.pendingMissed.has(requestId)) {
        this.pendingMissed.set(requestId, { taskId: task.id, bindingId: binding.id, eventType, effectiveAt, generation });
        this.onAttention?.({
          id: requestId,
          method: "workflow/taskEvent/requestApproval",
          projectId: task.projectId,
          params: {
            threadId: task.threadId ?? binding.createdByThreadId ?? null,
            taskId: task.id,
            workflowId: workflow.id,
            bindingId: binding.id,
            allowForSession: false,
            reason: `Run missed ${eventType} event for “${task.title}” in Workflow “${workflow.name}”?`
          }
        });
        this.database.recordBoardTaskActivity({
          id: randomUUID(), taskId: task.id, projectId: task.projectId, kind: "workflow-awaiting-approval",
          summary: `Waiting for approval to run missed ${eventType} Workflow event.`,
          dedupeKey: requestId,
          metadata: { workflowId: workflow.id, bindingId: binding.id, eventType, effectiveAt, requestId },
          actorKind: "workflow", actorId: workflow.id
        });
      }
      if (status) Object.assign(status, { lastTriggeredAt: effectiveAt, lastResult: "awaiting-approval", nextRunAt: null });
      this.#publish();
      return;
    }
    if (missed && binding.missedTriggerPolicy !== "run") {
      if (binding.missedTriggerPolicy === "notify") {
        await this.notify?.({
          title: `Missed Workflow event · ${task.title}`,
          body: `${workflow.name} did not run because the ${eventType} event was already due.`,
          urgency: "normal",
          silent: false
        });
      }
      this.database.recordBoardTaskActivity({
        id: randomUUID(), taskId: task.id, projectId: task.projectId, kind: "workflow-missed",
        summary: `Held missed ${eventType} Workflow event for policy “${binding.missedTriggerPolicy}”.`,
        dedupeKey: `workflow-missed:${binding.id}:${task.revision}:${eventType}`,
        metadata: { workflowId: workflow.id, bindingId: binding.id, eventType, effectiveAt, policy: binding.missedTriggerPolicy },
        actorKind: "workflow", actorId: workflow.id
      });
      if (status) Object.assign(status, { lastTriggeredAt: effectiveAt, lastResult: `missed-${binding.missedTriggerPolicy}`, nextRunAt: null });
      this.#publish();
      return;
    }
    const idempotencyKey = `${binding.id}:${task.id}:${task.revision}:${eventType}`;
    if (!this.database.claimBoardTaskTrigger({ idempotencyKey, bindingId: binding.id, taskId: task.id, workflowId: workflow.id, eventType, effectiveAt })) return;
    try {
      const run = this.workflows.startRun({
        projectId: task.projectId,
        workflowId: workflow.id,
        triggerNodeId: node.id,
        input: { trigger: { type: "task-event", eventType, effectiveAt, missed, bindingId: binding.id }, task }
      });
      this.database.completeBoardTaskTrigger(idempotencyKey, run.id);
      this.database.recordBoardTaskActivity({
        id: randomUUID(), taskId: task.id, projectId: task.projectId, kind: "workflow-run",
        summary: `Started Workflow “${workflow.name}” for ${eventType}.`,
        dedupeKey: `workflow-run:${idempotencyKey}`,
        metadata: { workflowId: workflow.id, bindingId: binding.id, eventType, effectiveAt, runId: run.id },
        actorKind: "workflow", actorId: workflow.id
      });
      if (status) Object.assign(status, { lastTriggeredAt: effectiveAt, lastRunId: run.id, lastResult: "started", nextRunAt: null, error: null });
    } catch (error) {
      this.database.recordBoardTaskActivity({
        id: randomUUID(), taskId: task.id, projectId: task.projectId, kind: "workflow-error",
        summary: `Workflow “${workflow.name}” could not start for ${eventType}: ${error.message}`,
        dedupeKey: `workflow-error:${idempotencyKey}`,
        metadata: { workflowId: workflow.id, bindingId: binding.id, eventType, effectiveAt },
        actorKind: "workflow", actorId: workflow.id
      });
      if (status) Object.assign(status, { lastTriggeredAt: effectiveAt, lastResult: "failed-to-start", error: error.message });
    }
    this.#publish();
  }

  async resolveMissed(requestId, decision) {
    const pending = this.pendingMissed.get(requestId);
    if (!pending) throw new Error("Missed Workflow event is no longer pending");
    this.pendingMissed.delete(requestId);
    const task = this.database.getBoardTask(pending.taskId);
    const binding = task && this.database.listBoardTaskWorkflowBindings(task.id).find((candidate) => candidate.id === pending.bindingId);
    if (!task || !binding?.enabled) throw new Error("The Workflow binding is no longer enabled");
    if (decision === "accept") {
      return this.#fireTaskBinding(task, { ...binding, missedTriggerPolicy: "run" }, pending.eventType, pending.effectiveAt, true, this.generation);
    }
    this.database.recordBoardTaskActivity({
      id: randomUUID(), taskId: task.id, projectId: task.projectId, kind: "workflow-missed",
      summary: `Declined missed ${pending.eventType} Workflow event.`,
      dedupeKey: `workflow-declined:${requestId}`,
      metadata: { workflowId: binding.workflowId, bindingId: binding.id, eventType: pending.eventType, effectiveAt: pending.effectiveAt, policy: "ask" },
      actorKind: "user", actorId: null
    });
    const status = this.statuses.get(`task:${binding.id}`);
    if (status) Object.assign(status, { lastTriggeredAt: pending.effectiveAt, lastResult: "missed-declined", nextRunAt: null });
    this.#publish();
    return { declined: true };
  }

  #baseStatus(workflow, node, type) {
    return {
      workflowId: workflow.id,
      workflowName: workflow.name,
      projectId: workflow.projectId,
      nodeId: node.id,
      nodeName: node.name,
      type,
      status: "active",
      error: null,
      nextRunAt: null,
      url: null,
      lastTriggeredAt: null,
      lastRunId: null,
      lastResult: null
    };
  }

  #installSchedule(workflow, node, generation) {
    const key = statusKey(workflow.id, node.id);
    const status = this.#baseStatus(workflow, node, "schedule");
    this.statuses.set(key, status);
    let config;
    try {
      config = normalizeWorkflowNodeConfig(node);
      if (config.mode === "cron") workflowNextScheduleDate(config, this.now());
    } catch (error) {
      Object.assign(status, { status: "error", error: error.message });
      return;
    }

    const startupKey = `${workflow.id}:${node.id}`;
    if (config.runOnStartup && !this.startupFired.has(startupKey)) {
      this.startupFired.add(startupKey);
      const timer = this.setTimer(() => void this.#fireSchedule(workflow, node, config, generation, true), 0);
      timer.unref?.();
    }
    this.#scheduleNext(workflow, node, config, generation);
  }

  #scheduleNext(workflow, node, config, generation) {
    if (this.closed || generation !== this.generation) return;
    const key = statusKey(workflow.id, node.id);
    const status = this.statuses.get(key);
    if (!status) return;
    try {
      const next = workflowNextScheduleDate(config, this.now());
      status.nextRunAt = next.toISOString();
      const fullDelay = Math.max(1, next.getTime() - this.now().getTime());
      const timer = this.setTimer(() => {
        this.scheduleTimers.delete(key);
        if (fullDelay > MAX_TIMER_DELAY) this.#scheduleNext(workflow, node, config, generation);
        else void this.#fireSchedule(workflow, node, config, generation, false);
      }, Math.min(MAX_TIMER_DELAY, fullDelay));
      timer.unref?.();
      this.scheduleTimers.set(key, timer);
      this.#publish();
    } catch (error) {
      Object.assign(status, { status: "error", error: error.message, nextRunAt: null });
      this.#publish();
    }
  }

  async #fireSchedule(workflow, node, config, generation, startup) {
    if (this.closed || generation !== this.generation) return;
    const key = statusKey(workflow.id, node.id);
    this.scheduleTimers.delete(key);
    const status = this.statuses.get(key);
    if (!status) return;
    const triggeredAt = this.now().toISOString();
    status.lastTriggeredAt = triggeredAt;
    try {
      if (config.overlapPolicy === "skip" && this.workflows.isWorkflowActive(workflow.id)) {
        status.lastResult = "skipped-overlap";
      } else {
        const run = this.workflows.startRun({
          projectId: workflow.projectId,
          workflowId: workflow.id,
          triggerNodeId: node.id,
          input: {
            trigger: {
              type: "schedule",
              workflowId: workflow.id,
              nodeId: node.id,
              scheduledAt: triggeredAt,
              startup
            }
          }
        });
        status.lastRunId = run.id;
        status.lastResult = "started";
      }
      status.error = null;
      status.status = "active";
    } catch (error) {
      status.lastResult = "failed-to-start";
      status.error = error.message;
    } finally {
      if (!startup) this.#scheduleNext(workflow, node, config, generation);
      this.#publish();
    }
  }

  async #installWebhookServer(port, routes, generation) {
    const routeKeys = new Set();
    const validRoutes = [];
    for (const route of routes) {
      const key = statusKey(route.workflow.id, route.node.id);
      const status = this.#baseStatus(route.workflow, route.node, "webhook");
      status.url = `http://127.0.0.1:${port}${route.config.path}`;
      this.statuses.set(key, status);
      const routeKey = `${route.config.method}:${route.config.path}`;
      if (routeKeys.has(routeKey)) {
        Object.assign(status, { status: "error", error: `Another enabled webhook already uses ${route.config.method} ${route.config.path} on port ${port}` });
        const previous = validRoutes.find((candidate) => `${candidate.config.method}:${candidate.config.path}` === routeKey);
        if (previous) {
          const previousStatus = this.statuses.get(statusKey(previous.workflow.id, previous.node.id));
          Object.assign(previousStatus, { status: "error", error: status.error });
        }
        continue;
      }
      routeKeys.add(routeKey);
      validRoutes.push(route);
    }
    const activeRoutes = validRoutes.filter((route) => this.statuses.get(statusKey(route.workflow.id, route.node.id))?.status !== "error");
    if (!activeRoutes.length || this.closed || generation !== this.generation) return;

    const server = this.createServer((request, response) => {
      void this.#handleWebhookRequest(port, activeRoutes, request, response, generation)
        .catch((error) => {
          if (!response.headersSent) sendJson(response, error.statusCode ?? 500, { error: error.message });
          else response.destroy(error);
        });
    });
    server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "127.0.0.1");
      });
      if (this.closed || generation !== this.generation) {
        await new Promise((resolve) => server.close(() => resolve()));
        return;
      }
      this.servers.set(port, server);
    } catch (error) {
      for (const route of activeRoutes) {
        const status = this.statuses.get(statusKey(route.workflow.id, route.node.id));
        Object.assign(status, { status: "error", error: `Local webhook server could not listen on 127.0.0.1:${port}: ${error.message}` });
      }
    }
  }

  async #handleWebhookRequest(port, routes, request, response, generation) {
    if (this.closed || generation !== this.generation) return sendJson(response, 503, { error: "Webhook trigger is reloading" });
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    const method = String(request.method ?? "GET").toUpperCase();
    const route = routes.find((candidate) => candidate.config.method === method && candidate.config.path === url.pathname);
    if (!route) return sendJson(response, 404, { error: "No enabled Pixice webhook matches this method and path" });
    const status = this.statuses.get(statusKey(route.workflow.id, route.node.id));

    if (route.config.authCredentialId) {
      let credential;
      try {
        await this.prepareCredentials();
        credential = this.credentialStore.resolve(route.workflow.projectId, route.config.authCredentialId);
      } catch (error) {
        Object.assign(status, { status: "error", error: error.message });
        this.#publish();
        return sendJson(response, 503, { error: "Webhook authentication credential is unavailable" });
      }
      if (!workflowCredentialAuthorizesRequest(credential, { url, headers: request.headers })) {
        response.setHeader("www-authenticate", credential.type === "basic" ? "Basic realm=\"Pixice workflow\"" : "Bearer");
        return sendJson(response, 401, { error: "Webhook authentication failed" });
      }
    }

    const body = await readRequestBody(request, route.config.maxBytes);
    const receivedAt = this.now().toISOString();
    const runInput = {
      trigger: {
        type: "webhook",
        workflowId: route.workflow.id,
        nodeId: route.node.id,
        receivedAt
      },
      request: {
        method,
        url: url.toString(),
        path: url.pathname,
        query: queryObject(url.searchParams),
        headers: Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name, Array.isArray(value) ? value : String(value ?? "")])),
        body,
        remoteAddress: request.socket.remoteAddress ?? null
      }
    };
    const run = this.workflows.startRun({
      projectId: route.workflow.projectId,
      workflowId: route.workflow.id,
      triggerNodeId: route.node.id,
      input: runInput
    });
    Object.assign(status, { lastTriggeredAt: receivedAt, lastRunId: run.id, lastResult: "started", error: null, status: "active" });
    this.#publish();

    if (route.config.responseMode === "immediate") return sendJson(response, 202, { accepted: true, runId: run.id });
    const completed = await promiseWithTimeout(this.workflows.waitForRun(run.id), route.config.timeoutMs);
    if (!completed) return sendJson(response, 202, { accepted: true, runId: run.id, status: "running" });
    if (completed.status === "completed") return sendJson(response, 200, completed.output);
    return sendJson(response, 500, { runId: completed.id, status: completed.status, error: completed.error ?? "Workflow did not complete" });
  }

  async #closeServers() {
    const servers = [...this.servers.values()];
    this.servers.clear();
    await Promise.allSettled(servers.map((server) => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    })));
  }

  #publish() {
    this.onChange?.({ statuses: this.list() });
  }
}
