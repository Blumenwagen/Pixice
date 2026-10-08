import { changeEditable, installPromptEditorGeometry, toHaveEditableValue } from "./helpers/prompt-editor.js";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { CanvasAgent } from "../src/components/canvas/CanvasAgent.jsx";
import { canvasAgentContext, createCanvas, createCanvasItem } from "../src/components/canvas/canvas-store.js";

expect.extend({ toHaveEditableValue });
beforeAll(installPromptEditorGeometry);

describe("Canvas agent context", () => {
  it("uses canvas content by default and excludes other composer drafts", () => {
    const document = createCanvas();
    const agent = createCanvasItem("agent", { x: 0, y: 0 });
    document.nodes = [agent, createCanvasItem("text", { x: 0, y: 0 }, { content: "A shared brief" }), createCanvasItem("agent", { x: 0, y: 0 }, { prompt: "A private draft" })];
    const context = canvasAgentContext(document, agent.id);
    expect(context.text).toContain("A shared brief");
    expect(context.text).not.toContain("A private draft");
  });
  it("sends only explicit neighbors, and bounds text and image count", () => {
    const document = createCanvas();
    const agent = createCanvasItem("agent", { x: 0, y: 0 });
    const unrelated = createCanvasItem("text", { x: 1, y: 1 }, { content: "PRIVATE UNCONNECTED CONTENT" });
    const notes = Array.from({ length: 20 }, (_, i) => createCanvasItem("text", { x: i, y: 0 }, { title: `Note ${i}`, content: "a".repeat(10000) }));
    document.nodes = [agent, unrelated, ...notes];
    document.edges = notes.map(note => ({ source: note.id, target: agent.id }));
    const context = canvasAgentContext(document, agent.id);
    expect(context.text).not.toContain("PRIVATE UNCONNECTED CONTENT");
    expect(context.text).not.toContain("Note 12");
    expect(context.text.length).toBeLessThan(12100);
    const images = Array.from({ length: 6 }, () => createCanvasItem("image", { x: 0, y: 0 }, { src: "data:image/png;base64,aGVsbG8=" }));
    document.nodes = [agent, ...images]; document.edges = images.map(image => ({ source: agent.id, target: image.id }));
    expect(canvasAgentContext(document, agent.id).images).toHaveLength(4);
    expect(canvasAgentContext(document, unrelated.id)).toEqual({ text: "", images: [] });
  });
});

function harness(initialData, api, document = createCanvas()) {
  const node = createCanvasItem("agent", { x: 0, y: 0 }, initialData);
  document.nodes.push(node);
  const onChange = vi.fn();
  function Agent() {
    const [data, setData] = useState(node.data);
    return <CanvasAgent nodeId={node.id} data={data} api={api} projects={[{ id: "project", displayName: "Pixice" }]} models={[{ model: "model", displayName: "Model", supportedReasoningEfforts: [{ reasoningEffort: "low" }], defaultReasoningEffort: "low" }]} defaults={{ defaultModel: "model", defaultPermissionMode: "read-only", defaultEffort: "unsupported" }} documentRef={{ current: document }} onChange={patch => { onChange(patch); setData(current => ({ ...current, ...patch })); }} onPin={vi.fn()} />;
  }
  return { ...render(<Agent />), onChange, document, node };
}

