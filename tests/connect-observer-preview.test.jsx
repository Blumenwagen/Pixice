import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { RemoteClient } from "../src/connect/client.js";
import { ObserverWorkspace } from "../src/connect/observer-workspace.jsx";
import { ConnectPreview } from "../src/connect-preview.jsx";

let fixture;

beforeEach(() => {
  fixture = ConnectPreview.installFixture(window);
});

afterEach(() => {
  fixture?.restore();
  fixture = null;
});

describe("Connect preview fixture", () => {
  it("serves a real scoped observer session through the remote client", async () => {
    const host = fixture.hosts[ConnectPreview.fixtureHosts.observer];
    const client = new RemoteClient({ id: host.id, endpoint: "https://observer-c.example", token: host.token });
    await client.connect();
    const bootstrap = await client.api.app.bootstrap();
    expect(bootstrap.projects.map((project) => project.id)).toEqual(["project-b"]);
    await expect(client.api.threads.read({ projectId: "project-secret", threadId: "thread-collision" })).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    await expect(client.api.turns.start({ projectId: "project-b", threadId: "thread-collision", text: "should be blocked" })).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    client.close();
  });

  it("renders Board, changed files, conversation evidence, and a receipt", async () => {
    const host = fixture.hosts[ConnectPreview.fixtureHosts.observer];
    expect((await fixture.hostApis[ConnectPreview.fixtureHosts.observer].threads.list({ projectId: "project-b" })).data).toHaveLength(1);
    render(<ObserverWorkspace api={fixture.hostApis[ConnectPreview.fixtureHosts.observer]} hostId={host.id} hostLabel="Observer tablet" projectIds={["project-b"]} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Read-only project view" })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("Review remote mobile handoff")).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Board" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Project files" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Saved receipt" })).toBeInTheDocument());
  });

  it("routes a service-worker message with the expected source URL", () => {
    const received = [];
    const listener = (event) => received.push(event);
    fixture.serviceWorker.addEventListener("message", listener);
    fixture.pushTarget({ hostId: "observer-c", projectId: "project-b", threadId: "thread-collision" });
    expect(received).toHaveLength(1);
    expect(received[0]).toBeInstanceOf(MessageEvent);
    expect(received[0].origin).toBe(window.location.origin);
    expect(received[0].source.scriptURL).toBe(new URL("/connect-sw.js", window.location.href).href);
    expect(received[0].data.target).toMatchObject({ hostId: "observer-c", projectId: "project-b" });
    fixture.serviceWorker.removeEventListener("message", listener);
  });

  it("keeps accepted commands inspectable when the response is lost, and resyncs after restart", async () => {
    const host = fixture.hosts[ConnectPreview.fixtureHosts.operator];
    const client = new RemoteClient({ id: host.id, endpoint: "https://host-b.example", token: host.token });
    const events = [];
    client.subscribe((event) => events.push(event));
    await client.connect();
    host.responseLoss = true;
    const failure = await client.api.turns.start({ projectId: "project-b", threadId: "thread-collision", text: "accepted before response loss" }).catch((cause) => cause);
    expect(failure).toMatchObject({ uncertain: true });
    expect(await client.commandStatus(failure.commandId)).toMatchObject({ status: "completed", outcome: "completed" });
    fixture.restartHost(ConnectPreview.fixtureHosts.operator);
    await waitFor(() => expect(events.some((event) => event.type === "ApplicationResync")).toBe(true), { timeout: 3000 });
    client.close();
  });

  it("returns dimensioned browser frames and a controllable error state", async () => {
    const host = fixture.hosts[ConnectPreview.fixtureHosts.operator];
    const frame = await fixture.hostApis[ConnectPreview.fixtureHosts.operator].browser.frame({ workspaceId: "fixture-thread", tabId: "fixture-tab", width: 640, height: 360 });
    expect(frame).toMatchObject({ width: 640, height: 360 });
    expect(frame.frameId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    host.browserFrameError = true;
    const failedFrame = await fixture.hostApis[ConnectPreview.fixtureHosts.operator].browser.frame({ workspaceId: "fixture-thread", tabId: "fixture-tab", width: 640, height: 360 });
    expect(failedFrame.frameId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(failedFrame.frameId).not.toBe(frame.frameId);
    expect(failedFrame.image).toBe("data:image/png;base64,fixture-invalid-frame");
    host.browserFrameError = false;
  });
});
