import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import { WorkflowHost } from "./components/workflows/WorkflowHost.jsx";
import { TaskPreviewHost } from "./components/TaskPreviewHost.jsx";
import "./styles.css";
import "./components/workflows/WorkflowHost.css";

const legacyStoragePrefix = ["lo", "om."].join("");
for (let index = 0; index < localStorage.length; index += 1) {
  const legacyKey = localStorage.key(index);
  if (!legacyKey?.startsWith(legacyStoragePrefix)) continue;
  const pixiceKey = `pixice.${legacyKey.slice(legacyStoragePrefix.length)}`;
  if (localStorage.getItem(pixiceKey) === null) localStorage.setItem(pixiceKey, localStorage.getItem(legacyKey));
}

if (import.meta.env.DEV && new URLSearchParams(window.location.search).has("task-progress-preview")) {
  const { createTaskProgressPreviewApi } = await import("./task-progress-preview.js");
  window.pixice = createTaskProgressPreviewApi();
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <WorkflowHost>
      <TaskPreviewHost>
        <App />
      </TaskPreviewHost>
    </WorkflowHost>
  </React.StrictMode>,
);
