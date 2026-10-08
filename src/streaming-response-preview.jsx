import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MarkdownMessage, WorkingTrace } from "./App.jsx";
import "./styles.css";

const response = "Gentle cascade is now the streaming treatment for assistant replies. New words sharpen into place while the words you've already read stay still.\n\n## The details stay intact\n\n- **Formatted text** keeps its hierarchy.\n- Lists arrive without replaying earlier lines.\n- Code such as `const ready = true` stays readable.\n\nThe animation uses a light blur, a small upward settle, and a short stagger. It respects reduced motion and leaves completed conversations still.";

function Preview() {
  const [run, setRun] = useState(0);
  const [text, setText] = useState("");
  const [reduced, setReduced] = useState(false);
  const active = text.length < response.length;
  const replay = () => { setText(""); setRun((value) => value + 1); };
  useEffect(() => {
    let position = 0;
    let timer;
    const start = window.setTimeout(() => {
      timer = window.setInterval(() => {
        position = Math.min(response.length, position + 7);
        setText(response.slice(0, position));
        if (position === response.length) window.clearInterval(timer);
      }, 120);
    }, 500);
    return () => { window.clearTimeout(start); window.clearInterval(timer); };
  }, [run]);
  return <main className="pixice-app" data-reduce-motion={reduced} style={{ display: "block", height: "100%", padding: "40px 32px", overflow: "auto", background: "#242424" }}>
    <section style={{ maxWidth: 760, margin: "0 auto" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 34, gap: 24 }}>
        <div><p style={{ color: "var(--quiet)", fontSize: 12, margin: "0 0 8px" }}>Pixice / Selected treatment</p><h1 style={{ fontSize: 25, fontWeight: 550, margin: 0, letterSpacing: "-.03em" }}>Gentle cascade</h1></div>
        <button type="button" className="settings-action" onClick={replay}>Replay response</button>
      </header>
      <div className="user-message" style={{ marginBottom: 36, width: "fit-content" }}>Use Gentle cascade for streaming text.</div>
      <article className="message assistant-message final_answer" style={{ minHeight: 370 }}>
        <MarkdownMessage key={run} text={text} streaming={active} />
      </article>
      <section style={{ borderTop: "1px solid var(--border)", marginTop: 30, paddingTop: 24 }}>
        <p style={{ fontSize: 11, color: "var(--quiet)", margin: "0 0 14px" }}>Live commentary uses the same treatment</p>
        <WorkingTrace key={`trace-${run}`} items={[{ id: "commentary", type: "agentMessage", text: text.slice(0, 156) }]} running={active} settled={!active} defaultDisclosure="expanded" />
      </section>
      <footer style={{ display: "flex", justifyContent: "space-between", marginTop: 32, color: "var(--quiet)", fontSize: 12 }}>
        <span>{active ? "Streaming" : "Complete"}</span>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}><input type="checkbox" checked={reduced} onChange={(event) => setReduced(event.target.checked)} />Reduce motion</label>
      </footer>
    </section>
  </main>;
}

createRoot(document.getElementById("root")).render(<Preview />);
