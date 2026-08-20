import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import { WorkflowHost } from "./components/workflows/WorkflowHost.jsx";
import "./styles.css";
import "./components/workflows/WorkflowHost.css";

if (import.meta.env.DEV && new URLSearchParams(window.location.search).has("task-progress-preview")) {
  const { createTaskProgressPreviewApi } = await import("./task-progress-preview.js");
  window.loom = createTaskProgressPreviewApi();
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <WorkflowHost>
      <App />
    </WorkflowHost>
  </React.StrictMode>,
);
