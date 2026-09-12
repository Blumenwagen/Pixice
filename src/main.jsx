import React from "react";
import { ConnectRoot } from "./connect/ConnectRoot.jsx";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import { WorkflowHost } from "./components/workflows/WorkflowHost.jsx";
import { TaskPreviewHost } from "./components/TaskPreviewHost.jsx";
import { RendererErrorBoundary } from "./components/RendererErrorBoundary.jsx";
import { registerRootConnectServiceWorker } from "./connect/push-pwa.js";
import "./styles.css";
import "./components/workflows/WorkflowHost.css";

if (import.meta.env.PROD) void registerRootConnectServiceWorker();

const legacyStoragePrefix = ["lo", "om."].join("");
for (let index = 0; index < localStorage.length; index += 1) {
  const legacyKey = localStorage.key(index);
  if (!legacyKey?.startsWith(legacyStoragePrefix)) continue;
  const pixiceKey = `pixice.${legacyKey.slice(legacyStoragePrefix.length)}`;
  if (localStorage.getItem(pixiceKey) === null) localStorage.setItem(pixiceKey, localStorage.getItem(legacyKey));
}

const previewParameters = new URLSearchParams(window.location.search);
if (import.meta.env.DEV && previewParameters.has("task-results-preview")) {
  const { createTaskResultsPreviewApi } = await import("./task-results-preview.js");
  window.pixice = await createTaskResultsPreviewApi();
}
if (import.meta.env.DEV && (previewParameters.has("task-progress-preview") || previewParameters.has("git-setup-preview"))) {
  const { createTaskProgressPreviewApi } = await import("./task-progress-preview.js");
  window.pixice = createTaskProgressPreviewApi({ gitUnavailable: previewParameters.has("git-setup-preview") });
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <RendererErrorBoundary>
      <ConnectRoot>
      <WorkflowHost>
        <TaskPreviewHost>
          <App />
        </TaskPreviewHost>
      </WorkflowHost>
      </ConnectRoot>
    </RendererErrorBoundary>
  </React.StrictMode>,
);
