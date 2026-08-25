import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstrumentService, instrumentDynamicTools } from "../electron/instruments/instrument-service.mjs";

const temporaryDirectories = [];

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

function resultValue(result) {
  return JSON.parse(result.contentItems[0].text);
}

function document(title = "Release cockpit") {
  return {
    version: 1,
    title,
    state: { ready: false },
    layout: {
      type: "stack",
      children: [
        { type: "toggle", id: "ready", label: "Ready" },
        { type: "text", text: "$state.ready" }
      ]
    }
  };
}

describe("Instrument agent capability", () => {
  it("creates, opens, updates, inspects, lists, and deletes a thread-owned Instrument", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-instrument-service-"));
    temporaryDirectories.push(directory);
    const onChange = vi.fn();
    const onOpen = vi.fn();
    const service = new InstrumentService({
      userDataPath: directory,
      threadContext: (threadId) => threadId.startsWith("thread-") ? { projectId: "project-1" } : null,
      onChange,
      onOpen
    });

    const createdResult = await service.handleToolCall({
      threadId: "thread-owner",
      tool: "create_instrument",
      arguments: { document: document() }
    });
    const created = resultValue(createdResult).instrument;
    expect(created).toMatchObject({ threadId: "thread-owner", documentVersion: 1 });
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ instrument: expect.objectContaining({ id: created.id }) }));

    const listed = resultValue(await service.handleToolCall({ threadId: "thread-owner", tool: "list_instruments", arguments: {} }));
    expect(listed.instruments.map((instrument) => instrument.id)).toEqual([created.id]);

    const inspected = resultValue(await service.handleToolCall({
      threadId: "thread-owner",
      tool: "inspect_instrument",
      arguments: { instrumentId: created.id }
    }));
    expect(inspected.instrument.document.title).toBe("Release cockpit");

    const updated = resultValue(await service.handleToolCall({
      threadId: "thread-owner",
      tool: "update_instrument",
      arguments: { instrumentId: created.id, expectedVersion: 1, document: document("Updated cockpit") }
    })).instrument;
    expect(updated).toMatchObject({ documentVersion: 2 });

    const foreign = await service.handleToolCall({
      threadId: "thread-foreign",
      tool: "inspect_instrument",
      arguments: { instrumentId: created.id }
    });
    expect(foreign.success).toBe(false);
    expect(resultValue(foreign).error).toContain("another thread");

    const deleted = resultValue(await service.handleToolCall({
      threadId: "thread-owner",
      tool: "delete_instrument",
      arguments: { instrumentId: created.id }
    }));
    expect(deleted.deleted).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(3);
    service.close();
  });

  it("advertises a dedicated provider-neutral tool namespace", () => {
    expect(instrumentDynamicTools[0]).toMatchObject({ type: "namespace", name: "pixice_instruments" });
    expect(instrumentDynamicTools[0].tools.map((tool) => tool.name)).toEqual([
      "describe_contract",
      "create_instrument",
      "inspect_instrument",
      "update_instrument",
      "refresh_instrument",
      "open_instrument",
      "list_instruments",
      "delete_instrument"
    ]);
  });

  it("cleans up ephemeral Instruments with their owning thread", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-instrument-cleanup-"));
    temporaryDirectories.push(directory);
    const onChange = vi.fn();
    const service = new InstrumentService({
      userDataPath: directory,
      threadContext: () => ({ projectId: "project-1" }),
      onChange
    });
    await service.handleToolCall({ threadId: "thread-1", tool: "create_instrument", arguments: { document: document() } });
    onChange.mockClear();

    expect(service.removeEphemeralForThread("thread-1")).toHaveLength(1);
    expect(service.list("project-1", "thread-1")).toEqual([]);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ action: "deleted", threadId: "thread-1" }));
    service.close();
  });

  it("hydrates bounded sources and refreshes one source without losing the document", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-instrument-sources-"));
    temporaryDirectories.push(directory);
    const readCapability = vi.fn()
      .mockResolvedValueOnce({ dirtyCount: 2 })
      .mockResolvedValueOnce({ dirtyCount: 3 })
      .mockRejectedValueOnce(new Error("Git is temporarily unavailable"));
    const onChange = vi.fn();
    const service = new InstrumentService({
      userDataPath: directory,
      threadContext: () => ({ projectId: "project-1" }),
      readCapability,
      onChange
    });
    const sourceDocument = {
      ...document(),
      sources: { status: { capability: "git.status", refresh: "manual" } },
      layout: { type: "metric", label: "Changed", value: "$data.status.dirtyCount", format: "number" }
    };
    const created = resultValue(await service.handleToolCall({
      threadId: "thread-1",
      tool: "create_instrument",
      arguments: { document: sourceDocument }
    })).instrument;

    expect(created.document.data.status).toEqual({ dirtyCount: 2 });
    expect(created.document.sourceState.status).toMatchObject({ status: "ready", error: null });
    const refreshed = await service.refresh("project-1", created.id, "status");
    expect(refreshed.documentVersion).toBe(2);
    expect(refreshed.document.data.status).toEqual({ dirtyCount: 3 });
    expect(readCapability).toHaveBeenLastCalledWith(expect.objectContaining({ capability: "git.status", name: "status" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ action: "refreshed" }));
    const failedRefresh = await service.refresh("project-1", created.id, "status");
    expect(failedRefresh.document.data.status).toEqual({ dirtyCount: 3 });
    expect(failedRefresh.document.sourceState.status).toMatchObject({ status: "error", error: "Git is temporarily unavailable" });
    service.close();
  });

  it("turns a declared user action into a persisted agent event", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-instrument-agent-event-"));
    temporaryDirectories.push(directory);
    const onAgentEvent = vi.fn().mockResolvedValue({ turn: { id: "turn-1" } });
    const onEventChange = vi.fn();
    const service = new InstrumentService({
      userDataPath: directory,
      threadContext: () => ({ projectId: "project-1" }),
      onAgentEvent,
      onEventChange
    });
    const eventDocument = {
      ...document(),
      actions: {
        investigate: { type: "sendAgentEvent", event: "investigateSelection", payload: "$state.selected" }
      }
    };
    const created = resultValue(await service.handleToolCall({
      threadId: "thread-1",
      tool: "create_instrument",
      arguments: { document: eventDocument }
    })).instrument;

    const event = await service.dispatchAgentEvent("project-1", created.id, "investigate", { selected: ["src/app.js"] }, { permissionMode: "read-only" });
    expect(event).toMatchObject({ event: "investigateSelection", status: "sent", turnId: "turn-1" });
    expect(onAgentEvent).toHaveBeenCalledWith(expect.objectContaining({
      instrument: expect.objectContaining({ id: created.id }),
      event: expect.objectContaining({ payload: { selected: ["src/app.js"] } }),
      runtimeOptions: { permissionMode: "read-only" }
    }));
    expect(service.listEvents("project-1", created.id)).toHaveLength(1);
    expect(onEventChange.mock.calls.map(([payload]) => payload.action)).toEqual(["sending", "sent"]);
    await expect(service.dispatchAgentEvent("project-1", created.id, "missing", {})).rejects.toThrow("cannot send");
    service.close();
  });

  it("shares pinned Instruments across project threads and invokes confirmed capabilities", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-instrument-capability-"));
    temporaryDirectories.push(directory);
    const invokeCapability = vi.fn().mockResolvedValue({ id: "task-1", column: "done" });
    const confirmCapability = vi.fn().mockResolvedValue(true);
    const resolveCapability = vi.fn(async ({ arguments: argumentsValue }) => ({ arguments: argumentsValue, targetVersion: "task-v1", summary: "Move Release from Ready to Done." }));
    const service = new InstrumentService({
      userDataPath: directory,
      threadContext: (threadId) => threadId === "thread-outside" ? { projectId: "project-2" } : threadId.startsWith("thread-") ? { projectId: "project-1" } : null,
      resolveCapability,
      confirmCapability,
      invokeCapability
    });
    const capabilityDocument = {
      ...document("Shared release tool"),
      actions: {
        move: { type: "invokeCapability", capability: "board.move", arguments: "$state.move", confirmation: "Move this task?" }
      }
    };
    const created = resultValue(await service.handleToolCall({ threadId: "thread-owner", tool: "create_instrument", arguments: { document: capabilityDocument } })).instrument;
    expect(service.setPinned("project-1", created.id, true, "thread-owner").lifecycle).toBe("pinned");
    expect(service.list("project-1", "thread-other").map((item) => item.id)).toContain(created.id);

    const inspected = await service.handleToolCall({ threadId: "thread-other", tool: "inspect_instrument", arguments: { instrumentId: created.id } });
    expect(inspected.success).toBe(true);
    const outside = await service.handleToolCall({ threadId: "thread-outside", tool: "inspect_instrument", arguments: { instrumentId: created.id } });
    expect(outside.success).toBe(false);
    const update = await service.handleToolCall({ threadId: "thread-other", tool: "update_instrument", arguments: { instrumentId: created.id, expectedVersion: 1, document: capabilityDocument } });
    expect(update.success).toBe(false);
    expect(resultValue(update).error).toContain("must be unpinned");

    const invocation = await service.dispatchCapability("project-1", created.id, "move", { taskId: "task-1", column: "done" }, "thread-other", "request-1");
    expect(invocation.result).toEqual({ id: "task-1", column: "done" });
    expect(confirmCapability).toHaveBeenCalledWith(expect.objectContaining({ action: expect.objectContaining({ capability: "board.move" }), resolution: expect.objectContaining({ targetVersion: "task-v1", summary: "Move Release from Ready to Done." }), threadId: "thread-other" }));
    expect(invokeCapability).toHaveBeenCalledWith(expect.objectContaining({ projectId: "project-1", threadId: "thread-other", capability: "board.move", arguments: { taskId: "task-1", column: "done" } }));
    const duplicate = await service.dispatchCapability("project-1", created.id, "move", { taskId: "task-1", column: "done" }, "thread-other", "request-1");
    expect(duplicate).toMatchObject({ duplicate: true, result: { id: "task-1", column: "done" } });
    expect(service.listReceipts("project-1", created.id)).toHaveLength(1);
    confirmCapability.mockResolvedValueOnce(false);
    const cancelled = await service.dispatchCapability("project-1", created.id, "move", { taskId: "task-2", column: "done" }, "thread-other");
    expect(cancelled).toMatchObject({ cancelled: true, receipt: null });
    expect(invokeCapability).toHaveBeenCalledTimes(1);
    expect(service.setGrants("project-1", created.id, [], "thread-other").grants).toEqual([]);
    await expect(service.dispatchCapability("project-1", created.id, "move", { taskId: "task-3", column: "done" }, "thread-other")).rejects.toThrow("not granted");
    expect(service.setPinned("project-1", created.id, false, "thread-other")).toMatchObject({ lifecycle: "ephemeral", threadId: "thread-other" });
    service.close();
  });

  it("manages project tool metadata, launch inputs, copies, and revision restore", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-project-tools-"));
    temporaryDirectories.push(directory);
    const onOpen = vi.fn();
    const service = new InstrumentService({
      userDataPath: directory,
      threadContext: () => ({ projectId: "project-1" }),
      onOpen
    });
    const toolDocument = {
      ...document("Release launcher"),
      parameters: {
        environment: { label: "Environment", type: "select", required: true, options: [{ label: "Staging", value: "staging" }, { label: "Production", value: "production" }] },
        dryRun: { label: "Dry run", type: "boolean", default: true }
      },
      layout: { type: "text", text: "$params.environment" }
    };
    const created = resultValue(await service.handleToolCall({ threadId: "thread-1", tool: "create_instrument", arguments: { document: toolDocument } })).instrument;
    const updated = resultValue(await service.handleToolCall({ threadId: "thread-1", tool: "update_instrument", arguments: { instrumentId: created.id, expectedVersion: 1, document: { ...toolDocument, title: "Release launcher v2" } } })).instrument;
    service.setPinned("project-1", created.id, true, "thread-1");

    expect(service.renameTool("project-1", created.id, "Deploy", "thread-1").metadata.name).toBe("Deploy");
    await expect(service.launch("project-1", created.id, {}, "thread-1")).rejects.toThrow("Environment");
    const launched = await service.launch("project-1", created.id, { environment: "production" }, "thread-1");
    expect(launched.launchValues).toEqual({ environment: "production", dryRun: true });
    expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ instrument: expect.objectContaining({ launchValues: { environment: "production", dryRun: true } }) }));
    expect(service.listTools("project-1")[0]).toMatchObject({ metadata: { name: "Deploy" }, usageCount: 1 });

    const copy = service.duplicateTool("project-1", created.id, "thread-1");
    expect(copy).toMatchObject({ lifecycle: "pinned", metadata: { name: "Deploy copy" } });
    const restored = service.restoreRevision("project-1", created.id, 1, "thread-1");
    expect(restored.document.title).toBe("Release launcher");
    expect(restored.documentVersion).toBe(updated.documentVersion + 1);
    expect(service.deleteTool("project-1", copy.id, "thread-1").id).toBe(copy.id);
    service.close();
  });
});
