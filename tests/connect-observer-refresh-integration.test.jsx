import React, { StrictMode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectPreview } from "../src/connect-preview.jsx";

let fixture;

beforeEach(() => {
  fixture = ConnectPreview.installFixture(window);
  fixture.reset();
});

afterEach(() => {
  fixture?.restore();
  fixture = null;
});

function observerReadCounts() {
  const reads = ["app.bootstrap", "threads.list", "board.list", "review.read", "threads.read", "tasks.receipt", "files.preview"];
  return Object.fromEntries(reads.map((operation) => [
    operation,
    fixture.calls.filter((call) => call.hostId === "observer-c" && call.operation === operation).length
  ]));
}

async function expectFreshObserverReads(previous) {
  await waitFor(() => {
    const next = observerReadCounts();
    for (const operation of Object.keys(previous)) expect(next[operation]).toBeGreaterThan(previous[operation]);
  });
}

describe("Connect observer refresh integration", () => {
  it("refreshes the real observer snapshot repeatedly while preserving task and file selection", async () => {
    render(<StrictMode><ConnectPreview fixture={fixture} /></StrictMode>);

    const environment = await screen.findByRole("button", { name: "Environment: This device" });
    await waitFor(() => expect(environment).toBeEnabled());
    fireEvent.click(environment);
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /Observer tablet/ }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Environment: Observer tablet" })).toBeInTheDocument());
    await screen.findByRole("heading", { name: "Read-only project view" });
    await screen.findByText("Review remote mobile handoff");
    await screen.findByText("Verify observer snapshot");
    const file = await screen.findByRole("option", { name: /generated-fixture\.md/ });
    fireEvent.click(file);
    await screen.findByText(/This file is synthetic preview evidence\./);

    const project = screen.getByLabelText("Observer project");
    const task = screen.getByLabelText("Observer task");
    expect(project).toHaveValue("project-b");
    expect(task).toHaveValue("thread-collision");
    expect(file).toHaveAttribute("aria-selected", "true");

    const refresh = screen.getByRole("button", { name: "Refresh project" });
    await waitFor(() => expect(refresh).toBeEnabled());
    let previous = observerReadCounts();
    fireEvent.click(refresh);
    await expectFreshObserverReads(previous);
    await waitFor(() => {
      expect(project).toHaveValue("project-b");
      expect(task).toHaveValue("thread-collision");
      expect(file).toHaveAttribute("aria-selected", "true");
      expect(screen.getByText("Verify observer snapshot")).toBeInTheDocument();
      expect(screen.getByText(/This file is synthetic preview evidence\./)).toBeInTheDocument();
    });
    expect(fixture.mutationCount).toBe(0);

    previous = observerReadCounts();
    fireEvent.click(refresh);
    await expectFreshObserverReads(previous);
    await waitFor(() => {
      expect(project).toHaveValue("project-b");
      expect(task).toHaveValue("thread-collision");
      expect(file).toHaveAttribute("aria-selected", "true");
      expect(screen.getByText("Verify observer snapshot")).toBeInTheDocument();
      expect(screen.getByText(/This file is synthetic preview evidence\./)).toBeInTheDocument();
    });
    expect(fixture.mutationCount).toBe(0);
  });
});