describe("Canvas agents", () => {
  function permissionHarness(respond = vi.fn().mockResolvedValue({ resolved: true })) {
    let receive;
    const api = {
      threads: { read: vi.fn().mockResolvedValue({ thread: { id: "existing", turns: [] } }) },
      elicitations: { respond }, approvals: { resolve: vi.fn().mockResolvedValue({ resolved: true }) },
      events: { subscribe: callback => { receive = callback; return () => {}; } }
    };
    harness({ threadId: "existing", projectId: "project" }, api);
    const request = {
      id: "app-access", provider: "codex", requestGeneration: 42,
      method: "mcpServer/elicitation/request",
      params: { threadId: "existing", serverName: "computer", message: "Allow ChatGPT to use Safari?",
        _meta: { app_name: "Safari", persist: ["session", "always"] },
        requestedSchema: { type: "object", required: ["approval"], properties: { approval: { type: "string", enum: ["once", "session", "always"] } } }
      }
    };
    act(() => receive({ type: "AttentionRequired", payload: request }));
    return { api, request, receive };
  }

  it("sends Canvas app persistence to the native elicitation endpoint and waits for confirmation", async () => {
    let confirm;
    const responding = new Promise(resolve => { confirm = resolve; });
    const { api } = permissionHarness(vi.fn().mockReturnValue(responding));
    fireEvent.click(screen.getByRole("button", { name: "Always allow" }));
    await waitFor(() => expect(api.elicitations.respond).toHaveBeenCalledWith({ requestId: "app-access", requestGeneration: 42, decision: "acceptAlways" }));
    expect(api.approvals.resolve).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Always allow" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Waiting for provider confirmation");
    await act(async () => confirm({ resolved: true }));
    await waitFor(() => expect(screen.queryByText("Approval required")).not.toBeInTheDocument());
  });

  it("keeps uncertain Canvas permissions locked and retries the same native persistence choice", async () => {
    const respond = vi.fn().mockRejectedValueOnce(Object.assign(new Error("Provider confirmation is missing"), { uncertain: true })).mockResolvedValueOnce({ resolved: true });
    const { api } = permissionHarness(respond);
    fireEvent.click(screen.getByRole("button", { name: "Always allow" }));
    const retry = await screen.findByRole("button", { name: "Retry response" });
    expect(screen.getByRole("button", { name: "Allow once" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Decline" })).toBeDisabled();
    fireEvent.click(retry);
    await waitFor(() => expect(api.elicitations.respond).toHaveBeenCalledTimes(2));
    expect(api.elicitations.respond.mock.calls.map(call => call[0])).toEqual([
      { requestId: "app-access", requestGeneration: 42, decision: "acceptAlways" },
      { requestId: "app-access", requestGeneration: 42, decision: "acceptAlways" }
    ]);
    await waitFor(() => expect(screen.queryByText("Approval required")).not.toBeInTheDocument());
    expect(screen.queryByText("Provider confirmation is missing")).not.toBeInTheDocument();
  });

  it("preserves ordinary Canvas approvals and does not dismiss an unconfirmed response", async () => {
    const { api, request, receive } = permissionHarness();
    api.approvals.resolve.mockResolvedValue({ resolved: false });
    act(() => receive({ type: "AttentionRequired", payload: { ...request, method: "item/commandExecution/requestApproval", params: { threadId: "existing", command: "git status" } } }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await screen.findByRole("button", { name: "Retry response" });
    expect(api.approvals.resolve).toHaveBeenCalledWith({ requestId: "app-access", requestGeneration: 42, decision: "accept" });
    expect(api.elicitations.respond).not.toHaveBeenCalled();
    expect(screen.getByText("Approval required")).toBeInTheDocument();
  });

  it("keeps a prompt when a project is missing or submission fails", async () => {
    const api = { threads: { create: vi.fn().mockResolvedValue({ thread: { id: "created", turns: [] } }) }, turns: { start: vi.fn().mockRejectedValue(new Error("Provider disconnected")) } };
    const rendered = harness({ prompt: "Keep my draft" }, api);
    await waitFor(() => expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("Choose a project");
    expect(api.threads.create).not.toHaveBeenCalled();
    changeEditable(screen.getByLabelText("Agent project"), { target: { value: "project" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText("Provider disconnected");
    expect(screen.getByLabelText("Ask canvas agent")).toHaveEditableValue("Keep my draft");
    expect(rendered.onChange).toHaveBeenCalledWith({ threadId: "created", projectId: "project" });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(api.turns.start).toHaveBeenCalledTimes(2));
    expect(api.threads.create).toHaveBeenCalledTimes(1);
  });

  it("uses a saved thread for follow-ups, honors defaults, and ignores other threads", async () => {
    let receive;
    const api = {
      threads: { create: vi.fn(), read: vi.fn().mockResolvedValue({ thread: { id: "existing", turns: [] } }) },
      turns: { start: vi.fn().mockResolvedValue({ turn: { id: "turn", status: "inProgress", items: [] } }) },
      events: { subscribe: callback => { receive = callback; return () => {}; } }
    };
    harness({ threadId: "existing", projectId: "project", prompt: "Follow up" }, api);
    await waitFor(() => expect(api.threads.read).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(screen.getByLabelText("Ask canvas agent")).toHaveEditableValue(""));
    expect(api.threads.create).not.toHaveBeenCalled();
    expect(api.turns.start).toHaveBeenCalledWith(expect.objectContaining({ threadId: "existing", model: "model", effort: "low", permissionMode: "read-only" }));
    act(() => receive({ type: "Notification", payload: { method: "item/completed", projectId: "project", threadId: "other", turnId: "turn", item: { id: "wrong", type: "agentMessage", text: "Other thread response" } } }));
    expect(screen.queryByText("Other thread response")).toBeNull();
    act(() => receive({ type: "Notification", payload: { method: "item/completed", projectId: "project", threadId: "existing", turnId: "turn", item: { id: "right", type: "agentMessage", phase: "final_answer", text: "Canvas answer" } } }));
    expect(screen.getByText("Canvas answer")).toBeVisible();
    expect(screen.getByRole("button", { name: "Keep as a note" })).toBeVisible();
  });
});
