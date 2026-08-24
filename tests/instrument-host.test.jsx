import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InstrumentHost, resolveInstrumentValue } from "../src/components/instruments/InstrumentHost.jsx";

const instrument = {
  id: "instrument-1",
  documentVersion: 1,
  lifecycle: "ephemeral",
  document: {
    version: 1,
    title: "Decision console",
    description: "Tune inputs without another model turn.",
    state: { enabled: false, owner: "Ada" },
    data: { file: "docs/decision.md" },
    actions: {
      rename: { type: "setState", path: "owner", value: "Grace" },
      open: { type: "openResource", target: "$data.file" },
      reset: { type: "resetState" }
    },
    layout: {
      type: "stack",
      children: [
        { type: "toggle", id: "enabled", label: "Include migration" },
        { type: "text", text: "$state.enabled" },
        { type: "input", id: "owner", label: "Owner" },
        { type: "button", label: "Use Grace", action: "rename", variant: "primary" },
        { type: "button", label: "Open decision", action: "open" },
        { type: "button", label: "Reset", action: "reset" }
      ]
    }
  }
};

describe("Instrument host", () => {
  it("resolves state, data, and event bindings without evaluating expressions", () => {
    const context = { state: { selected: "node-1" }, data: { rows: [1, 2] }, params: { environment: "staging" }, event: { source: "button-1" } };
    expect(resolveInstrumentValue("$state.selected", context)).toBe("node-1");
    expect(resolveInstrumentValue("$data.rows", context)).toEqual([1, 2]);
    expect(resolveInstrumentValue("$event.source", context)).toBe("button-1");
    expect(resolveInstrumentValue("$params.environment", context)).toBe("staging");
    expect(resolveInstrumentValue("$state.selected.toUpperCase()", context)).toBeUndefined();
  });

  it("keeps interactions local and opens resources through the host callback", () => {
    const onOpenResource = vi.fn();
    render(<InstrumentHost instrument={instrument} onOpenResource={onOpenResource} />);

    expect(screen.getByRole("heading", { name: "Decision console" })).toBeInTheDocument();
    expect(screen.getByText("false")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Include migration" }));
    expect(screen.getByText("true")).toBeInTheDocument();

    const owner = screen.getByRole("textbox", { name: "Owner" });
    expect(owner).toHaveValue("Ada");
    fireEvent.click(screen.getByRole("button", { name: "Use Grace" }));
    expect(owner).toHaveValue("Grace");

    fireEvent.click(screen.getByRole("button", { name: "Open decision" }));
    expect(onOpenResource).toHaveBeenCalledWith("docs/decision.md");
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(owner).toHaveValue("Ada");
  });

  it("renders malformed bound data defensively", () => {
    render(<InstrumentHost instrument={{
      ...instrument,
      id: "instrument-defensive",
      document: {
        ...instrument.document,
        title: "Defensive renderer",
        data: { statuses: [{ label: { unexpected: true }, detail: ["still", "safe"] }] },
        layout: {
          type: "stack",
          children: [
            { type: "metric", label: "Cost", value: 12, format: "currency", unit: "INVALID" },
            { type: "statusList", items: "$data.statuses", emptyLabel: "Empty" }
          ]
        }
      }
    }} />);

    expect(screen.getByText("12 INVALID")).toBeInTheDocument();
    expect(screen.getByText(/"unexpected": true/)).toBeInTheDocument();
    expect(screen.getByText(/"still"/)).toBeInTheDocument();
  });

  it("refreshes live data and sends bounded state to the owning agent", async () => {
    const onRefreshData = vi.fn().mockResolvedValue({});
    const onAgentEvent = vi.fn().mockResolvedValue({ turnId: "turn-1" });
    const remoteInstrument = {
      ...instrument,
      id: "instrument-live",
      document: {
        ...instrument.document,
        sources: { status: { capability: "git.status", arguments: {}, refresh: "manual" } },
        sourceState: { status: { status: "ready", refreshedAt: "2026-08-22T12:00:00.000Z", error: null } },
        actions: {
          refresh: { type: "refreshData", source: "status" },
          investigate: { type: "sendAgentEvent", event: "investigateOwner", payload: "$state.owner" }
        },
        layout: {
          type: "stack",
          children: [
            { type: "input", id: "owner", label: "Owner" },
            { type: "button", label: "Refresh status", action: "refresh" },
            { type: "button", label: "Investigate owner", action: "investigate", variant: "primary" }
          ]
        }
      }
    };
    const view = render(<InstrumentHost instrument={remoteInstrument} onRefreshData={onRefreshData} onAgentEvent={onAgentEvent} />);
    const owner = screen.getByRole("textbox", { name: "Owner" });
    fireEvent.change(owner, { target: { value: "Grace" } });

    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    await waitFor(() => expect(onRefreshData).toHaveBeenCalledWith("status"));
    view.rerender(<InstrumentHost instrument={{ ...remoteInstrument, documentVersion: 2, document: { ...remoteInstrument.document, data: { status: { dirtyCount: 3 } } } }} onRefreshData={onRefreshData} onAgentEvent={onAgentEvent} />);
    expect(owner).toHaveValue("Grace");

    fireEvent.click(screen.getByRole("button", { name: "Investigate owner" }));
    await waitFor(() => expect(onAgentEvent).toHaveBeenCalledWith("investigate", "Grace"));
    expect(screen.getByText("1 live source")).toBeInTheDocument();
  });

  it("refreshes on-open sources once per mounted Instrument", async () => {
    const onRefreshData = vi.fn().mockResolvedValue({});
    const onOpenInstrument = {
      ...instrument,
      id: "instrument-on-open",
      document: {
        ...instrument.document,
        sources: { status: { capability: "git.status", arguments: {}, refresh: "onOpen" } },
        sourceState: { status: { status: "ready", refreshedAt: null, error: null } }
      }
    };
    const view = render(<InstrumentHost instrument={onOpenInstrument} onRefreshData={onRefreshData} />);
    await waitFor(() => expect(onRefreshData).toHaveBeenCalledWith("status"));

    view.rerender(<InstrumentHost instrument={{ ...onOpenInstrument, documentVersion: 2 }} onRefreshData={onRefreshData} />);
    expect(onRefreshData).toHaveBeenCalledTimes(1);
  });

  it("shows trusted authority, confirms mutations, and lets the user pin the Instrument", async () => {
    const onInvokeCapability = vi.fn().mockResolvedValue({});
    const onSetPinned = vi.fn().mockResolvedValue({});
    const trustedInstrument = {
      ...instrument,
      id: "instrument-trusted",
      document: {
        ...instrument.document,
        actions: {
          move: { type: "invokeCapability", capability: "board.move", arguments: { taskId: "task-1", column: "done" }, confirmation: "Move the release task to Done?" }
        },
        layout: { type: "button", label: "Complete task", action: "move", variant: "primary" }
      }
    };
    render(<InstrumentHost instrument={trustedInstrument} onInvokeCapability={onInvokeCapability} onSetPinned={onSetPinned} />);

    expect(screen.getByLabelText("Trusted capabilities")).toHaveTextContent("board.move");
    fireEvent.click(screen.getByRole("button", { name: "Complete task" }));
    await waitFor(() => expect(onInvokeCapability).toHaveBeenCalledWith("move", { taskId: "task-1", column: "done" }));

    fireEvent.click(screen.getByRole("button", { name: "Pin to project" }));
    await waitFor(() => expect(onSetPinned).toHaveBeenCalledWith(true));
  });
});
