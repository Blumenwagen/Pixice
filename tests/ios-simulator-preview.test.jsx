import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IosSimulatorPreview } from "../src/components/ios/IosSimulatorPreview.jsx";

function createApi({ ready = true } = {}) {
  return {
    ios: {
      environment: vi.fn(async () => ({
        ready,
        simulators: ready ? [{ udid: "SIM-1", name: "iPhone 17 Pro" }] : [],
        issues: ready ? [] : [{ code: "full_xcode_required", message: "Install full Xcode." }]
      })),
      discover: vi.fn(async () => [{ path: "/project/Demo.xcodeproj", relativePath: "Demo.xcodeproj", schemes: ["Demo"] }]),
      start: vi.fn(async (request) => ({ ...request, status: "ready", deviceName: "iPhone 17 Pro", previewUrl: "http://127.0.0.1:3200" })),
      state: vi.fn(async () => null),
      stop: vi.fn(async () => ({ status: "stopped" })),
      action: vi.fn(async ({ action }) => action === "logs" ? { text: "DemoApp launched" } : { ok: true })
    },
    preview: { openFile: vi.fn() }
  };
}

describe("iOS Simulator Preview", () => {
  it("loads projects, schemes, and devices before starting", async () => {
    const api = createApi();
    render(<IosSimulatorPreview api={api} projectId="project-1" workspaceId="thread-1" />);

    expect(await screen.findByRole("combobox", { name: "Xcode project" })).toHaveValue("Demo.xcodeproj");
    expect(screen.getByRole("combobox", { name: "Xcode scheme" })).toHaveValue("Demo");
    expect(screen.getByRole("combobox", { name: "iOS Simulator" })).toHaveValue("SIM-1");

    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => expect(api.ios.start).toHaveBeenCalledWith({
      workspaceId: "thread-1",
      projectId: "project-1",
      containerPath: "Demo.xcodeproj",
      scheme: "Demo",
      simulatorUdid: "SIM-1",
      configuration: "Debug"
    }));
    expect(await screen.findByTitle("iPhone 17 Pro Simulator")).toHaveAttribute("src", "http://127.0.0.1:3200");
  });

  it("shows actionable environment issues and disables Run", async () => {
    const api = createApi({ ready: false });
    render(<IosSimulatorPreview api={api} projectId="project-1" workspaceId="thread-1" />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Install full Xcode");
    expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
  });

  it("offers scoped controls for a running session", async () => {
    const api = createApi();
    render(<IosSimulatorPreview
      api={api}
      projectId="project-1"
      workspaceId="thread-1"
      initialSession={{ status: "ready", scheme: "Demo", deviceName: "iPhone 17 Pro", previewUrl: "http://127.0.0.1:3200" }}
    />);

    fireEvent.click(await screen.findByRole("button", { name: "Home" }));
    await waitFor(() => expect(api.ios.action).toHaveBeenCalledWith({ workspaceId: "thread-1", action: "button", name: "home" }));
    fireEvent.click(screen.getByRole("button", { name: "Dark mode" }));
    await waitFor(() => expect(api.ios.action).toHaveBeenCalledWith({ workspaceId: "thread-1", action: "appearance", theme: "dark" }));
    fireEvent.click(screen.getByRole("button", { name: "Logs" }));
    expect(await screen.findByText("DemoApp launched")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(api.ios.stop).toHaveBeenCalledWith({ workspaceId: "thread-1" }));
  });

  it("renders structured diagnostics and rebuilds the selected scheme", async () => {
    const api = createApi();
    const onOpenResource = vi.fn();
    render(<IosSimulatorPreview
      api={api}
      projectId="project-1"
      workspaceId="thread-1"
      onOpenResource={onOpenResource}
      initialSession={{
        status: "ready",
        scheme: "Demo",
        deviceName: "iPhone 17 Pro",
        previewUrl: "http://127.0.0.1:3200",
        diagnostics: {
          diagnostics: [{ id: "d1", severity: "error", message: "Missing return", path: "/project/Demo.swift", line: 12 }],
          logText: "Build failed"
        }
      }}
    />);

    fireEvent.click(await screen.findByText("Missing return"));
    expect(onOpenResource).toHaveBeenCalledWith("/project/Demo.swift");

    fireEvent.click(screen.getByRole("button", { name: "Rebuild" }));
    await waitFor(() => expect(api.ios.stop).toHaveBeenCalledWith({ workspaceId: "thread-1" }));
    await waitFor(() => expect(api.ios.start).toHaveBeenCalledWith({
      workspaceId: "thread-1",
      projectId: "project-1",
      containerPath: "Demo.xcodeproj",
      scheme: "Demo",
      simulatorUdid: "SIM-1",
      configuration: "Debug"
    }));
  });
});
