import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { WorkingTrace } from "../../src/App.jsx";
import "../../src/styles.css";

const states = [
  [
    { id: "reasoning", type: "reasoning", summary: ["Comparing the local branch with its remote tracking branch"] }
  ],
  [
    { id: "reasoning", type: "reasoning", summary: ["Comparing the local branch with its remote tracking branch"] },
    { id: "command", type: "commandExecution", command: "git fetch origin main --prune", status: "inProgress" }
  ],
  [
    { id: "reasoning", type: "reasoning", summary: ["Comparing the local branch with its remote tracking branch"] },
    { id: "command", type: "commandExecution", command: "git fetch origin main --prune", status: "completed" },
    { id: "tool", type: "mcpToolCall", tool: "inspect_branch_history", server: "git", status: "running" }
  ],
  [
    { id: "reasoning", type: "reasoning", summary: ["Comparing the local branch with its remote tracking branch"] },
    { id: "command", type: "commandExecution", command: "git fetch origin main --prune", status: "completed" },
    { id: "tool", type: "mcpToolCall", tool: "inspect_branch_history", server: "git", status: "completed" },
    { id: "files", type: "fileChange", changes: [{ path: "src/App.jsx" }, { path: "src/styles.css" }], status: "inProgress" }
  ]
];

function Preview() {
  const [stateIndex, setStateIndex] = useState(0);
  const [runtimeErrorCount, setRuntimeErrorCount] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => setStateIndex((current) => (current + 1) % states.length), 1700);
    const diagnosticsTimer = window.setInterval(() => setRuntimeErrorCount(window.__workingTracePreviewErrors?.length ?? 0), 250);
    return () => {
      window.clearInterval(timer);
      window.clearInterval(diagnosticsTimer);
    };
  }, []);

  return (
    <main className="loom-stage" style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "var(--canvas)" }}>
      <section style={{ width: "min(920px, calc(100vw - 80px))", padding: "44px 54px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 18 }}>
        <p style={{ margin: "0 0 22px", color: "var(--muted)", fontSize: 14, lineHeight: 1.65 }}>
          I’ll compare local <code>main</code> with its remote tracking branch and summarize the changes.
        </p>
        <WorkingTrace items={states[stateIndex]} running settled={false} />
        <p style={{ margin: "20px 0 0", color: "var(--quiet)", fontSize: 10 }}>
          Live activity {stateIndex + 1} of {states.length}. The row advances automatically. Runtime diagnostics: {runtimeErrorCount === 0 ? "clear" : `${runtimeErrorCount} error${runtimeErrorCount === 1 ? "" : "s"}`}.
        </p>
      </section>
    </main>
  );
}

createRoot(document.getElementById("preview-root")).render(<Preview />);
