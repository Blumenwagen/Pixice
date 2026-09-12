import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { browserInputSchema } from "../electron/browser/remote-browser.mjs";
import { ApprovalCard } from "../src/App.jsx";
import { ConnectPreview } from "../src/connect-preview.jsx";

let fixture;

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  fixture = ConnectPreview.installFixture(window);
});

afterEach(() => {
  fixture?.restore();
  fixture = null;
  vi.unstubAllGlobals();
});

describe("Connect preview browser and attention contracts", () => {
  it("uses production browser frame and input schemas with a fresh UUID frame", async () => {
    const host = fixture.hosts[ConnectPreview.fixtureHosts.operator];
    const api = fixture.hostApis[ConnectPreview.fixtureHosts.operator];
    const workspaceId = "contract-browser-workspace";
    const state = await api.browser.state({ workspaceId });
    const frame = await api.browser.frame({ workspaceId, tabId: state.activeTabId, width: 640, height: 360 });
    expect(frame.frameId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

    const input = { workspaceId, tabId: state.activeTabId, frameId: frame.frameId, input: { type: "click", x: 20, y: 24, button: "left", clickCount: 1, modifiers: [] } };
    expect(() => browserInputSchema.parse(input)).not.toThrow();
    await expect(api.browser.input(input)).resolves.toEqual({ ok: true });

    await expect(api.browser.input({ ...input, frameId: webcrypto.randomUUID() })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(host.browser.frameId).toBe(frame.frameId);
  });

  it("keeps browser tab state transitions and BrowserState events faithful", async () => {
    const api = fixture.hostApis[ConnectPreview.fixtureHosts.operator];
    const host = fixture.hosts[ConnectPreview.fixtureHosts.operator];
    const workspaceId = "browser-state-workspace";
    const events = [];
    const unsubscribe = host.eventHub.subscribe((event) => { if (event.type === "BrowserState") events.push(event); });

    const initial = await api.browser.state({ workspaceId });
    const created = await api.browser.create({ workspaceId, url: "https://fixture.pixice.test/first" });
    expect(created.tabs).toHaveLength(2);
    expect(created.activeTabId).not.toBe(initial.activeTabId);
    expect(created.tabs.at(-1)).toMatchObject({ url: "https://fixture.pixice.test/first" });

    const navigated = await api.browser.navigate({ workspaceId, tabId: created.activeTabId, url: "https://fixture.pixice.test/second" });
    expect(navigated.tabs.find((tab) => tab.id === created.activeTabId)).toMatchObject({ url: "https://fixture.pixice.test/second", canGoBack: true });
    const wentBack = await api.browser.history({ workspaceId, action: "back" });
    expect(wentBack.tabs.find((tab) => tab.id === created.activeTabId)).toMatchObject({ url: "https://fixture.pixice.test/first", canGoForward: true });
    const wentForward = await api.browser.history({ workspaceId, action: "forward" });
    expect(wentForward.tabs.find((tab) => tab.id === created.activeTabId)).toMatchObject({ url: "https://fixture.pixice.test/second" });

    const activated = await api.browser.activate({ workspaceId, tabId: initial.activeTabId });
    expect(activated.activeTabId).toBe(initial.activeTabId);
    const closed = await api.browser.close({ workspaceId, tabId: initial.activeTabId });
    expect(closed.activeTabId).toBe(created.activeTabId);
    expect(closed.tabs.map((tab) => tab.id)).toEqual([created.activeTabId]);

    const destroyed = await api.browser.destroy({ workspaceId });
    expect(destroyed).toEqual({ destroyed: true, workspaceId });
    expect(host.browser).toMatchObject({ workspaceId: null, activeTabId: null, frameId: null, tabs: [] });
    expect(events.length).toBeGreaterThanOrEqual(5);
    expect(events.at(-1).payload).toMatchObject({ workspaceId, activeTabId: null, tabs: [] });
    unsubscribe();
  });

  it("renders the supported approval method and resolves the current generation", async () => {
    const host = fixture.hosts[ConnectPreview.fixtureHosts.local];
    fixture.emitAttention("approval", ConnectPreview.fixtureHosts.local);
    const request = host.attention.get("fixture-approval-request");
    expect(request.method).toBe("item/commandExecution/requestApproval");

    const onResolve = vi.fn(async (candidate, decision) => fixture.localApi.approvals.resolve({ requestId: candidate.requestId, requestGeneration: candidate.requestGeneration, decision }));
    render(<ApprovalCard request={request} onResolve={onResolve} />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(onResolve).toHaveBeenCalledWith(request, "accept");
    await waitFor(() => expect(fixture.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        hostId: "local",
        operation: "approvals.resolve",
        payload: expect.objectContaining({ requestId: request.requestId, requestGeneration: request.requestGeneration })
      })
    ])));
  });
});
