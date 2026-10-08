import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PullRequestService, normalizePullRequest, parsePullRequestUrl } from "../electron/github/pull-request-service.mjs";

const execFile = promisify(execFileCallback), directories = [];
const url = "https://github.com/acme/project/pull/42", scope = { projectId: "project", threadId: "thread" };
const raw = () => ({ number: 42, url, title: "Ship the change", body: "Reviewable change", state: "OPEN", isDraft: true, author: { login: "me" }, baseRefName: "main", headRefName: "codex/change", headRefOid: "a".repeat(40), mergeable: "MERGEABLE", statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }], comments: [], reviews: [], files: [{ path: "src/app.js", additions: 4, deletions: 2 }], commits: [] });
function fixture({ context = {}, output } = {}) {
  let saved;
  const gh = { execute: vi.fn(async (args) => {
    if (output) { const result = await output(args); if (result) return result; }
    if (args[0] === "pr" && args[1] === "view") return { stdout: JSON.stringify(raw()) };
    if (args[0] === "api" && args[1] === "user") return { stdout: '{"login":"me"}' };
    if (args[0] === "api" && args[1].includes("comments")) return { stdout: "[[]]" };
    if (args[0] === "api" && args[1] === "graphql") return { stdout: JSON.stringify({ data: { repository: { pullRequest: { headRefOid: "a".repeat(40), commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS", isRequired: true }], pageInfo: { hasNextPage: false } } } } }] } } } } }) };
    if (args[0] === "repo") return { stdout: '{"nameWithOwner":"acme/project","defaultBranchRef":{"name":"main"}}' };
    return { stdout: "", stderr: "" };
  }) };
  const runGit = vi.fn(async (_binary, args) => {
    if (args[0] === "status") return { stdout: " M app.js\0?? notes.md\0", stderr: "" };
    if (args[0] === "rev-parse") return { stdout: "", stderr: "" };
    if (args[0] === "branch") return { stdout: "codex/change\n", stderr: "" };
    if (args[0] === "rev-list") return { stdout: "2\t0\n", stderr: "" };
    return { stdout: "committed", stderr: "" };
  });
  const service = new PullRequestService({ githubCli: gh, resolveContext: async () => ({ ...scope, cwd: "/work/project", permissionMode: "workspace-write", ...context }),
    saveState: (state) => { saved = state; }, runGit, gitExecutablePath: "/usr/bin/git", now: () => Date.parse("2026-10-08T12:00:00Z") });
  return { service, gh, runGit, saved: () => saved };
}
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

describe("native pull request delivery", () => {
  it("normalizes cloud PR identities and rejects foreign URLs and injected paths", () => {
    expect(parsePullRequestUrl(`${url}?check=1`)).toMatchObject({ repo: "acme/project", number: 42, url, key: "acme/project#42" });
    for (const value of ["file:///etc/passwd", "https://github.com.evil.test/acme/project/pull/42", "https://user@github.com/acme/project/pull/42", "http://github.com/acme/project/pull/42", "https://github.com/acme/project/issues/42"]) expect(() => parsePullRequestUrl(value)).toThrow();
  });
  it("reads checks, reviews and inline comments with required-job status and no credentials", async () => {
    const { service } = fixture({ output: (args) => args[0] === "api" && args[1].includes("comments") ? { stdout: JSON.stringify([[{ id: 11, user: { login: "reviewer" }, body: "Please fix this", path: "src/app.js", created_at: "2026-10-08T12:01:00Z", updated_at: "2026-10-08T12:02:00Z" }]]) } : null });
    const detail = await service.read({ ...scope, reference: url });
    expect(detail.checks).toEqual([{ name: "test", status: "success", required: true, url: null }]);
    expect(detail.inlineComments[0]).toMatchObject({ id: "11", author: { login: "reviewer" }, editedAt: "2026-10-08T12:02:00Z", path: "src/app.js" });
    expect(detail.viewer).toBe("me"); expect(detail.activityComplete).toBe(true); expect(detail).not.toHaveProperty("token");
  });
  it("refuses cross-project reads, read-only writes and watches owned by subagents", async () => {
    const foreign = fixture({ context: { projectId: "another" } });
    await expect(foreign.service.read({ ...scope, reference: url })).rejects.toThrow("does not belong");
    expect(foreign.gh.execute).not.toHaveBeenCalled();
    const readOnly = fixture({ context: { permissionMode: "read-only" } });
    await expect(readOnly.service.commit({ ...scope, message: "Update", paths: ["app.js"] })).rejects.toThrow("read-only");
    await expect(readOnly.service.update({ ...scope, url, action: "comment", body: "Hi" })).rejects.toThrow("read-only");
    const unknownMode = fixture({ context: { permissionMode: undefined } });
    await expect(unknownMode.service.push(scope)).rejects.toThrow("read-only");
    expect(unknownMode.runGit).not.toHaveBeenCalled();
    const child = fixture({ context: { parentThreadId: "parent" } });
    await expect(child.service.watch({ ...scope, reference: url })).rejects.toThrow("parent chat");
  });
  it("links once, persists project/thread scope, restores watches and stops on unlink", async () => {
    const { service, saved } = fixture();
    await service.link({ ...scope, reference: url }); await service.link({ ...scope, reference: "42" });
    const watch = await service.watch({ ...scope, reference: url });
    expect(saved().links).toHaveLength(1); expect(saved().watches).toHaveLength(1); expect(watch.cursor.passed).toBe(true);
    const restored = new PullRequestService({ githubCli: service.github, resolveContext: service.resolveContext, loadState: saved });
    expect(restored.watchRecords()).toHaveLength(1);
    await service.unlink({ ...scope, url });
    expect(service.links(scope)).toEqual([]); expect(service.watchRecords()).toHaveLength(0); expect(saved().watches[0].stoppedReason).toBe("stopped");
  });
  it("commits only the selected paths, rejects traversal and uses literal pathspecs", async () => {
    const { service, runGit } = fixture();
    await service.commit({ ...scope, message: "Keep `literal` $(text)", paths: ["app.js", ":(glob)literal.txt"] });
    expect(runGit).toHaveBeenCalledWith("/usr/bin/git", ["--literal-pathspecs", "add", "--", "app.js", ":(glob)literal.txt"], expect.anything());
    expect(runGit).toHaveBeenCalledWith("/usr/bin/git", ["--literal-pathspecs", "commit", "--only", "-m", "Keep `literal` $(text)", "--", "app.js", ":(glob)literal.txt"], expect.anything());
    for (const file of ["../secret", "/etc/passwd", "nested/../../secret", "."]) await expect(service.commit({ ...scope, message: "No", paths: [file] })).rejects.toThrow("outside");
  });
  it("keeps unrelated staged edits intact when committing a selected new file in a subproject", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pixice-native-pr-git-")); directories.push(directory);
    const git = (args, cwd = directory) => execFile("git", args, { cwd, encoding: "utf8" });
    await git(["init", "-q"]); await git(["config", "user.email", "tests@example.test"]); await git(["config", "user.name", "Tests"]);
    await writeFile(path.join(directory, "unrelated.txt"), "original\n"); await mkdir(path.join(directory, "app")); await writeFile(path.join(directory, "app", "existing.txt"), "existing\n");
    await git(["add", "."]); await git(["commit", "-qm", "Initial"]);
    await writeFile(path.join(directory, "unrelated.txt"), "staged separately\n"); await git(["add", "unrelated.txt"]);
    await writeFile(path.join(directory, "app", "new.txt"), "selected\n");
    const { gh } = fixture();
    const service = new PullRequestService({ githubCli: gh, resolveContext: async () => ({ ...scope, cwd: path.join(directory, "app"), permissionMode: "workspace-write" }), gitExecutablePath: "git" });
    expect((await service.workspace(scope)).files).toEqual([{ path: "new.txt", status: "??" }]);
    await service.commit({ ...scope, paths: ["new.txt"], message: "Selected new file" });
    expect((await git(["show", "--pretty=", "--name-only", "HEAD"])).stdout.trim()).toBe("app/new.txt");
    expect((await git(["diff", "--cached", "--name-only"])).stdout.trim()).toBe("unrelated.txt");
  });
  it("pushes the actual chat branch without force or remote side effects in tests", async () => {
    const { service, runGit } = fixture(); await service.push(scope);
    expect(runGit).toHaveBeenCalledWith("/usr/bin/git", ["push", "--set-upstream", "origin", "HEAD:refs/heads/codex/change"], expect.objectContaining({ timeout: 120_000 }));
  });
  it("creates a draft from a temporary body file, preserving literal newlines and linking it", async () => {
    let file, content;
    const { service, gh } = fixture({ output: async (args) => {
      if (args[0] === "pr" && args[1] === "create") { file = args[args.indexOf("--body-file") + 1]; content = await readFile(file, "utf8"); return { stdout: `${url}\n` }; }
    } });
    const result = await service.create({ ...scope, title: "Change", body: "First\n\nLiteral `code` and $(text)", base: "main" });
    expect(content).toBe("First\n\nLiteral `code` and $(text)"); expect(result.detail.url).toBe(url); expect(service.links(scope)).toHaveLength(1);
    expect(gh.execute.mock.calls.find(([args]) => args[1] === "create")[0]).toContain("--draft");
    await expect(readFile(file, "utf8")).rejects.toThrow();
  });
  it("guards merges against the reviewed head commit and never automatically retries mutations", async () => {
    const { service, gh } = fixture();
    await expect(service.update({ ...scope, url, action: "merge", method: "squash" })).rejects.toThrow("Refresh and confirm");
    await service.update({ ...scope, url, action: "merge", method: "squash", expectedHeadSha: "a".repeat(40) });
    expect(gh.execute).toHaveBeenCalledWith(["pr", "merge", url, "--squash", "--match-head-commit", "a".repeat(40)], expect.anything());
  });
  it("retains a successfully created attachment when its follow-up read fails", async () => {
    const { service, gh } = fixture({ output: (args) => {
      if (args[0] === "pr" && args[1] === "create") return { stdout: `${url}\n` };
      if (args[0] === "pr" && args[1] === "view") throw new Error("Network went away");
    } });
    const result = await service.create({ ...scope, title: "Change", body: "Ready", base: "main" });
    expect(result.detail.url).toBe(url); expect(result.warning).toContain("created and linked"); expect(service.links(scope)).toHaveLength(1);
    expect(gh.execute.mock.calls.filter(([args]) => args[1] === "create")).toHaveLength(1);
  });
  it("reports successful posting when only its refresh fails, without retrying the write", async () => {
    let posted = false;
    const { service, gh } = fixture({ output: (args) => {
      if (args[0] === "pr" && args[1] === "comment") { posted = true; return { stdout: "Posted" }; }
      if (posted && args[0] === "pr" && args[1] === "view") throw new Error("Network went away");
    } });
    const result = await service.update({ ...scope, url, action: "comment", body: "Reviewed the change" });
    expect(result.url).toBe(url); expect(result.warning).toContain("action completed");
    expect(gh.execute.mock.calls.filter(([args]) => args[1] === "comment")).toHaveLength(1);
  });
  it("never treats unavailable required-check metadata as checks passing", async () => {
    const { service } = fixture({ output: (args) => { if (args[0] === "api" && args[1] === "graphql") throw new Error("Required check metadata unavailable"); } });
    const detail = await service.read({ ...scope, reference: url });
    expect(detail.checksComplete).toBe(false); expect(detail.checks).toContainEqual({ name: "Check status could not be fully verified", status: "pending", required: true, url: null });
  });
  it("isolates malformed saved attachments and repairs missing legacy cursor fields", () => {
    const { service: original } = fixture();
    const startedAt = "2026-10-08T12:00:00Z";
    const service = new PullRequestService({ githubCli: original.github, resolveContext: original.resolveContext, loadState: () => ({ version: 1,
      links: [{ ...scope, url: "file:///etc/passwd" }, { ...scope, url }], watches: [{ ...scope, id: "legacy", url, startedAt, active: true, cursor: { remarksThrough: "invalid" } }] }) });
    expect(service.links(scope)).toHaveLength(1); expect(service.watchRecords()[0].cursor).toMatchObject({ remarksThrough: startedAt, failedChecks: [], passedChecks: [], remarkIds: [], wakes: 0 });
  });
  it("keeps pending checks pending and treats cancelled/action-required checks as failures", () => {
    const detail = normalizePullRequest({ ...raw(), statusCheckRollup: [{ context: "pending", state: "PENDING" }, { name: "approval", conclusion: "ACTION_REQUIRED" }, { name: "cancel", conclusion: "CANCELLED" }] });
    expect(detail.checks.map((check) => check.status)).toEqual(["pending", "action-required", "cancelled"]);
  });
});
