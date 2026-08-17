import React from "react";
import { createRoot } from "react-dom/client";
import { ReasoningOrb, REASONING_ORB_VARIANTS } from "./components/ReasoningOrb.jsx";
import "./styles.css";

function Preview() {
  return (
    <main style={{ minHeight: "100vh", padding: 48, color: "var(--foreground)", background: "var(--canvas)" }}>
      <section style={{ width: 620, padding: 28, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 20 }}>
        <p style={{ margin: "0 0 18px", color: "var(--quiet)", fontSize: 11, fontWeight: 700, letterSpacing: ".12em", textTransform: "uppercase" }}>Reasoning lattice</p>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 28 }}>
          <ReasoningOrb size={20} decorative />
          <strong style={{ fontSize: 12 }}>Thinking</strong>
          <span style={{ color: "var(--quiet)", fontSize: 11 }}>random morph</span>
          <ReasoningOrb size={20} label="Reasoning…" pill />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 12 }}>
          {REASONING_ORB_VARIANTS.map((variant) => (
            <div key={variant} style={{ padding: "16px 12px 12px", display: "grid", placeItems: "center", gap: 10, background: "var(--stage)", borderRadius: 12 }}>
              <ReasoningOrb variant={variant} size={28} decorative />
              <span style={{ color: "var(--quiet)", font: "10px 'JetBrains Mono Variable', monospace" }}>{variant}</span>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("preview-root")).render(<Preview />);
