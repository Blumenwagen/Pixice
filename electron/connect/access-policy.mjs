const MAX_PROJECT_IDS = 100;
const MAX_PROJECT_ID_LENGTH = 256;

export const CONNECT_ROLES = Object.freeze({ operator: "operator", observer: "observer" });

// This is deliberately smaller than READ_OPERATIONS. An observer can inspect
// selected project state, but cannot inspect browser, provider, account, usage,
// proactivity, Instrument, Workflow, or directory state.
export const OBSERVER_OPERATIONS = new Set([
  "app.bootstrap", "app.overview", "runtime.status", "models.list", "projects.list",
  "threads.list", "threads.read", "tasks.receipts", "tasks.receipt", "tasks.interventions",
  "files.read", "files.preview", "review.read", "review.file",
  "board.list", "board.read", "board.activity"
]);

export const OBSERVER_SCOPED_OPERATIONS = new Set([
  "threads.list", "threads.read", "tasks.receipt", "files.read", "files.preview",
  "review.read", "review.file", "board.list", "board.read", "board.activity"
]);

const OBSERVER_EVENT_TYPES = new Set([
  "TaskUpdated", "ActivityReceived", "RuntimeEvent", "RuntimeStatus", "AgentUpdated", "AttentionRequired",
  "AttentionResolved", "AttentionReset", "TaskReceiptUpdated", "BoardUpdated", "ProjectDeleted"
]);

const NORMALIZED_RUNTIME_EVENT_TYPES = new Set(["TaskUpdated", "ActivityReceived", "AgentUpdated", "RuntimeEvent"]);

const SAFE_RUNTIME_METHODS = new Set([
  "thread/started", "thread/name/updated", "thread/slash-commands/updated", "thread/status/changed", "thread/deleted", "thread/archived",
  "turn/started", "turn/completed", "turn/plan/updated", "item/started", "item/completed",
  "item/agentMessage/delta", "item/agentMessage/updated"
]);

const SETTINGS_KEYS = new Set([
  "defaultModel", "defaultEffort", "defaultPermissionMode", "defaultFastMode",
  "attentionNotifications", "completionNotifications", "notificationSound", "keepSystemAwake",
  "checkProviderUpdates", "accentColor", "reduceTransparency"
]);

function invalid(message) {
  throw Object.assign(new Error(message), { code: "INVALID_ACCESS_POLICY", status: 400 });
}

function projectIds(value, { requireNonEmpty = false } = {}) {
  if (!Array.isArray(value) || value.length > MAX_PROJECT_IDS || (requireNonEmpty && value.length === 0)) {
    invalid("Observer access requires a bounded, non-empty project list.");
  }
  const result = [];
  const seen = new Set();
  for (const candidate of value) {
    if (typeof candidate !== "string") invalid("Observer project IDs must be strings.");
    const id = candidate.trim();
    if (!id || id.length > MAX_PROJECT_ID_LENGTH || seen.has(id)) invalid("Observer project IDs must be unique, bounded, and non-empty.");
    seen.add(id);
    result.push(id);
  }
  return result;
}

export function normalizePairingAccess(value = {}, { knownProjectIds = [] } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Pairing access is invalid.");
  const role = value.role ?? CONNECT_ROLES.operator;
  if (role === CONNECT_ROLES.operator) {
    if (value.projectIds !== undefined && value.projectIds !== null) invalid("Operator access cannot include project scope.");
    return { role, projectIds: null };
  }
  if (role !== CONNECT_ROLES.observer) invalid("The requested Connect role is not supported.");
  const ids = projectIds(value.projectIds, { requireNonEmpty: true });
  const known = new Set(knownProjectIds);
  if (!ids.every((id) => known.has(id))) invalid("Observer access may include only known project IDs.");
  return { role, projectIds: ids };
}

