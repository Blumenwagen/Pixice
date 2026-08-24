import { threadStatus, threadTitle } from "../../state/runtime.js";

export const THREAD_CLEANUP_AGE_DAYS = 30;
export const THREAD_CLEANUP_MIN_DAYS = 1;
export const THREAD_CLEANUP_MAX_DAYS = 3650;
const DAY_MS = 24 * 60 * 60 * 1000;

export function normalizeThreadCleanupAgeDays(value) {
  const days = Number(value);
  return Number.isInteger(days) && days >= THREAD_CLEANUP_MIN_DAYS && days <= THREAD_CLEANUP_MAX_DAYS
    ? days
    : THREAD_CLEANUP_AGE_DAYS;
}

function timestampMillis(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return 0;
    return Math.abs(value) < 1_000_000_000_000 ? value * 1000 : value;
  }
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function cleanupStatusLabel(task) {
  const status = String(threadStatus(task)).toLowerCase();
  if (status === "completed") return "Finished";
  if (status === "failed") return "Failed";
  if (status === "interrupted" || status === "cancelled") return "Stopped";
  return "Idle";
}

function inactivityLabel(days) {
  if (days < 60) return `${days} days ago`;
  if (days < 365) {
    const months = Math.floor(days / 30);
    return `${months} month${months === 1 ? "" : "s"} ago`;
  }
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

export function getCleanupCandidates({ tasks, selectedThreadId, protectedThreadIds = [], ageDays = THREAD_CLEANUP_AGE_DAYS, now = Date.now() }) {
  const protectedIds = new Set(protectedThreadIds);
  const cleanupAgeDays = normalizeThreadCleanupAgeDays(ageDays);
  const oldestAllowed = now - cleanupAgeDays * DAY_MS;
  return (tasks ?? [])
    .filter((task) => {
      if (!task?.id || task.id === selectedThreadId || protectedIds.has(task.id)) return false;
      const status = String(threadStatus(task)).toLowerCase();
      if (["active", "running", "inprogress", "attention"].includes(status)) return false;
      const lastUsedAt = timestampMillis(task.updatedAt ?? task.createdAt);
      return lastUsedAt > 0 && lastUsedAt <= oldestAllowed;
    })
    .map((task) => {
      const lastUsedAt = timestampMillis(task.updatedAt ?? task.createdAt);
      const daysInactive = Math.max(cleanupAgeDays, Math.floor((now - lastUsedAt) / DAY_MS));
      const title = threadTitle(task);
      const preview = String(task.preview ?? "").trim();
      return {
        id: task.id,
        title,
        preview: preview && preview !== title ? preview : "",
        lastUsedAt,
        daysInactive,
        detail: `${cleanupStatusLabel(task)} · Last used ${inactivityLabel(daysInactive)}`
      };
    })
    .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
}
