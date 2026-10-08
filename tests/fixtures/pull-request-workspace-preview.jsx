import React from "react";
import { createRoot } from "react-dom/client";
import { PullRequestWorkspace } from "../../src/components/PullRequestWorkspace.jsx";
import "../../src/styles.css";

// Development-only browser fixture. All mutations are in-memory; no GitHub/Git writes.
const url = "https://github.com/example/project/pull/42";
const listeners = new Set();
const detail = { number: 42, url, title: "Keep request recovery reliable", body: "Requests now preserve their state when the connection changes.\n\nThe recovery path keeps the same conversation and draft while the service reconnects.", state: "open", isDraft: false,
  author: { login: "developer" }, viewer: "developer", baseBranch: "main", headBranch: "codex/request-recovery", headSha: "ab38f6b".padEnd(40, "1"), mergeability: "clean", updatedAt: "2026-10-08T08:00:00Z", reviewDecision: "REVIEW_REQUIRED",
  checks: [{ name: "Unit tests", status: "success", required: true }, { name: "Desktop build", status: "pending", required: true }, { name: "Code review", status: "success", required: false }],
  comments: [{ id: "one", body: "The recovery state is much clearer now. Could we also keep the existing draft when retrying?", author: { login: "reviewer" }, createdAt: "2026-10-08T08:30:00Z" }], reviews: [], inlineComments: [], files: [{ path: "src/connect/recovery.js", additions: 14, deletions: 3 }], commits: [], activityComplete: true };
const workspace = { projectId: "project", threadId: "thread", branch: "codex/request-recovery", files: [{ path: "src/connect/recovery.js", status: " M" }, { path: "tests/connect-recovery.test.js", status: " M" }], ahead: 2, behind: 0, repository: { nameWithOwner: "example/project", defaultBranchRef: { name: "main" } }, canWrite: true, canWatch: true,
  links: [{ url, number: 42, snapshot: { title: detail.title, state: "open" }, watch: { active: false } }] };
const emit = () => listeners.forEach((handler) => handler({ type: "PullRequestsUpdated", payload: { projectId: "project", threadId: "thread" } }));
const api = { events: { subscribe(handler) { listeners.add(handler); return () => listeners.delete(handler); } }, pullRequests: {
  workspace: async () => structuredClone(workspace), list: async () => [structuredClone(detail)], read: async () => structuredClone(detail),
  diff: async () => ({ diff: "diff --git a/src/connect/recovery.js b/src/connect/recovery.js\n--- a/src/connect/recovery.js\n+++ b/src/connect/recovery.js\n@@ -12,4 +12,6 @@\n export function recoverConversation(state) {\n-  return { ...state, draft: null };\n+  return { ...state, draft: state.draft,\n+    connection: 'reconnecting' };\n }\n" }),
  commit: async () => { workspace.files = []; workspace.ahead++; emit(); return { workspace }; }, push: async () => { workspace.ahead = 0; emit(); return { workspace }; },
  create: async ({ title, body, draft }) => { Object.assign(detail, { title, body, isDraft: draft }); emit(); return { detail }; },
  link: async () => ({ detail, links: workspace.links }), unlink: async () => { workspace.links = []; emit(); return { links: [] }; },
  watch: async () => { workspace.links[0].watch = { active: true }; emit(); return workspace.links[0].watch; }, stopWatch: async () => { workspace.links[0].watch.active = false; emit(); return { ok: true }; },
  update: async ({ action, title, body }) => { if (action === "draft" || action === "ready") detail.isDraft = action === "draft"; if (action === "edit") Object.assign(detail, { title, body }); emit(); return detail; }
} };
const params = new URLSearchParams(location.search);
createRoot(document.getElementById("root")).render(<div style={{ width: "100%", height: "100%", padding: 20, background: "#262729" }}><div style={{ height: "100%", border: "1px solid var(--border)", borderRadius: 14, overflow: "hidden", background: "var(--surface)" }}><PullRequestWorkspace api={api} projectId="project" threadId="thread" initialUrl={params.has("review") ? url : null} onOpenUrl={() => {}} /></div></div>);