export function persistedDeviceAccess(device) {
  if (!device || typeof device !== "object" || Array.isArray(device)) return null;
  const role = device.role ?? CONNECT_ROLES.operator;
  if (role === CONNECT_ROLES.operator) {
    if (device.projectIds !== undefined && device.projectIds !== null) return null;
    return { role, projectIds: null };
  }
  if (role !== CONNECT_ROLES.observer) return null;
  try { return { role, projectIds: projectIds(device.projectIds, { requireNonEmpty: true }) }; }
  catch { return null; }
}

export function statusAccess(device) {
  const access = persistedDeviceAccess(device);
  return access ?? { role: null, projectIds: null };
}

export function canAccessProject(access, projectId) {
  if (!access) return false;
  if (access.role === CONNECT_ROLES.operator) return true;
  return typeof projectId === "string" && access.projectIds.includes(projectId);
}

export function isObserver(access) {
  return access?.role === CONNECT_ROLES.observer;
}

export function operationAllowed(access, operation, operatorAllowed) {
  if (isObserver(access)) return OBSERVER_OPERATIONS.has(operation);
  return operatorAllowed(operation);
}

export function operationNeedsProject(operation) {
  return OBSERVER_SCOPED_OPERATIONS.has(operation);
}

function minimalProject(project) {
  if (!project || typeof project !== "object") return null;
  return { id: project.id, displayName: project.displayName, canonicalPath: project.canonicalPath };
}

function minimalRuntime(runtime) {
  if (!runtime || typeof runtime !== "object") return { state: "unknown", connected: false };
  return { state: runtime.state ?? "unknown", connected: runtime.connected === true };
}

function minimalRuntimeStatus(value) {
  if (typeof value === "string") return value.slice(0, 80);
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return typeof value.type === "string" ? { type: value.type.slice(0, 80) } : undefined;
}

function minimalRuntimeItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  if (item.receiverThreadIds?.length || item.agentsStates || item.senderThreadId
    || item.type === "collabAgentToolCall" || item.type === "collabToolCall") return null;
  const result = {};
  for (const key of ["id", "type", "status", "phase", "startedAt", "completedAt", "createdAt"]) {
    if (typeof item[key] === "string") result[key] = item[key].slice(0, 240);
  }
  if (typeof item.text === "string") result.text = item.text.slice(0, 100_000);
  if (typeof item.delta === "string") result.delta = item.delta.slice(0, 100_000);
  if (typeof item.summary === "string") result.summary = item.summary.slice(0, 10_000);
  return Object.keys(result).length ? result : null;
}

function minimalRuntimeThread(thread) {
  if (!thread || typeof thread !== "object" || Array.isArray(thread)) return undefined;
  const result = {};
  for (const key of ["id", "name", "createdAt", "updatedAt"]) {
    if (typeof thread[key] === "string") result[key] = thread[key].slice(0, 240);
  }
  const status = minimalRuntimeStatus(thread.status);
  if (status !== undefined) result.status = status;
  return Object.keys(result).length ? result : undefined;
}

function minimalRuntimeTurn(turn) {
  if (!turn || typeof turn !== "object" || Array.isArray(turn)) return undefined;
  const result = {};
  for (const key of ["id", "status", "startedAt", "completedAt"]) {
    if (typeof turn[key] === "string") result[key] = turn[key].slice(0, 240);
  }
  return Object.keys(result).length ? result : undefined;
}

function minimalRuntimePlan(plan) {
  if (!Array.isArray(plan)) return undefined;
  return plan.slice(0, 100).map((step) => {
    if (!step || typeof step !== "object" || Array.isArray(step)) return null;
    const result = {};
    for (const key of ["step", "title", "status"]) {
      if (typeof step[key] === "string") result[key] = step[key].slice(0, 1_000);
    }
    return Object.keys(result).length ? result : null;
  }).filter(Boolean);
}

function minimalRuntimeEventPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const method = payload.method;
  if (typeof method !== "string" || method.startsWith("account/") || !SAFE_RUNTIME_METHODS.has(method)) return null;
  if (method.includes("collab") || payload.receiverThreadIds?.length || payload.agentsStates
    || payload.senderThreadId || payload.item?.receiverThreadIds?.length || payload.item?.agentsStates
    || payload.item?.senderThreadId || payload.item?.type === "collabAgentToolCall" || payload.item?.type === "collabToolCall") return null;
  const result = { method: method.slice(0, 120) };
  for (const key of ["threadId", "turnId", "itemId", "requestId"]) {
    if (typeof payload[key] === "string") result[key] = payload[key].slice(0, 256);
  }
  if (typeof payload.receivedAt === "string") result.receivedAt = payload.receivedAt.slice(0, 80);
  if (typeof payload.name === "string") result.name = payload.name.slice(0, 240);
  if (method === "thread/slash-commands/updated" && Array.isArray(payload.slashCommands)) {
    result.slashCommands = payload.slashCommands.slice(0, 100).flatMap((command) => {
      if (!command || typeof command.name !== "string" || !/^[\w][\w:.-]{0,79}$/.test(command.name)) return [];
      return [{ name: command.name, description: String(command.description ?? "").slice(0, 180) }];
    });
  }
  if (typeof payload.delta === "string") result.delta = payload.delta.slice(0, 100_000);
  const status = minimalRuntimeStatus(payload.status);
  if (status !== undefined) result.status = status;
  const thread = minimalRuntimeThread(payload.thread);
  if (thread) result.thread = thread;
  const turn = minimalRuntimeTurn(payload.turn);
  if (turn) result.turn = turn;
  const item = minimalRuntimeItem(payload.item);
  if (payload.item !== undefined && !item) return null;
  if (item) result.item = item;
  const plan = minimalRuntimePlan(payload.plan);
  if (payload.plan !== undefined && !plan) return null;
  if (plan) result.plan = plan;
  return result;
}

function minimalModel(model) {
  if (!model || typeof model !== "object") return model;
  const result = {};
  for (const key of ["id", "model", "name", "provider", "reasoningEfforts", "supportedReasoningEfforts", "serviceTiers", "additionalSpeedTiers"]) {
    if (model[key] !== undefined) result[key] = model[key];
  }
  return result;
}

export function filterObserverResult(operation, result, access) {
  if (!isObserver(access)) return result;
  const allowed = new Set(access.projectIds);
  if (operation === "projects.list") {
    return (Array.isArray(result) ? result : []).filter((project) => allowed.has(project?.id)).map(minimalProject);
  }
  if (operation === "app.bootstrap") {
    const projects = (Array.isArray(result?.projects) ? result.projects : []).filter((project) => allowed.has(project?.id)).map(minimalProject);
    const settings = Object.fromEntries(Object.entries(result?.settings ?? {}).filter(([key]) => SETTINGS_KEYS.has(key)));
    return {
      projects,
      models: (Array.isArray(result?.models) ? result.models : []).map(minimalModel),
      runtime: minimalRuntime(result?.runtime),
      settings
    };
  }
  if (operation === "app.overview") {
    return {
      projects: (Array.isArray(result?.projects) ? result.projects : []).filter((project) => allowed.has(project?.id)).map(minimalProject),
      tasks: (Array.isArray(result?.tasks) ? result.tasks : []).filter((task) => allowed.has(task?.projectId)).map((task) => ({
        threadId: task.threadId, projectId: task.projectId, title: task.title, status: task.status, updatedAt: task.updatedAt
      })),
      checkedAt: result?.checkedAt
    };
  }
  if (operation === "runtime.status") return minimalRuntime(result);
  if (operation === "models.list") return (Array.isArray(result) ? result : []).map(minimalModel);
  if (operation === "tasks.receipts") {
    return (Array.isArray(result) ? result : []).filter((receipt) => allowed.has(receipt?.projectId));
  }
  if (operation === "tasks.receipt") {
    return result && allowed.has(result.projectId) ? result : null;
  }
  if (operation === "tasks.interventions") {
    return {
      ...(result ?? {}),
      requests: (Array.isArray(result?.requests) ? result.requests : [])
        .filter((request) => allowed.has(request?.projectId))
        .map((request) => Object.fromEntries(Object.entries(request).filter(([key]) => ["id", "requestId", "threadId", "method", "taskTitle", "requestGeneration", "projectId"].includes(key))))
    };
  }
  return result;
}

