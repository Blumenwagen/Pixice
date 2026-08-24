import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InstrumentStore } from "../electron/instruments/instrument-store.mjs";

const temporaryDirectories = [];

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

function instrumentDocument(title = "Impact map") {
  return {
    version: 1,
    title,
    layout: { type: "text", text: "Read-only native content" }
  };
}

describe("Instrument store", () => {
  it("persists documents and updates them with optimistic concurrency", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-instruments-"));
    temporaryDirectories.push(directory);
    const store = new InstrumentStore(directory);

    const created = store.create({
      id: "instrument-1",
      projectId: "project-1",
      threadId: "thread-1",
      document: instrumentDocument()
    });
    expect(created).toMatchObject({ documentVersion: 1, lifecycle: "ephemeral" });
    expect(store.list("project-1", { threadId: "thread-1" })).toHaveLength(1);

    const updated = store.update("instrument-1", instrumentDocument("Updated map"), { expectedVersion: 1 });
    expect(updated).toMatchObject({ documentVersion: 2 });
    expect(updated.document.title).toBe("Updated map");
    expect(() => store.update("instrument-1", instrumentDocument(), { expectedVersion: 1 })).toThrow("version conflict");
    store.close();

    const reopened = new InstrumentStore(directory);
    expect(reopened.get("instrument-1").documentVersion).toBe(2);
    expect(reopened.delete("instrument-1").id).toBe("instrument-1");
    expect(reopened.get("instrument-1")).toBeNull();
    reopened.close();
  });

  it("removes only ephemeral Instruments when their thread ends", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-instrument-lifecycle-"));
    temporaryDirectories.push(directory);
    const store = new InstrumentStore(directory);
    store.create({ id: "ephemeral", projectId: "project-1", threadId: "thread-1", document: instrumentDocument() });
    store.create({ id: "pinned", projectId: "project-1", threadId: "thread-1", document: instrumentDocument(), lifecycle: "pinned" });

    expect(store.deleteEphemeralForThread("thread-1").map((item) => item.id)).toEqual(["ephemeral"]);
    expect(store.get("ephemeral")).toBeNull();
    expect(store.get("pinned")).toMatchObject({ lifecycle: "pinned" });
    store.close();
  });

  it("records and updates bounded Instrument event history", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-instrument-events-"));
    temporaryDirectories.push(directory);
    const store = new InstrumentStore(directory);
    store.create({ id: "instrument-events", projectId: "project-1", threadId: "thread-1", document: instrumentDocument() });

    expect(store.createEvent({
      id: "event-1",
      instrumentId: "instrument-events",
      threadId: "thread-1",
      event: "investigate",
      payload: { selected: ["src/app.js"] }
    })).toMatchObject({ status: "sending", payload: { selected: ["src/app.js"] } });
    expect(store.updateEvent("event-1", { status: "sent", turnId: "turn-1" })).toMatchObject({ status: "sent", turnId: "turn-1" });
    expect(store.listEvents("instrument-events")).toHaveLength(1);

    store.delete("instrument-events");
    expect(store.listEvents("instrument-events")).toEqual([]);
    store.close();
  });

  it("lists pinned Instruments across threads and adopts them when unpinned", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-pinned-instruments-"));
    temporaryDirectories.push(directory);
    const store = new InstrumentStore(directory);
    store.create({ id: "shared", projectId: "project-1", threadId: "thread-1", document: instrumentDocument() });
    store.setLifecycle("shared", "pinned", "thread-1");

    expect(store.list("project-1", { threadId: "thread-2", includePinned: true }).map((item) => item.id)).toEqual(["shared"]);
    expect(store.setLifecycle("shared", "ephemeral", "thread-2")).toMatchObject({ lifecycle: "ephemeral", threadId: "thread-2" });
    expect(store.list("project-1", { threadId: "thread-1", includePinned: true })).toEqual([]);
    store.close();
  });

  it("keeps grants outside revision restore and records idempotent action receipts", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pixice-tool-history-"));
    temporaryDirectories.push(directory);
    const store = new InstrumentStore(directory);
    store.create({ id: "tool", projectId: "project-1", threadId: "thread-1", document: instrumentDocument("Version one"), lifecycle: "pinned", grants: ["board.move"] });
    store.update("tool", instrumentDocument("Version two"), { expectedVersion: 1 });
    store.setGrants("tool", []);

    expect(store.listRevisions("tool").map((revision) => revision.version)).toEqual([2, 1]);
    const restored = store.restoreRevision("tool", 1);
    expect(restored.document.title).toBe("Version one");
    expect(restored.grants).toEqual([]);

    store.createReceipt({
      requestId: "request-1",
      instrumentId: "tool",
      threadId: "thread-1",
      actionId: "move",
      capability: "board.move",
      argumentsHash: "hash",
      targetVersion: "target-v1",
      effectSummary: "Move the task."
    });
    expect(store.updateReceipt("request-1", { status: "sent", result: { column: "done" } })).toMatchObject({ status: "sent", result: { column: "done" } });
    expect(store.listReceipts("tool")).toHaveLength(1);
    store.close();
  });
});
