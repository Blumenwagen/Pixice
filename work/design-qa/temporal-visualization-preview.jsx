import React from "react";
import { createRoot } from "react-dom/client";
import { InlineVisualization, parseVisualizationSpec } from "/src/components/InlineVisualization.jsx";
import "/src/styles.css";

const timeline = parseVisualizationSpec(JSON.stringify({
  version: 1,
  title: "Visualization release plan",
  description: "Use the team filter, inspect schedule details, and check how overlapping work packs into lanes.",
  controls: [{ id: "team", type: "segmented", label: "Team", value: "all", options: [{ label: "All", value: "all" }, { label: "Product", value: "product" }, { label: "Engineering", value: "engineering" }] }],
  metrics: [{ label: "On track", value: 78, format: "percent", detail: "3 blockers resolved" }, { label: "Milestones", value: 4, detail: "1 remaining" }],
  timeline: {
    title: "August delivery",
    start: "2026-08-01",
    end: "2026-09-05",
    today: "2026-08-25",
    groups: [{ id: "design", label: "Design" }, { id: "build", label: "Build" }, { id: "release", label: "Release" }],
    items: [
      { id: "model", label: "Temporal model", start: "2026-08-02", end: "2026-08-09", group: "design", status: "done", progress: 100, color: "green", owner: "Product", detail: "Lock the timeline and calendar contracts." },
      { id: "interactions", label: "Interaction pass", start: "2026-08-07", end: "2026-08-15", group: "design", status: "done", progress: 100, color: "purple", dependsOn: ["model"] },
      { id: "renderer", label: "Timeline renderer", start: "2026-08-10", end: "2026-08-27", group: "build", status: "active", progress: 72, color: "blue", owner: "Engineering", detail: "Pack overlaps, show milestones, and keep dense plans readable." },
      { id: "calendar", label: "Calendar renderer", start: "2026-08-16", end: "2026-08-30", group: "build", status: "active", progress: 58, color: "purple", owner: "Engineering" },
      { id: "a11y", label: "Keyboard and screen reader QA", start: "2026-08-24", end: "2026-09-01", group: "build", status: "blocked", progress: 35, color: "red", detail: "Waiting on the final event selection semantics." },
      { id: "release", label: "Ship native time views", start: "2026-09-03", group: "release", type: "milestone", status: "planned", color: "orange", dependsOn: ["renderer", "calendar", "a11y"] }
    ]
  },
  note: "Select any bar or milestone to see exact dates, ownership, notes, and dependencies."
}));

const calendar = parseVisualizationSpec(JSON.stringify({
  version: 1,
  title: "Launch calendar",
  description: "Move through months, inspect a day, or switch to the agenda when the grid gets dense.",
  calendar: {
    title: "August release schedule",
    date: "2026-08-25",
    today: "2026-08-25",
    weekStartsOn: 1,
    views: ["month", "agenda"],
    events: [
      { id: "beta", title: "Team beta", start: "2026-08-03", end: "2026-08-07", status: "done", color: "green", owner: "Product" },
      { id: "docs", title: "Docs sprint", start: "2026-08-10", end: "2026-08-14", status: "done", color: "blue", owner: "Docs" },
      { id: "qa", title: "QA window", start: "2026-08-19", end: "2026-08-26", status: "active", color: "purple", owner: "Engineering", detail: "Run native contract, interaction, and narrow-layout checks." },
      { id: "review", title: "Release review", start: "2026-08-25", status: "active", color: "orange", location: "Pixice Preview" },
      { id: "launch", title: "Public launch", start: "2026-08-31", status: "planned", color: "pink", owner: "Product", location: "Remote" }
    ]
  }
}));

function Preview() {
  return (
    <main className="temporal-qa-shell markdown-body">
      <InlineVisualization spec={timeline} />
      <InlineVisualization spec={calendar} />
    </main>
  );
}

const style = document.createElement("style");
style.textContent = `
  html, body, #root { min-height: 100%; }
  body { margin: 0; background: #202020; color: #f1f1f1; font-family: "Manrope Variable", system-ui, sans-serif; }
  .temporal-qa-shell { width: min(760px, calc(100% - 48px)); margin: 0 auto; padding: 48px 0 80px; display: grid; gap: 28px; }
`;
document.head.appendChild(style);

createRoot(document.getElementById("root")).render(<React.StrictMode><Preview /></React.StrictMode>);
