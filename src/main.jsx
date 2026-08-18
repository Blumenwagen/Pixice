import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import "./styles.css";

if (import.meta.env.DEV && new URLSearchParams(window.location.search).has("task-progress-preview")) {
  const { createTaskProgressPreviewApi } = await import("./task-progress-preview.js");
  window.loom = createTaskProgressPreviewApi();
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
