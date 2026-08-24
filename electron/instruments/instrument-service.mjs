import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  MAX_INSTRUMENT_EVENT_BYTES,
  MAX_INSTRUMENT_SOURCE_BYTES,
  MAX_THREAD_INSTRUMENTS,
  instrumentContractSummary,
  instrumentDocumentSchema,
  normalizeInstrumentDocument
} from "./instrument-model.mjs";
import { InstrumentStore } from "./instrument-store.mjs";

export const LOOM_INSTRUMENTS_NAMESPACE = "loom_instruments";

const identifier = z.string().trim().min(1).max(160);
const documentShape = z.record(z.unknown());

export const instrumentToolShapes = {
  describe_contract: {},
  create_instrument: { document: documentShape },
  inspect_instrument: { instrumentId: identifier },
  update_instrument: { instrumentId: identifier, expectedVersion: z.number().int().positive(), document: documentShape },
  refresh_instrument: { instrumentId: identifier, source: identifier.optional() },
  open_instrument: { instrumentId: identifier },
  list_instruments: {},
  delete_instrument: { instrumentId: identifier }
};

export const LOOM_INSTRUMENTS_MCP_TOOLS = new Set(Object.keys(instrumentToolShapes).map((name) => `mcp__${LOOM_INSTRUMENTS_NAMESPACE}__${name}`));

const documentJsonSchema = {
  type: "object",
  description: "A strict InstrumentDocumentV1. Call describe_contract before creating an Instrument.",
  additionalProperties: true
};

