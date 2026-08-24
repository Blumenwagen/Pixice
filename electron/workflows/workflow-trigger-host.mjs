import http from "node:http";
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
    credentialStore,
    onChange,
    createServer = http.createServer,
    now = () => new Date(),
    setTimer = setTimeout,
    clearTimer = clearTimeout
  }) {
    this.store = store;
    this.workflows = workflows;
    this.credentialStore = credentialStore;
    this.onChange = onChange;
    this.createServer = createServer;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.scheduleTimers = new Map();
    this.servers = new Map();
    this.statuses = new Map();
    this.startupFired = new Set();
    this.generation = 0;
    this.refreshPromise = Promise.resolve();
    this.closed = false;
  }

  start() {
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
    await this.#closeServers();
    this.statuses.clear();
  }

  async #refresh() {
    if (this.closed) return;
    const generation = ++this.generation;
    for (const timer of this.scheduleTimers.values()) this.clearTimer(timer);
    this.scheduleTimers.clear();
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
    await Promise.all([...webhookGroups].map(([port, routes]) => this.#installWebhookServer(port, routes, generation)));
    this.#publish();
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
      const delay = Math.max(1, Math.min(MAX_TIMER_DELAY, next.getTime() - this.now().getTime()));
      const timer = this.setTimer(() => void this.#fireSchedule(workflow, node, config, generation, false), delay);
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
