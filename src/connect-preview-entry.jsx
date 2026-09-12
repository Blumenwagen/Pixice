import React from "react";
import { createRoot } from "react-dom/client";
import { ConnectPreview } from "./connect-preview.jsx";

if (import.meta.env.DEV) {
  const fixture = ConnectPreview.installFixture(window);
  const root = createRoot(document.getElementById("root"));
  root.render(<React.StrictMode><ConnectPreview fixture={fixture} /></React.StrictMode>);
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      root.unmount();
      if (window.__pixiceConnectFixture === fixture) fixture.restore();
    });
  }
} else {
  document.getElementById("root").textContent = "This preview is available only in Vite development mode.";
}