const toolDefinitions = [
  { name: "describe_contract", description: "Describe Pixice's native Instrument document, primitives, actions, bindings, and limits.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "create_instrument", description: "Create a thread-scoped native Instrument and open it in this thread's Preview.", inputSchema: { type: "object", properties: { document: documentJsonSchema }, required: ["document"], additionalProperties: false } },
  { name: "inspect_instrument", description: "Read an Instrument's current document and version before updating it.", inputSchema: { type: "object", properties: { instrumentId: { type: "string", minLength: 1, maxLength: 160 } }, required: ["instrumentId"], additionalProperties: false } },
  { name: "update_instrument", description: "Replace an Instrument document using optimistic concurrency and keep the existing Preview tab live.", inputSchema: { type: "object", properties: { instrumentId: { type: "string", minLength: 1, maxLength: 160 }, expectedVersion: { type: "integer", minimum: 1 }, document: documentJsonSchema }, required: ["instrumentId", "expectedVersion", "document"], additionalProperties: false } },
  { name: "refresh_instrument", description: "Refresh all or one of an Instrument's bounded read-only live data sources.", inputSchema: { type: "object", properties: { instrumentId: { type: "string", minLength: 1, maxLength: 160 }, source: { type: "string", minLength: 1, maxLength: 160 } }, required: ["instrumentId"], additionalProperties: false } },
  { name: "open_instrument", description: "Open an existing Instrument in this thread's Preview.", inputSchema: { type: "object", properties: { instrumentId: { type: "string", minLength: 1, maxLength: 160 } }, required: ["instrumentId"], additionalProperties: false } },
  { name: "list_instruments", description: "List Instruments created in the active thread.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "delete_instrument", description: "Delete an ephemeral Instrument created in the active thread.", inputSchema: { type: "object", properties: { instrumentId: { type: "string", minLength: 1, maxLength: 160 } }, required: ["instrumentId"], additionalProperties: false } }
];

export const instrumentDynamicTools = [{
  type: "namespace",
  name: LOOM_INSTRUMENTS_NAMESPACE,
  description: "Create native, interactive Pixice Instruments for problems that benefit from direct manipulation. Instruments are strict JSON rendered by Pixice, not executable HTML or scripts.",
  tools: toolDefinitions.map((definition) => ({ type: "function", ...definition }))
}];

const schemas = Object.fromEntries(Object.entries(instrumentToolShapes).map(([name, shape]) => [name, z.object(shape).strict()]));

function textResult(value, success = true) {
  return { success, contentItems: [{ type: "inputText", text: JSON.stringify(value, null, 2) }] };
}

function publicInstrument(instrument) {
  const requestedCapabilities = [...new Set(Object.values(instrument.document.actions)
    .filter((action) => action.type === "invokeCapability")
    .map((action) => action.capability))].sort();
  return {
    id: instrument.id,
    projectId: instrument.projectId,
    threadId: instrument.threadId,
    lifecycle: instrument.lifecycle,
    documentVersion: instrument.documentVersion,
    document: instrument.document,
    status: instrument.status,
    metadata: instrument.metadata ?? {},
    grants: instrument.grants ?? [],
    requestedCapabilities,
    usageCount: instrument.usageCount ?? 0,
    lastError: instrument.lastError ?? null,
    createdAt: instrument.createdAt,
    updatedAt: instrument.updatedAt,
    lastOpenedAt: instrument.lastOpenedAt
  };
}

export class InstrumentService {
  constructor({ userDataPath, threadContext, readCapability, onAgentEvent, resolveCapability, confirmCapability, invokeCapability, onChange, onOpen, onEventChange }) {
    this.store = new InstrumentStore(userDataPath);
    this.threadContext = threadContext;
    this.readCapability = readCapability;
    this.onAgentEvent = onAgentEvent;
    this.resolveCapability = resolveCapability;
    this.confirmCapability = confirmCapability;
    this.invokeCapability = invokeCapability;
    this.onChange = onChange;
    this.onOpen = onOpen;
    this.onEventChange = onEventChange;
    this.pendingActions = new Set();
  }

  close() {
    this.store.close();
  }

  list(projectId, threadId) {
    return this.store.list(projectId, { threadId, includePinned: Boolean(threadId) }).map(publicInstrument);
  }

  listTools(projectId) {
    return this.store.listPinned(projectId).map(publicInstrument);
  }

  read(projectId, instrumentId) {
    return publicInstrument(this.#instrument(projectId, instrumentId));
  }

  async open(projectId, instrumentId, workspaceId) {
    const current = this.#instrument(projectId, instrumentId);
    this.#assertAccess(current, workspaceId ?? current.threadId);
    const instrument = publicInstrument(this.store.open(current.id));
    this.onOpen?.({ projectId, threadId: workspaceId ?? instrument.threadId, workspaceId: workspaceId ?? instrument.threadId, instrument });
    return instrument;
  }

  async refresh(projectId, instrumentId, source, targetThreadId) {
    const current = this.#instrument(projectId, instrumentId);
    this.#assertAccess(current, targetThreadId ?? current.threadId);
    const names = source ? [source] : Object.keys(current.document.sources);
    if (source && !current.document.sources[source]) throw new Error(`Unknown Instrument source: ${source}`);
    if (!names.length) return publicInstrument(current);
    const instrument = publicInstrument(await this.#refresh(current, names));
    this.onChange?.({ action: "refreshed", projectId, threadId: targetThreadId ?? instrument.threadId, instrument });
    return instrument;
  }

  setPinned(projectId, instrumentId, pinned, targetThreadId) {
    const current = this.#instrument(projectId, instrumentId);
    this.#assertAccess(current, targetThreadId);
    let changed = this.store.setLifecycle(current.id, pinned ? "pinned" : "ephemeral", targetThreadId ?? current.threadId);
    const requested = publicInstrument(changed).requestedCapabilities;
    changed = this.store.setGrants(changed.id, pinned ? (current.lifecycle === "pinned" ? changed.grants : requested) : []);
    const instrument = publicInstrument(changed);
    this.onChange?.({ action: pinned ? "pinned" : "unpinned", projectId, threadId: targetThreadId ?? instrument.threadId, instrument });
    return instrument;
  }

  renameTool(projectId, instrumentId, name, targetThreadId) {
    const current = this.#pinnedInstrument(projectId, instrumentId, targetThreadId);
    const normalized = String(name ?? "").trim();
    if (!normalized || normalized.length > 160) throw new Error("Project tool name must be between 1 and 160 characters");
    const instrument = publicInstrument(this.store.setMetadata(current.id, { name: normalized }));
    this.onChange?.({ action: "renamed", projectId, threadId: targetThreadId, instrument });
    return instrument;
  }

  setGrants(projectId, instrumentId, grants, targetThreadId) {
    const current = this.#pinnedInstrument(projectId, instrumentId, targetThreadId);
    const requested = new Set(publicInstrument(current).requestedCapabilities);
    const normalized = [...new Set(grants ?? [])];
    if (normalized.some((capability) => !requested.has(capability))) throw new Error("A tool can only grant capabilities declared by its document");
    const instrument = publicInstrument(this.store.setGrants(current.id, normalized));
    this.onChange?.({ action: "grants", projectId, threadId: targetThreadId, instrument });
    return instrument;
  }

  duplicateTool(projectId, instrumentId, targetThreadId) {
    const current = this.#pinnedInstrument(projectId, instrumentId, targetThreadId);
    const currentName = current.metadata?.name || current.document.title;
    const instrument = publicInstrument(this.store.create({
      id: randomUUID(),
      projectId,
      threadId: targetThreadId,
      document: current.document,
      lifecycle: "pinned",
      metadata: { ...current.metadata, name: `${currentName} copy`.slice(0, 160) },
      grants: current.grants
    }));
    this.onChange?.({ action: "created", projectId, threadId: targetThreadId, instrument });
    return instrument;
  }

  deleteTool(projectId, instrumentId, targetThreadId) {
    const current = this.#pinnedInstrument(projectId, instrumentId, targetThreadId);
    const instrument = publicInstrument(this.store.delete(current.id));
    this.onChange?.({ action: "deleted", projectId, threadId: targetThreadId, instrument });
    return instrument;
  }

  listRevisions(projectId, instrumentId) {
    this.#instrument(projectId, instrumentId);
    return this.store.listRevisions(instrumentId);
  }

  restoreRevision(projectId, instrumentId, version, targetThreadId) {
    const current = this.#pinnedInstrument(projectId, instrumentId, targetThreadId);
    const instrument = publicInstrument(this.store.restoreRevision(current.id, version));
    this.onChange?.({ action: "restored", projectId, threadId: targetThreadId, instrument });
    return instrument;
  }

  async launch(projectId, instrumentId, values, targetThreadId) {
    const current = this.#pinnedInstrument(projectId, instrumentId, targetThreadId);
    const launchValues = this.#launchValues(current.document.parameters, values);
    const instrument = { ...publicInstrument(this.store.open(current.id)), launchValues };
    this.onOpen?.({ projectId, threadId: targetThreadId, workspaceId: targetThreadId, instrument });
    return instrument;
  }

  listEvents(projectId, instrumentId) {
    const current = this.#instrument(projectId, instrumentId);
    return this.store.listEvents(current.id);
  }

  listReceipts(projectId, instrumentId) {
    const current = this.#instrument(projectId, instrumentId);
    return this.store.listReceipts(current.id);
  }

  async dispatchAgentEvent(projectId, instrumentId, actionId, payload, runtimeOptions = {}, targetThreadId) {
    const instrument = this.#instrument(projectId, instrumentId);
    const deliveryThreadId = this.#assertAccess(instrument, targetThreadId ?? instrument.threadId);
    const action = instrument.document.actions[actionId];
    if (!action || action.type !== "sendAgentEvent") throw new Error("Instrument action cannot send an agent event");
    let encoded;
    try {
      encoded = JSON.stringify(payload ?? {});
    } catch {
      throw new Error("Instrument event payload must be JSON-compatible");
    }
    if (typeof encoded !== "string") throw new Error("Instrument event payload must be JSON-compatible");
    if (Buffer.byteLength(encoded, "utf8") > MAX_INSTRUMENT_EVENT_BYTES) throw new Error(`Instrument event payload exceeds ${MAX_INSTRUMENT_EVENT_BYTES} bytes`);
    const event = this.store.createEvent({
      id: randomUUID(),
      instrumentId: instrument.id,
      threadId: deliveryThreadId,
      event: action.event,
      payload: JSON.parse(encoded)
    });
    this.onEventChange?.({ action: "sending", projectId, threadId: deliveryThreadId, instrumentId, event });
    try {
      if (!this.onAgentEvent) throw new Error("Instrument agent events are unavailable");
      const delivery = await this.onAgentEvent({ instrument: { ...publicInstrument(instrument), threadId: deliveryThreadId }, event, runtimeOptions });
      const sent = this.store.updateEvent(event.id, { status: "sent", turnId: delivery?.turn?.id ?? delivery?.turnId ?? null });
      this.onEventChange?.({ action: "sent", projectId, threadId: deliveryThreadId, instrumentId, event: sent });
      return sent;
    } catch (error) {
      const failed = this.store.updateEvent(event.id, { status: "failed", error: error.message });
      this.onEventChange?.({ action: "failed", projectId, threadId: deliveryThreadId, instrumentId, event: failed });
      throw error;
    }
  }

  async dispatchCapability(projectId, instrumentId, actionId, payload, targetThreadId, requestId = randomUUID()) {
    const instrument = this.#instrument(projectId, instrumentId);
    const deliveryThreadId = this.#assertAccess(instrument, targetThreadId ?? instrument.threadId);
    const action = instrument.document.actions[actionId];
    if (!action || action.type !== "invokeCapability") throw new Error("Instrument action cannot invoke a trusted capability");
    if (!this.invokeCapability) throw new Error("Trusted Instrument actions are unavailable");
    if (!this.confirmCapability) throw new Error("Trusted Instrument confirmation is unavailable");
    if (instrument.lifecycle === "pinned" && !instrument.grants.includes(action.capability)) throw new Error(`Project tool is not granted ${action.capability}`);
    const encoded = JSON.stringify(payload ?? {});
    if (typeof encoded !== "string" || Buffer.byteLength(encoded, "utf8") > MAX_INSTRUMENT_EVENT_BYTES) throw new Error("Trusted action arguments are invalid or too large");
    const argumentsValue = JSON.parse(encoded);
    const argumentsHash = createHash("sha256").update(`${instrument.id}\n${actionId}\n${encoded}`).digest("hex");
    const existing = this.store.getReceipt(requestId);
    if (existing) {
      if (existing.instrumentId !== instrument.id || existing.argumentsHash !== argumentsHash) throw new Error("Trusted action request ID was reused with different arguments");
      if (existing.status === "sent") return { duplicate: true, receipt: existing, result: existing.result };
      if (existing.status === "failed") throw new Error(existing.error || "Trusted action previously failed");
      throw new Error("Trusted action is already running");
    }
    if (this.pendingActions.has(requestId)) throw new Error("Trusted action is already awaiting confirmation");
    this.pendingActions.add(requestId);
    try {
      const resolution = this.resolveCapability
        ? await this.resolveCapability({ projectId, threadId: deliveryThreadId, capability: action.capability, arguments: argumentsValue })
        : { summary: action.confirmation, targetVersion: null, arguments: argumentsValue };
      const confirmed = await this.confirmCapability({ instrument: publicInstrument(instrument), action, resolution, threadId: deliveryThreadId });
      if (!confirmed) return { cancelled: true, receipt: null, result: null };
      const receipt = this.store.createReceipt({
        requestId,
        instrumentId: instrument.id,
        threadId: deliveryThreadId,
        actionId,
        capability: action.capability,
        argumentsHash,
        targetVersion: resolution.targetVersion ?? null,
        effectSummary: resolution.summary
      });
      this.onEventChange?.({ action: "sending", projectId, threadId: deliveryThreadId, instrumentId, receipt });
      const result = await this.invokeCapability({ projectId, threadId: deliveryThreadId, capability: action.capability, arguments: resolution.arguments ?? argumentsValue, resolution });
      const sent = this.store.updateReceipt(requestId, { status: "sent", result });
      this.store.setLastError(instrument.id, null);
      this.onEventChange?.({ action: "sent", projectId, threadId: deliveryThreadId, instrumentId, receipt: sent });
      return { receipt: sent, result };
    } catch (error) {
      const receipt = this.store.getReceipt(requestId);
      if (receipt) {
        const failed = this.store.updateReceipt(requestId, { status: "failed", error: error.message });
        this.onEventChange?.({ action: "failed", projectId, threadId: deliveryThreadId, instrumentId, receipt: failed });
      }
      this.store.setLastError(instrument.id, error.message);
      throw error;
    } finally {
      this.pendingActions.delete(requestId);
    }
  }

  delete(projectId, instrumentId) {
    const current = this.#instrument(projectId, instrumentId);
    if (current.lifecycle !== "ephemeral") throw new Error("Pinned Instruments must be unpinned before deletion");
    const instrument = publicInstrument(this.store.delete(current.id));
    this.onChange?.({ action: "deleted", projectId, threadId: instrument.threadId, instrument });
    return instrument;
  }

  removeEphemeralForThread(threadId) {
    const instruments = this.store.deleteEphemeralForThread(threadId).map(publicInstrument);
    for (const instrument of instruments) {
      this.onChange?.({ action: "deleted", projectId: instrument.projectId, threadId, instrument });
    }
    return instruments;
  }

  async handleToolCall(params) {
    try {
      if (!params?.threadId) throw new Error("Pixice Instrument tools require an active thread");
      const context = this.threadContext(params.threadId);
      if (!context?.projectId) throw new Error("The active thread is not attached to an open Pixice project");
      const schema = schemas[params.tool];
      if (!schema) throw new Error(`Unknown Pixice Instrument tool: ${params.tool}`);
      const input = schema.parse(params.arguments ?? {});
      if (params.tool === "describe_contract") return textResult(instrumentContractSummary());
      if (params.tool === "list_instruments") return textResult({ instruments: this.list(context.projectId, params.threadId) });
      if (params.tool === "create_instrument") {
        if (this.store.list(context.projectId, { threadId: params.threadId, includePinned: false }).length >= MAX_THREAD_INSTRUMENTS) {
          throw new Error(`This thread already has the limit of ${MAX_THREAD_INSTRUMENTS} Instruments. Update or delete one instead.`);
        }
        const document = await this.#hydrate(context.projectId, params.threadId, input.document);
        const instrument = publicInstrument(this.store.create({
          id: randomUUID(),
          projectId: context.projectId,
          threadId: params.threadId,
          document
        }));
        this.onChange?.({ action: "created", projectId: context.projectId, threadId: params.threadId, instrument });
        this.onOpen?.({ projectId: context.projectId, threadId: params.threadId, workspaceId: params.threadId, instrument });
        return textResult({ instrument });
      }
      const current = this.#accessibleInstrument(context.projectId, params.threadId, input.instrumentId);
      if (params.tool === "inspect_instrument") return textResult({ instrument: publicInstrument(current), events: this.store.listEvents(current.id, 20) });
      if (params.tool === "update_instrument") {
        if (current.lifecycle === "pinned") throw new Error("Pinned Instruments must be unpinned by the user before an agent can update them");
        if (current.threadId !== params.threadId) throw new Error("Instrument belongs to another thread");
        const document = await this.#hydrate(context.projectId, params.threadId, input.document);
        const instrument = publicInstrument(this.store.update(current.id, document, { expectedVersion: input.expectedVersion }));
        this.onChange?.({ action: "updated", projectId: context.projectId, threadId: params.threadId, instrument });
        return textResult({ instrument });
      }
      if (params.tool === "refresh_instrument") {
        const instrument = await this.refresh(context.projectId, current.id, input.source, params.threadId);
        return textResult({ instrument });
      }
      if (params.tool === "open_instrument") {
        const instrument = await this.open(context.projectId, current.id, params.threadId);
        return textResult({ instrument });
      }
      if (params.tool === "delete_instrument") {
        if (current.threadId !== params.threadId) throw new Error("Instrument belongs to another thread");
        const instrument = this.delete(context.projectId, current.id);
        return textResult({ deleted: true, instrument });
      }
      throw new Error(`Unknown Pixice Instrument tool: ${params.tool}`);
    } catch (error) {
      return textResult({ error: error.message }, false);
    }
  }

  #instrument(projectId, instrumentId) {
    const instrument = this.store.get(instrumentId);
    if (!instrument || instrument.projectId !== projectId) throw new Error("Instrument not found in this project");
    return instrument;
  }

  #accessibleInstrument(projectId, threadId, instrumentId) {
    const instrument = this.#instrument(projectId, instrumentId);
    this.#assertAccess(instrument, threadId);
    return instrument;
  }

  #pinnedInstrument(projectId, instrumentId, threadId) {
    const instrument = this.#accessibleInstrument(projectId, threadId, instrumentId);
    if (instrument.lifecycle !== "pinned") throw new Error("Project tool is not pinned");
    return instrument;
  }

  #assertAccess(instrument, threadId) {
    if (!threadId) throw new Error("A controlling thread is required");
    const context = this.threadContext(threadId);
    if (!context || context.projectId !== instrument.projectId) throw new Error("The controlling thread is outside this Instrument's project");
    if (instrument.lifecycle !== "pinned" && instrument.threadId !== threadId) throw new Error("Instrument belongs to another thread");
    return threadId;
  }

  async #refresh(instrument, names) {
    const document = await this.#hydrate(instrument.projectId, instrument.threadId, instrument.document, names);
    return this.store.update(instrument.id, document, { expectedVersion: instrument.documentVersion, recordRevision: false });
  }

  #launchValues(parameters, input) {
    const supplied = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const unknown = Object.keys(supplied).find((name) => !parameters[name]);
    if (unknown) throw new Error(`Unknown launch parameter: ${unknown}`);
    const values = {};
    for (const [name, parameter] of Object.entries(parameters)) {
      const value = supplied[name] ?? parameter.default;
      if (value === undefined || value === "") {
        if (parameter.required) throw new Error(`Launch parameter is required: ${parameter.label}`);
        continue;
      }
      const expected = parameter.type === "select" ? null : parameter.type;
      if (expected && typeof value !== expected) throw new Error(`${parameter.label} must be ${expected}`);
      if (parameter.type === "select" && !parameter.options.some((option) => option.value === value)) throw new Error(`${parameter.label} has an invalid option`);
      if (typeof value === "string" && value.length > 2_000) throw new Error(`${parameter.label} is too long`);
      if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`${parameter.label} must be finite`);
      values[name] = value;
    }
    return values;
  }

  async #hydrate(projectId, threadId, input, requestedNames) {
    const document = normalizeInstrumentDocument(input);
    const names = requestedNames ?? Object.keys(document.sources);
    const data = { ...document.data };
    const sourceState = Object.fromEntries(Object.keys(document.sources).map((name) => [name, document.sourceState[name] ?? {
      status: "pending",
      refreshedAt: null,
      error: null
    }]));
    for (const name of names) {
      const source = document.sources[name];
      if (!source) continue;
      try {
        if (!this.readCapability) throw new Error("Live Instrument data is unavailable");
        const result = await this.readCapability({ projectId, threadId, name, ...source });
        const encoded = JSON.stringify(result);
        if (typeof encoded !== "string") throw new Error("Live source returned no JSON value");
        if (Buffer.byteLength(encoded, "utf8") > MAX_INSTRUMENT_SOURCE_BYTES) throw new Error(`Live source exceeds ${MAX_INSTRUMENT_SOURCE_BYTES} bytes`);
        data[name] = JSON.parse(encoded);
        sourceState[name] = { status: "ready", refreshedAt: new Date().toISOString(), error: null };
      } catch (error) {
        sourceState[name] = { status: "error", refreshedAt: sourceState[name]?.refreshedAt ?? null, error: String(error.message ?? error).slice(0, 1_000) };
      }
    }
    return normalizeInstrumentDocument({ ...document, data, sourceState });
  }
}

export { instrumentDocumentSchema, toolDefinitions as instrumentTools };
