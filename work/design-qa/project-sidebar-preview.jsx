import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Sidebar } from "../../src/App.jsx";
import { ProjectCreationDialog } from "../../src/components/sidebar/ProjectSwitcher.jsx";
import "../../src/styles.css";

const PROJECTS = [
  { id: "loom", displayName: "Loom", icon: "code", color: "pink", lastUsedAt: "2026-08-22T12:09:00.000Z", canonicalPath: "/work/loom", folders: ["/work/loom"] },
  { id: "studio", displayName: "Studio", icon: "sparkles", color: "purple", lastUsedAt: "2026-08-22T12:08:00.000Z", canonicalPath: "/work/studio", folders: ["/work/studio", "/work/shared"] },
  { id: "terminal", displayName: "Tooling", icon: "terminal", color: "green", lastUsedAt: "2026-08-22T12:07:00.000Z", canonicalPath: "/work/tooling", folders: ["/work/tooling"] },
  { id: "web", displayName: "Website", icon: "globe", color: "blue", lastUsedAt: "2026-08-22T12:06:00.000Z", canonicalPath: "/work/website", folders: ["/work/website"] },
  { id: "research", displayName: "Research", icon: "stack", color: "orange", lastUsedAt: "2026-08-22T12:05:00.000Z", canonicalPath: "/work/research", folders: ["/work/research"] },
  { id: "atlas", displayName: "Atlas", icon: "globe", color: "teal", lastUsedAt: "2026-08-22T12:04:00.000Z", canonicalPath: "/work/atlas", folders: ["/work/atlas"] },
  { id: "metrics", displayName: "Metrics", icon: "chart", color: "indigo", lastUsedAt: "2026-08-22T12:03:00.000Z", canonicalPath: "/work/metrics", folders: ["/work/metrics"] },
  { id: "vault", displayName: "Vault", icon: "lock", color: "amber", lastUsedAt: "2026-08-22T12:02:00.000Z", canonicalPath: "/work/vault", folders: ["/work/vault"] },
  { id: "automations", displayName: "Automations", icon: "workflow", color: "rose", lastUsedAt: "2026-08-22T12:01:00.000Z", canonicalPath: "/work/automations", folders: ["/work/automations"] }
];

const THREADS = {
  loom: [
    { id: "thread-1", name: "Rework project navigation", status: { type: "idle" } },
    { id: "thread-2", name: "Multi-folder persistence", status: { type: "inProgress" } },
    { id: "thread-3", name: "Sidebar visual review", status: { type: "idle" } }
  ],
  studio: [{ id: "thread-4", name: "Create launch visuals", status: { type: "idle" } }],
  terminal: [],
  web: [{ id: "thread-5", name: "Polish landing page", status: { type: "idle" } }],
  research: [{ id: "thread-6", name: "Summarize interviews", status: { type: "idle" } }],
  atlas: [{ id: "thread-7", name: "Map deployment regions", status: { type: "idle" } }],
  metrics: [{ id: "thread-8", name: "Review activation funnel", status: { type: "idle" } }],
  vault: [],
  automations: [{ id: "thread-9", name: "Run weekly triage", status: { type: "idle" } }]
};

const PROJECT_ACTIVITY = {
  loom: { runningThreadIds: ["thread-2"], unseenThreadIds: [] },
  studio: { runningThreadIds: ["studio-live-1", "studio-live-2"], unseenThreadIds: ["studio-done-1"] },
  terminal: { runningThreadIds: [], unseenThreadIds: ["tooling-done-1", "tooling-done-2"] },
  metrics: { runningThreadIds: ["metrics-live-1"], unseenThreadIds: [] }
};

function previewRecency(project) {
  const timestamp = Date.parse(project.lastUsedAt ?? project.updatedAt ?? project.createdAt ?? "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function activatePreviewProject(projects, projectId, recentProjectLimit) {
  const selectedIndex = projects.findIndex((project) => project.id === projectId);
  if (selectedIndex < 0) return projects;
  const next = projects.map((project, index) => index === selectedIndex
    ? { ...project, lastUsedAt: new Date(Math.max(...projects.map(previewRecency)) + 1_000).toISOString() }
    : project);
  if (selectedIndex < recentProjectLimit) return next;
  let leastRecentVisibleIndex = 0;
  for (let index = 1; index < recentProjectLimit; index += 1) {
    if (previewRecency(next[index]) <= previewRecency(next[leastRecentVisibleIndex])) leastRecentVisibleIndex = index;
  }
  [next[leastRecentVisibleIndex], next[selectedIndex]] = [next[selectedIndex], next[leastRecentVisibleIndex]];
  return next;
}

function SidebarPreview() {
  const previewParams = new URLSearchParams(window.location.search);
  const tooltipProjectId = previewParams.get("tooltip");
  const tooltipProject = PROJECTS.find((project) => project.id === tooltipProjectId);
  const legacySidebar = previewParams.get("legacy") === "1";
  const recentProjectLimit = previewParams.get("thirdRow") === "1" ? 9 : 6;
  const [selectedProjectId, setSelectedProjectId] = useState("loom");
  const [projects, setProjects] = useState(PROJECTS);
  const [selectedThreadId, setSelectedThreadId] = useState("thread-1");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [expanded, setExpanded] = useState(previewParams.get("collapsed") !== "1");
  const [width, setWidth] = useState(280);

  useEffect(() => {
    if (!tooltipProject) return undefined;
    const frame = window.requestAnimationFrame(() => {
      const button = [...document.querySelectorAll(".sidebar button")]
        .find((candidate) => candidate.getAttribute("aria-label") === tooltipProject.displayName);
      const tooltip = button?.querySelector('[role="tooltip"]');
      if (!button || !tooltip) return;
      button.parentElement.style.zIndex = "60";
      tooltip.style.opacity = "1";
      tooltip.style.transform = expanded ? "translate(-50%, 0)" : "translate(0, -50%)";
    });
    return () => window.cancelAnimationFrame(frame);
  }, [expanded, tooltipProject]);

  return (
    <div className="loom-stage">
      <div className="loom-app sidebar-design-preview" data-sidebar-expanded={expanded} style={{ "--sidebar-width": `${width}px` }}>
        <Sidebar
          projects={projects}
          projectActivity={PROJECT_ACTIVITY}
          selectedProjectId={selectedProjectId}
          onSelectProject={(projectId) => {
            setProjects((current) => activatePreviewProject(current, projectId, recentProjectLimit));
            setSelectedProjectId(projectId);
            setSelectedThreadId(THREADS[projectId]?.[0]?.id ?? null);
          }}
          tasks={THREADS[selectedProjectId] ?? []}
          selectedThreadId={selectedThreadId}
          onSelectThread={setSelectedThreadId}
          onDeleteThread={() => {}}
          onNewTask={() => setSelectedThreadId(null)}
          onOpenProject={() => setDialogOpen(true)}
          activeView="task"
          onView={() => {}}
          attentionCount={2}
          changedCount={7}
          runtime={{ connected: true }}
          legacySidebar={legacySidebar}
          recentProjectLimit={recentProjectLimit}
          onExpandedChange={setExpanded}
          width={width}
          onWidthChange={setWidth}
        />
        <main className="sidebar-preview-canvas" aria-label="Preview backdrop" />
      </div>
      <ProjectCreationDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onAddFolders={async () => ["/work/new-project", "/work/shared"]}
        onCreate={async () => setDialogOpen(false)}
      />
    </div>
  );
}

createRoot(document.getElementById("root")).render(<SidebarPreview />);
