import { describe, expect, it, vi } from "vitest";
import { PullRequestWatchHost, evaluatePullRequestWatch } from "../electron/github/pull-request-watch-host.mjs";

const startedAt = "2026-10-08T12:00:00Z", url = "https://github.com/acme/project/pull/42";
const cursor = () => ({ startedAt, headSha: "head", failedChecks: [], passed: false, passedChecks: [], remarksThrough: startedAt, remarkIds: [], conflicting: false, wakes: 0 });
const detail = (patch = {}) => ({ number: 42, url, state: "open", headSha: "head", baseBranch: "main", viewer: "me", author: { login: "me" }, checks: [], mergeability: "clean", comments: [], reviews: [], inlineComments: [], activityComplete: true, ...patch });
const comment = (id, author = "reviewer", at = "2026-10-08T12:01:00Z", patch = {}) => ({ id, author: { login: author }, body: "Please fix the tests", createdAt: at, editedAt: at, path: null, ...patch });
const watch = (threadId = "thread") => ({ id: `${threadId}:acme/project#42`, projectId: "project", threadId, key: "acme/project#42", url, active: true, startedAt, cursor: cursor(), failures: 0, pauseUntil: null, pending: null });
function hostFixture({ watches = [watch()], read = detail(), fingerprint = "same", context = {}, enqueueWake = vi.fn(async () => true) } = {}) {
  const service = {
    state: { watches }, watchRecords() { return structuredClone(this.state.watches.filter((entry) => entry.active)); },
    setWatch(next) { this.state.watches = this.state.watches.map((entry) => entry.id === next.id ? structuredClone(next) : entry); },
    context: vi.fn(async () => context), fingerprint: vi.fn(async () => fingerprint), read: vi.fn(async () => read)
  };
  const host = new PullRequestWatchHost({ service, enqueueWake, now: () => Date.parse("2026-10-08T12:02:00Z") });
  return { host, service, enqueueWake };
}

describe("T3-reference PR watch change evaluation", () => {
  it("wakes promptly for individual failures and only passes the required gate", () => {
    const report = evaluatePullRequestWatch(cursor(), detail({ checks: [{ name: "test", status: "failure", required: true }, { name: "bot", status: "pending" }] }), []);
    expect(report.changes.map((change) => change.kind)).toEqual(["checks-failed"]);
    const done = evaluatePullRequestWatch(report.next, detail({ checks: [{ name: "test", status: "success", required: true }, { name: "bot", status: "pending" }] }), []);
    expect(done.changes).toEqual([{ kind: "checks-passed", count: 1, required: true }]);
    expect(evaluatePullRequestWatch(done.next, detail({ checks: [{ name: "test", status: "success", required: true }, { name: "bot", status: "pending" }] }), []).changes).toEqual([]);
  });
  it("suppresses own-account comments and detects edits and same-second different IDs", () => {
    const first = evaluatePullRequestWatch(cursor(), detail(), [comment("own", "ME"), comment("one")]);
    expect(first.changes[0].remarks.map((remark) => remark.id)).toEqual(["one"]);
    const next = evaluatePullRequestWatch(first.next, detail(), [comment("one"), comment("two")]);
    expect(next.changes[0].remarks.map((remark) => remark.id)).toEqual(["two"]);
    const edited = evaluatePullRequestWatch(next.next, detail(), [comment("one", "reviewer", "2026-10-08T12:01:00Z", { editedAt: "2026-10-08T12:02:00Z" })]);
    expect(edited.changes[0].remarks[0].id).toBe("one");
  });
  it("caps comment-only loops at ten and resets their count after progress", () => {
    const current = { ...cursor(), wakes: 9 };
    const report = evaluatePullRequestWatch(current, detail(), [comment("one")]);
    expect(report.exhausted).toBe(true); expect(report.next.wakes).toBe(10);
    const progress = evaluatePullRequestWatch(current, detail({ headSha: "new-head" }), [comment("one")]);
    expect(progress.exhausted).toBe(false); expect(progress.next.wakes).toBe(1);
  });
  it("does not clear a conflict on an unknown answer or repeat known failures", () => {
    const current = { ...cursor(), conflicting: true, failedChecks: ["test"] };
    const report = evaluatePullRequestWatch(current, detail({ mergeability: "unknown", checks: [{ name: "test", status: "failure" }] }), null);
    expect(report.changes).toEqual([]); expect(report.next.conflicting).toBe(true);
  });
});