function cursorEnvelope(event) {
  return { type: "ConnectCursor", payload: {}, instanceId: event.instanceId, sequence: event.sequence, protocol: event.protocol };
}

function minimalAttention(payload, resolveProject) {
  const threadId = payload?.threadId ?? payload?.params?.threadId;
  const projectId = resolveProject({ type: "AttentionRequired", payload: { ...payload, ...(threadId ? { threadId } : {}) } });
  if (!projectId) return null;
  return {
    ...(payload?.id !== undefined ? { id: payload.id } : {}),
    ...(payload?.requestId !== undefined ? { requestId: payload.requestId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(typeof payload?.method === "string" ? { method: payload.method.slice(0, 120) } : {}),
    ...(payload?.taskTitle ? { taskTitle: String(payload.taskTitle).slice(0, 240) } : {}),
    ...(payload?.requestGeneration !== undefined ? { requestGeneration: payload.requestGeneration } : {}),
    projectId
  };
}

export function filterAttention(attention, access, resolveProject) {
  if (!isObserver(access)) return Array.isArray(attention) ? attention : [];
  return (Array.isArray(attention) ? attention : []).map((payload) => minimalAttention(payload, resolveProject)).filter(Boolean)
    .filter((payload) => canAccessProject(access, payload.projectId));
}

export function filterObserverReadiness(readiness) {
  const providerConnected = readiness?.provider?.connected === true;
  const browserAvailable = readiness?.browser?.available === true;
  const result = {
    provider: { connected: providerConnected, reason: providerConnected ? null : "Provider is unavailable." },
    browser: { available: browserAvailable, reason: browserAvailable ? null : "Browser is unavailable." }
  };
  if (Object.prototype.hasOwnProperty.call(readiness?.browser ?? {}, "canStart")) result.browser.canStart = readiness.browser.canStart === true;
  return result;
}

export function filterObserverEvent(event, access, resolveProject = () => null) {
  if (!isObserver(access)) return event;
  if (!event || !OBSERVER_EVENT_TYPES.has(event.type)) return null;
  if (event.type === "AttentionReset") {
    return { ...event, payload: { attention: filterAttention(event.payload?.attention, access, resolveProject) } };
  }
  if (event.type === "RuntimeStatus") return { ...event, payload: minimalRuntime(event.payload) };
  if (NORMALIZED_RUNTIME_EVENT_TYPES.has(event.type)) {
    const payload = minimalRuntimeEventPayload(event.payload);
    if (!payload) return null;
    const projectId = resolveProject({ ...event, payload: { ...event.payload, ...payload } });
    if (!projectId || !canAccessProject(access, projectId)) return null;
    return { ...event, payload: { ...payload, projectId } };
  }
  if (event.type === "AttentionRequired") {
    const payload = minimalAttention(event.payload, resolveProject);
    return payload && canAccessProject(access, payload.projectId) ? { ...event, payload } : null;
  }
  if (event.type === "AttentionResolved") {
    const projectId = resolveProject(event);
    return projectId && canAccessProject(access, projectId)
      ? { ...event, payload: { ...(event.payload?.requestId !== undefined ? { requestId: event.payload.requestId } : {}), ...(event.payload?.threadId ? { threadId: event.payload.threadId } : {}), projectId } }
      : null;
  }
  const projectId = resolveProject(event);
  if (!projectId || !canAccessProject(access, projectId)) return null;
  if (event.type === "ProjectDeleted") return { ...event, payload: { projectId } };
  return { ...event, payload: { ...(event.payload ?? {}), projectId } };
}

export function filterEventOrCursor(event, access, resolveProject) {
  return filterObserverEvent(event, access, resolveProject) ?? cursorEnvelope(event);
}
