import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import { WorkflowHost } from "./components/workflows/WorkflowHost.jsx";
import "./styles.css";
import "./components/workflows/WorkflowHost.css";

const previewParameters = new URLSearchParams(window.location.search);
if (import.meta.env.DEV && previewParameters.has("task-progress-preview")) {
  const { createTaskProgressPreviewApi } = await import("./task-progress-preview.js");
  window.loom = createTaskProgressPreviewApi();
} else if (import.meta.env.DEV && previewParameters.has("workflow-preview")) {
  const { createWorkflowPreviewApi } = await import("./workflow-preview-api.js");
  window.loom = createWorkflowPreviewApi();
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <WorkflowHost>
      <App />
    </WorkflowHost>
  </React.StrictMode>,
);
