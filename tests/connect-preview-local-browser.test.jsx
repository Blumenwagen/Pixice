import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { ConnectPreview } from "../src/connect-preview.jsx";
import { createWorkspaceStorage } from "../src/connect/execution-storage.js";

let fixture;

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  fixture = ConnectPreview.installFixture(window);
  fixture.sessionStorage.setItem("pixice.connect.active", "__pixice_local__");
  createWorkspaceStorage("local").removeItem("pixice.activeProjectId");
});

afterEach(() => {
  fixture?.restore();
  fixture = null;
  vi.unstubAllGlobals();
});

describe("Connect preview local browser fixture", () => {
  it("opens the real local preview without a display error", async () => {
    render(<StrictMode><ConnectPreview fixture={fixture} /></StrictMode>);

    const environment = await screen.findByRole("button", { name: "Environment: This device" });
    fireEvent.click(environment);
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /This device/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Open preview workspace" }));

    const localHost = fixture.hosts[ConnectPreview.fixtureHosts.local];
    await waitFor(() => expect(localHost.browser.viewportCalls).toEqual(expect.arrayContaining([expect.objectContaining({ visible: true })])));
    expect(localHost.browser.viewport).toMatchObject({ visible: true });
    expect(localHost.browser.viewport.workspaceId).toBeTruthy();
    expect(screen.queryByText("Pixice hit a display error")).not.toBeInTheDocument();
    expect(fixture.hostApis[ConnectPreview.fixtureHosts.operator].browser.setViewport).toBeUndefined();
    expect(fixture.hostApis[ConnectPreview.fixtureHosts.observer].browser.setViewport).toBeUndefined();
  });
});