describe("durable grouped PR watch host", () => {
  it("reads a shared PR once, wakes each owning chat once, and skips an unchanged fingerprint", async () => {
    const { host, service, enqueueWake } = hostFixture({ watches: [watch("one"), watch("two")], read: detail({ checks: [{ name: "test", status: "failure" }] }) });
    await host.sweep(); expect(service.read).toHaveBeenCalledTimes(1); expect(enqueueWake).toHaveBeenCalledTimes(2);
    expect(enqueueWake.mock.calls.map(([event]) => event.threadId)).toEqual(["one", "two"]);
    expect(enqueueWake.mock.calls[0][0].permissionMode).toBe("read-only");
    await host.sweep(); expect(service.read).toHaveBeenCalledTimes(1); expect(enqueueWake).toHaveBeenCalledTimes(2);
  });
  it("saves pending wakes before delivery and retries the same event ID after queue failure", async () => {
    const enqueueWake = vi.fn().mockRejectedValueOnce(new Error("Queue unavailable")).mockResolvedValue(true);
    const { host, service } = hostFixture({ read: detail({ mergeability: "conflicting" }), enqueueWake });
    await host.sweep(); const pending = service.state.watches[0].pending;
    expect(pending.eventId).toMatch(/^pr-watch:/); expect(service.state.watches[0].cursor.conflicting).toBe(true);
    await host.sweep(); expect(enqueueWake).toHaveBeenCalledTimes(2); expect(enqueueWake.mock.calls[1][0].eventId).toBe(pending.eventId); expect(service.state.watches[0].pending).toBeNull();
  });
  it("restores saved pending delivery after a process restart without a duplicate change wake", async () => {
    const first = hostFixture({ read: detail({ checks: [{ name: "test", status: "failure" }] }), enqueueWake: vi.fn(async () => false) });
    await first.host.sweep(); const saved = structuredClone(first.service.state.watches);
    const second = hostFixture({ watches: saved, read: detail({ checks: [{ name: "test", status: "failure" }] }) });
    await second.host.sweep(); expect(second.enqueueWake).toHaveBeenCalledTimes(1); expect(second.service.state.watches[0].pending).toBeNull();
  });
  it("stops on merged/closed/archived/subagent states without waking", async () => {
    for (const state of ["merged", "closed"]) {
      const { host, service, enqueueWake } = hostFixture({ read: detail({ state }) }); await host.sweep();
      expect(service.state.watches[0]).toMatchObject({ active: false, stoppedReason: state }); expect(enqueueWake).not.toHaveBeenCalled();
    }
    for (const context of [{ archived: true }, { parentThreadId: "parent" }, { settled: true }]) {
      const { host, service, enqueueWake } = hostFixture({ context }); await host.sweep();
      expect(service.state.watches[0].active).toBe(false); expect(service.read).not.toHaveBeenCalled(); expect(enqueueWake).not.toHaveBeenCalled();
    }
  });
  it("stops after eight failed reads and only pauses for rate limits", async () => {
    const failing = hostFixture(); failing.service.read.mockRejectedValue(new Error("Network unavailable"));
    for (let index = 0; index < 8; index++) await failing.host.sweep();
    expect(failing.service.state.watches[0]).toMatchObject({ active: false, failures: 8, stoppedReason: "unreadable" });
    const limited = hostFixture(); limited.service.fingerprint.mockRejectedValue(new Error("HTTP 429 API rate limit"));
    await limited.host.sweep(); expect(limited.service.state.watches[0]).toMatchObject({ active: true, failures: 0 });
    expect(limited.service.state.watches[0].pauseUntil).toBeGreaterThan(Date.parse("2026-10-08T12:02:00Z")); expect(limited.service.read).not.toHaveBeenCalled();
  });
  it("coalesces concurrent sweeps and keeps watches with in-flight checks refreshing", async () => {
    const { host, service } = hostFixture({ read: detail({ checks: [{ name: "test", status: "pending" }] }) });
    await Promise.all([host.sweep(), host.sweep(), host.sweep()]); expect(service.read).toHaveBeenCalledTimes(1);
    await host.sweep(); expect(service.read).toHaveBeenCalledTimes(2);
  });
  it("delivers the final allowed comment update before ending the watch", async () => {
    const current = watch(); current.cursor.wakes = 9;
    const { host, service, enqueueWake } = hostFixture({ watches: [current], read: detail({ comments: [comment("one")] }) });
    await host.sweep(); expect(enqueueWake).toHaveBeenCalledTimes(1); expect(service.state.watches[0]).toMatchObject({ active: false, stoppedReason: "comment-limit", pending: null });
  });
});
