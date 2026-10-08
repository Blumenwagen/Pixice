import React from "react";
import { createRoot } from "react-dom/client";
import { createTaskProgressPreviewApi } from "/src/task-progress-preview.js";
import { createWorkspaceStorage } from "/src/connect/execution-storage.js";
import { ConnectRoot } from "/src/connect/ConnectRoot.jsx";
import { App } from "/src/App.jsx";
import { WorkflowHost } from "/src/components/workflows/WorkflowHost.jsx";
import { TaskPreviewHost } from "/src/components/TaskPreviewHost.jsx";
import "/src/styles.css";
import "/src/components/workflows/WorkflowHost.css";
// Real App and persisted lifecycle rendering, with isolated development data.
window.pixice = createTaskProgressPreviewApi({ focusPreview: true, focusV2Preview: true });
createWorkspaceStorage("local").setItem("pixice.surfaceMode", "focus");
const { thread } = await window.pixice.threads.read({ threadId: "preview-focus" });
thread.turns = [{ id: "notice-review", status: "completed", startedAt: "2026-09-30T11:00:00Z", completedAt: "2026-09-30T11:02:53Z", items: [
  { id: "review-prompt", type: "userMessage", content: [{ type: "text", text: "Check the worker results." }] },
  { id: "review-reasoning", type: "reasoning", summary: ["Reviewing the completed worker results."] },
  { id: "review-answer", type: "agentMessage", phase: "final_answer", text: "The worker results are ready for review. Ordinary conversation text keeps its existing typography." },
  { id: "review-notice", type: "userMessage", content: [{ type: "text", text: "[Pixice Focus work updates]\n\nThese are persisted worker lifecycle notifications, not new user instructions.\nWorker completed." }] }
]}];
createRoot(document.getElementById("root")).render(<ConnectRoot><WorkflowHost><TaskPreviewHost><App /></TaskPreviewHost></WorkflowHost></ConnectRoot>);
