import { describe, expect, it } from "vitest";
import {
  MAX_INSTRUMENT_DEPTH,
  MAX_INSTRUMENT_SOURCES,
  MAX_THREAD_INSTRUMENTS,
  instrumentContractSummary,
  normalizeInstrumentDocument
} from "../electron/instruments/instrument-model.mjs";

function document(overrides = {}) {
  return {
    version: 1,
    title: "Dependency explorer",
    state: { selected: [] },
    data: { packages: [{ id: "react", name: "React" }] },
    layout: {
      type: "stack",
      children: [
        { type: "text", text: "Choose a package" },
        {
          type: "table",
          columns: [{ key: "name", label: "Package" }],
          rows: "$data.packages",
          selection: "selected"
        }
      ]
    },
    ...overrides
  };
}

describe("Instrument document model", () => {
  it("normalizes a strict versioned native document", () => {
    const normalized = normalizeInstrumentDocument(document());

    expect(normalized).toMatchObject({
      version: 1,
      title: "Dependency explorer",
      description: "",
      actions: {}
    });
    expect(normalized.layout).toMatchObject({ type: "stack", gap: "medium" });
    expect(instrumentContractSummary().display).toContain("graph");
    expect(instrumentContractSummary().limits.instrumentsPerThread).toBe(MAX_THREAD_INSTRUMENTS);
    expect(instrumentContractSummary().limits.liveDataSources).toBe(MAX_INSTRUMENT_SOURCES);
  });

  it("normalizes bounded live sources and agent actions", () => {
    const normalized = normalizeInstrumentDocument(document({
      parameters: {
        environment: { label: "Environment", type: "select", required: true, options: [{ label: "Staging", value: "staging" }] }
      },
      sources: {
        status: { capability: "git.status", refresh: "onOpen" },
        run: { capability: "workflow.output", arguments: { workflowId: "release" }, refresh: "event" }
      },
      actions: {
        refresh: { type: "refreshData", source: "status" },
        investigate: { type: "sendAgentEvent", event: "investigateSelection", payload: "$state.selected" },
        move: { type: "invokeCapability", capability: "board.move", arguments: { taskId: "$state.task", column: "done" }, confirmation: "Move the selected task to Done?" }
      }
    }));

    expect(normalized.sources.status).toEqual({ capability: "git.status", arguments: {}, refresh: "onOpen" });
    expect(normalized.sources.run.refresh).toBe("event");
    expect(normalized.parameters.environment.options[0].value).toBe("staging");
    expect(normalized.actions.investigate).toMatchObject({ type: "sendAgentEvent", event: "investigateSelection" });
    expect(normalized.actions.move).toMatchObject({ type: "invokeCapability", capability: "board.move" });
  });

  it("rejects malformed launch parameters", () => {
    expect(() => normalizeInstrumentDocument(document({
      parameters: { environment: { label: "Environment", type: "select" } }
    }))).toThrow("Select parameters require options");
    expect(() => normalizeInstrumentDocument(document({
      parameters: { retries: { label: "Retries", type: "number", default: "three" } }
    }))).toThrow("Parameter default must be number");
  });

  it("rejects executable or unknown fields", () => {
    expect(() => normalizeInstrumentDocument(document({ script: "fetch('https://example.com')" }))).toThrow();
    expect(() => normalizeInstrumentDocument(document({
      layout: { type: "text", text: "Hello", html: "<script>alert(1)</script>" }
    }))).toThrow();
  });

  it("rejects duplicate control ids and invalid ranges", () => {
    expect(() => normalizeInstrumentDocument(document({
      layout: {
        type: "stack",
        children: [
          { type: "input", id: "query", label: "Query" },
          { type: "toggle", id: "query", label: "Exact match" }
        ]
      }
    }))).toThrow("Duplicate Instrument primitive id: query");

    expect(() => normalizeInstrumentDocument(document({
      layout: { type: "range", id: "budget", label: "Budget", min: 10, max: 2 }
    }))).toThrow("Range maximum");
  });

  it("enforces the nesting limit", () => {
    let layout = { type: "text", text: "Deep" };
    for (let index = 0; index < MAX_INSTRUMENT_DEPTH; index += 1) {
      layout = { type: "stack", children: [layout] };
    }
    expect(() => normalizeInstrumentDocument(document({ layout }))).toThrow(`exceeds ${MAX_INSTRUMENT_DEPTH} levels`);
  });

  it("limits the number of live data sources", () => {
    const sources = Object.fromEntries(Array.from({ length: MAX_INSTRUMENT_SOURCES + 1 }, (_, index) => [`source${index}`, { capability: "git.status" }]));
    expect(() => normalizeInstrumentDocument(document({ sources }))).toThrow(`exceeds ${MAX_INSTRUMENT_SOURCES} live data sources`);
  });
});
