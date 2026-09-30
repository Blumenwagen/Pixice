import React from "react";
import { createRoot } from "react-dom/client";

async function mountRenderer() {
  const companionRoot = new URLSearchParams(window.location.search).has("voice-companion");
  if (companionRoot) {
    const { CompanionApp } = await import("./voice/CompanionApp.jsx");
    createRoot(document.getElementById("root")).render(<CompanionApp />);
  } else {
    const [{ ConnectRoot }, { App }, { WorkflowHost }, { TaskPreviewHost }, { RendererErrorBoundary }, { registerRootConnectServiceWorker }] = await Promise.all([
      import("./connect/ConnectRoot.jsx"), import("./App.jsx"), import("./components/workflows/WorkflowHost.jsx"), import("./components/TaskPreviewHost.jsx"), import("./components/RendererErrorBoundary.jsx"), import("./connect/push-pwa.js"),
      import("./styles.css"), import("./components/workflows/WorkflowHost.css")
    ]);

    if (import.meta.env.PROD) void registerRootConnectServiceWorker();

    const legacyStoragePrefix = ["lo", "om."].join("");
    for (let index = 0; index < localStorage.length; index += 1) {
      const legacyKey = localStorage.key(index);
      if (!legacyKey?.startsWith(legacyStoragePrefix)) continue;
      const pixiceKey = `pixice.${legacyKey.slice(legacyStoragePrefix.length)}`;
      if (localStorage.getItem(pixiceKey) === null) localStorage.setItem(pixiceKey, localStorage.getItem(legacyKey));
    }

    const previewParameters = new URLSearchParams(window.location.search);
    if (import.meta.env.DEV && previewParameters.has("focus-v2-preview")) {
      const accent = previewParameters.get("accent") ?? "coral";
      if (["coral", "rose", "amber", "green", "teal", "blue", "violet", "graphite"].includes(accent)) {
        try {
          const current = JSON.parse(localStorage.getItem("pixice.preferences") ?? "{}");
          localStorage.setItem("pixice.preferences", JSON.stringify({ ...current, accentColor: accent }));
        } catch { localStorage.setItem("pixice.preferences", JSON.stringify({ accentColor: accent })); }
      }
    }
    if (import.meta.env.DEV && previewParameters.has("task-results-preview")) {
      const { createTaskResultsPreviewApi } = await import("./task-results-preview.js");
      window.pixice = await createTaskResultsPreviewApi();
    }
    if (import.meta.env.DEV && (previewParameters.has("task-progress-preview") || previewParameters.has("focus-preview") || previewParameters.has("focus-v2-preview") || previewParameters.has("focus-idle-preview") || previewParameters.has("git-setup-preview") || previewParameters.has("operation-capsule-preview"))) {
      const { createTaskProgressPreviewApi } = await import("./task-progress-preview.js");
      window.pixice = createTaskProgressPreviewApi({
        focusPreview: previewParameters.has("focus-preview") || previewParameters.has("focus-v2-preview"),
        focusV2Preview: previewParameters.has("focus-v2-preview"),
        focusIdlePreview: previewParameters.has("focus-idle-preview"),
        gitUnavailable: previewParameters.has("git-setup-preview"),
        updatePreview: previewParameters.has("operation-capsule-preview")
      });
    }

    if (import.meta.env.DEV && previewParameters.has("devday-preview") && window.pixice) {
      const { withDevDayPreview } = await import("./devday-preview.js");
      window.pixice = withDevDayPreview(window.pixice);
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
  }
}

void mountRenderer().catch((error) => {
  console.error(error);
  if (window.pixiceVoiceCompanion) void window.pixiceVoiceCompanion.report({ phase: "error", error: "Voice could not load. Return to Pixice and try again." }).catch(() => {});
});
