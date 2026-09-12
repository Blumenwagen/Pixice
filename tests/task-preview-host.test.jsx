import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskPreviewHost } from "../src/components/TaskPreviewHost.jsx";

afterEach(() => {
  delete window.pixice;
});

describe("TaskPreviewHost", () => {
  it("registers work items and plan proposals as ordinary Preview tabs", () => {
    window.pixice = { events: { subscribe: vi.fn(() => () => {}) } };
    const opened = vi.fn();
    window.addEventListener("pixice:open-preview-tab", opened);
    render(<TaskPreviewHost><div>Task shell</div></TaskPreviewHost>);

    act(() => window.dispatchEvent(new CustomEvent("pixice:task-preview-requested", { detail: {
      projectId: "project-1",
      workspaceId: "thread-1",
      taskId: "task-1",
      reason: "edit"
    } })));
    act(() => window.dispatchEvent(new CustomEvent("pixice:task-preview-requested", { detail: {
      projectId: "project-1",
      workspaceId: "thread-1",
      proposalId: "proposal-1",
      reason: "review"
    } })));

    expect(opened).toHaveBeenNthCalledWith(1, expect.objectContaining({ detail: {
      hostId: "local",
      workspaceId: "thread-1",
      tab: expect.objectContaining({ id: "local:task:task-1", kind: "task", title: "Work item" })
    } }));
    expect(opened).toHaveBeenNthCalledWith(2, expect.objectContaining({ detail: {
      hostId: "local",
      workspaceId: "thread-1",
      tab: expect.objectContaining({ id: "local:plan:proposal-1", kind: "plan", title: "Plan proposal" })
    } }));

    window.removeEventListener("pixice:open-preview-tab", opened);
  });
});
