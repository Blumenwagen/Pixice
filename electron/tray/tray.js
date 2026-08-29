const previewParams = new URLSearchParams(window.location.search);
const previewMode = previewParams.has("preview");
const previewState = {
  activeTurns: 2,
  keepSystemAwake: true,
  appearance: {
    accentColor: previewParams.get("accent") || "coral",
    reduceTransparency: previewParams.get("opaque") === "true"
  },
  appIconDataUrl: "/src/assets/pixice-icon.png",
  fetchedAt: new Date().toISOString(),
  cost: { currentWeekUsd: 18.42, allTimeUsd: 164.87 },
  providers: [
    { id: "codex", label: "Codex", planType: "Pro", status: "available", weekly: { label: "Weekly", remainingPercent: 68, resetsAt: Date.now() / 1000 + 3.4 * 86_400 } },
    { id: "claude", label: "Claude", planType: "Max", status: "available", weekly: { label: "Weekly", remainingPercent: 31, resetsAt: Date.now() / 1000 + 1.6 * 86_400 } }
  ],
  unreadThreads: 1,
  workItems: [
    { id: "thread-active-1", turnId: "turn-1", title: "Status bar work overview", projectName: "Pixice", provider: "codex", status: "active", progress: { completed: 2, total: 4, percent: 50, label: "2 of 4 steps" } },
    { id: "thread-active-2", turnId: "turn-2", title: "Release checks and packaging", projectName: "Pixice", provider: "claude", status: "active", progress: { completed: 0, total: 0, percent: null, label: "Working" } },
    { id: "thread-unread-1", turnId: null, title: "Review Studio polish", projectName: "Pixice", provider: "codex", status: "unread", progress: { completed: 3, total: 3, percent: 100, label: "Completed" } }
  ]
};
const api = window.pixiceTray ?? (previewMode ? {
  action: async (action, value) => {
    if (action === "resize" && window.frameElement) {
      const height = Math.max(180, Math.min(620, Math.round(Number(value) || 480)));
      window.frameElement.style.height = `${height}px`;
    }
    return previewState;
  },
  subscribe: (listener) => { listener(previewState); return () => {}; }
} : null);
if (!api) throw new Error("Pixice tray bridge is unavailable");
const elements = {
  popover: document.querySelector("#popover"),
  summaryView: document.querySelector("#summary-view"),
  workView: document.querySelector("#work-view"),
  appIcon: document.querySelector("#app-icon"),
  activityLabel: document.querySelector("#activity-label"),
  activeCount: document.querySelector("#active-count"),
  activeDetail: document.querySelector("#active-detail"),
  liveDot: document.querySelector("#live-dot"),
  providers: document.querySelector("#providers"),
  updatedAt: document.querySelector("#updated-at"),
  weekCost: document.querySelector("#week-cost"),
  totalCost: document.querySelector("#total-cost"),
  keepAwake: document.querySelector("#keep-awake"),
  refresh: document.querySelector("#refresh"),
  unreadBadge: document.querySelector("#unread-badge"),
  workSummary: document.querySelector("#work-summary"),
  workList: document.querySelector("#work-list")
};
let currentState = previewMode ? previewState : { activeTurns: 0, unreadThreads: 0, providers: [], workItems: [], cost: {} };
let currentView = "summary";
let composingThreadId = previewMode ? previewParams.get("compose") : null;
const followUpDrafts = new Map();
const followUpErrors = new Map();
const queuedThreads = new Set();

function currency(value) {
  const digits = value >= 100 ? 0 : 2;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value || 0);
}

function relativeReset(epochSeconds) {
  if (!epochSeconds) return "Reset time unavailable";
  const remainingMinutes = Math.max(0, Math.round((epochSeconds * 1000 - Date.now()) / 60_000));
  if (remainingMinutes < 60) return `Resets in ${remainingMinutes}m`;
  const hours = Math.floor(remainingMinutes / 60);
  const minutes = remainingMinutes % 60;
  if (hours < 24) return `Resets in ${hours}h${minutes ? ` ${minutes}m` : ""}`;
  const days = Math.floor(hours / 24);
  return `Resets in ${days}d ${hours % 24}h`;
}

function updatedLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Live provider allowance";
  return `Updated ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

function providerRow(provider) {
  const row = document.createElement("article");
  row.className = "provider-row";
  if (provider.status !== "available" || !provider.weekly) {
    const copy = document.createElement("div");
    copy.className = "provider-copy";
    const title = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = provider.label;
    title.append(name);
    if (provider.planType) {
      const plan = document.createElement("em");
      plan.textContent = provider.planType;
      title.append(plan);
    }
    copy.append(title);
    row.append(copy);
    const unavailable = document.createElement("div");
    unavailable.className = "provider-unavailable";
    unavailable.textContent = provider.message;
    row.append(unavailable);
    return row;
  }

  const remaining = provider.weekly.remainingPercent;
  const percent = remaining === null ? 0 : Math.round(remaining);
  const copy = document.createElement("div");
  copy.className = "provider-copy";
  const title = document.createElement("span");
  const name = document.createElement("strong");
  name.textContent = provider.label;
  title.append(name);
  if (provider.planType) {
    const plan = document.createElement("em");
    plan.textContent = provider.planType;
    title.append(plan);
  }
  const value = document.createElement("b");
  value.textContent = remaining === null ? "Unknown" : `${percent}% left`;
  value.className = provider.weekly.reached || percent <= 10 ? "critical" : percent <= 25 ? "low" : "";
  copy.append(title, value);

  const track = document.createElement("div");
  track.className = "limit-track";
  track.setAttribute("role", "progressbar");
  track.setAttribute("aria-label", `${provider.label} weekly limit remaining`);
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", "100");
  if (remaining !== null) track.setAttribute("aria-valuenow", String(percent));
  const fill = document.createElement("i");
  fill.style.width = `${percent}%`;
  track.append(fill);

  const meta = document.createElement("div");
  meta.className = "provider-meta";
  const windowLabel = document.createElement("small");
  windowLabel.textContent = provider.weekly.label;
  const reset = document.createElement("small");
  reset.textContent = relativeReset(provider.weekly.resetsAt);
  meta.append(windowLabel, reset);
  row.append(copy, track, meta);
  return row;
}

function requestResize() {
  window.requestAnimationFrame(() => {
    const height = Math.ceil(elements.popover.getBoundingClientRect().height);
    api.action("resize", height).catch(() => {});
  });
}

function providerName(provider) {
  return provider === "claude" ? "Claude" : provider === "codex" ? "Codex" : provider;
}

function workItemRow(item) {
  const article = document.createElement("article");
  article.className = "work-item";
  article.dataset.status = item.status;

  const heading = document.createElement("div");
  heading.className = "work-item-heading";
  const title = document.createElement("div");
  title.className = "work-item-title";
  const name = document.createElement("strong");
  name.textContent = item.title;
  name.title = item.title;
  const status = document.createElement("em");
  status.className = `thread-status ${item.status}`;
  status.textContent = item.status === "active" ? "Active" : "Unread";
  title.append(name, status);
  heading.append(title);

  const meta = document.createElement("small");
  meta.className = "work-item-meta";
  meta.textContent = `${item.projectName} · ${providerName(item.provider)}`;

  const progress = document.createElement("div");
  progress.className = "work-progress";
  const progressCopy = document.createElement("div");
  progressCopy.className = "work-progress-copy";
  const progressLabel = document.createElement("small");
  progressLabel.textContent = item.status === "unread" ? "Finished" : "Progress";
  const progressValue = document.createElement("small");
  progressValue.textContent = item.progress?.label ?? "Working";
  progressCopy.append(progressLabel, progressValue);
  const progressTrack = document.createElement("div");
  progressTrack.className = "work-progress-track";
  progressTrack.setAttribute("role", "progressbar");
  progressTrack.setAttribute("aria-label", `${item.title} progress`);
  progressTrack.setAttribute("aria-valuemin", "0");
  progressTrack.setAttribute("aria-valuemax", "100");
  const progressFill = document.createElement("i");
  if (item.progress?.percent === null || item.progress?.percent === undefined) {
    progressFill.className = "indeterminate";
  } else {
    progressTrack.setAttribute("aria-valuenow", String(item.progress.percent));
    progressFill.style.width = `${item.progress.percent}%`;
  }
  progressTrack.append(progressFill);
  progress.append(progressCopy, progressTrack);

  const actions = document.createElement("div");
  actions.className = "work-actions";
  if (queuedThreads.has(item.id)) {
    const queued = document.createElement("span");
    queued.className = "queued-note";
    queued.textContent = "Follow-up queued";
    actions.append(queued);
  }
  const open = document.createElement("button");
  open.className = "work-action";
  open.type = "button";
  open.textContent = "Open";
  open.addEventListener("click", () => api.action("open-thread", { threadId: item.id }));
  actions.append(open);
  if (item.status === "active" && composingThreadId !== item.id) {
    const followUp = document.createElement("button");
    followUp.className = "work-action follow-up";
    followUp.type = "button";
    followUp.textContent = "Follow up";
    followUp.addEventListener("click", () => {
      composingThreadId = item.id;
      followUpErrors.delete(item.id);
      renderWorkItems(currentState);
      requestResize();
      if (composingThreadId === item.id) window.requestAnimationFrame(() => elements.workList.querySelector("textarea[data-composer]")?.focus());
    });
    actions.append(followUp);
  }

  article.append(heading, meta, progress, actions);
  if (composingThreadId === item.id && item.status === "active") article.append(followUpForm(item));
  return article;
}

function followUpForm(item) {
  const form = document.createElement("form");
  form.className = "follow-up-form";
  const input = document.createElement("textarea");
  input.dataset.composer = item.id;
  input.rows = 2;
  input.maxLength = 100_000;
  input.placeholder = "Queue the next message…";
  input.value = followUpDrafts.get(item.id) ?? "";
  input.addEventListener("input", () => followUpDrafts.set(item.id, input.value));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  const footer = document.createElement("div");
  footer.className = "follow-up-actions";
  const error = document.createElement("small");
  error.textContent = followUpErrors.get(item.id) ?? "";
  const buttons = document.createElement("span");
  const cancel = document.createElement("button");
  cancel.className = "work-action";
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => {
    composingThreadId = null;
    followUpErrors.delete(item.id);
    renderWorkItems(currentState);
    requestResize();
  });
  const send = document.createElement("button");
  send.className = "work-action follow-up";
  send.type = "submit";
  send.textContent = "Queue";
  buttons.append(cancel, send);
  footer.append(error, buttons);
  form.append(input, footer);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) {
      followUpErrors.set(item.id, "Write a message first.");
      error.textContent = followUpErrors.get(item.id);
      return;
    }
    input.disabled = true;
    send.disabled = true;
    send.textContent = "Queueing";
    try {
      await api.action("follow-up", { threadId: item.id, text });
      followUpDrafts.delete(item.id);
      followUpErrors.delete(item.id);
      queuedThreads.add(item.id);
      composingThreadId = null;
      renderWorkItems(currentState);
      requestResize();
      window.setTimeout(() => {
        queuedThreads.delete(item.id);
        if (currentView === "work") renderWorkItems(currentState);
      }, 3000);
    } catch (cause) {
      input.disabled = false;
      send.disabled = false;
      send.textContent = "Queue";
      followUpErrors.set(item.id, cause?.message || "The follow-up could not be queued.");
      error.textContent = followUpErrors.get(item.id);
    }
  });
  return form;
}

function renderWorkItems(state) {
  const active = state.workItems?.filter((item) => item.status === "active").length ?? 0;
  const unread = state.workItems?.filter((item) => item.status === "unread").length ?? 0;
  elements.workSummary.textContent = [
    active ? `${active} active` : null,
    unread ? `${unread} unread` : null
  ].filter(Boolean).join(" · ") || "Nothing needs attention";
  elements.workList.replaceChildren();
  if (!state.workItems?.length) {
    const empty = document.createElement("div");
    empty.className = "work-empty";
    const title = document.createElement("strong");
    title.textContent = "All quiet";
    const detail = document.createElement("small");
    detail.textContent = "Active and newly finished threads will appear here.";
    empty.append(title, detail);
    elements.workList.append(empty);
    return;
  }
  elements.workList.append(...state.workItems.map(workItemRow));
}

function setTrayView(view) {
  currentView = view;
  elements.popover.dataset.view = view;
  elements.summaryView.hidden = view !== "summary";
  elements.workView.hidden = view !== "work";
  if (view === "work") renderWorkItems(currentState);
  requestResize();
}

function render(state) {
  if (!state) return;
  currentState = state;
  document.documentElement.dataset.accentColor = state.appearance?.accentColor ?? "coral";
  document.documentElement.dataset.reduceTransparency = String(state.appearance?.reduceTransparency === true);
  if (state.appIconDataUrl) elements.appIcon.src = state.appIconDataUrl;
  const active = state.activeTurns || 0;
  const unread = state.unreadThreads || 0;
  elements.activityLabel.textContent = active
    ? `${active} active turn${active === 1 ? "" : "s"}`
    : unread ? `${unread} unread thread${unread === 1 ? "" : "s"}` : "Ready when you are";
  elements.activeCount.textContent = active ? `${active} active turn${active === 1 ? "" : "s"}` : "No active turns";
  elements.activeDetail.textContent = unread
    ? `${unread} finished, unread`
    : active ? "View progress and follow up" : "Pixice is standing by";
  elements.liveDot.classList.toggle("active", active > 0 || unread > 0);
  elements.unreadBadge.hidden = unread === 0;
  elements.unreadBadge.textContent = String(unread);
  elements.unreadBadge.title = `${unread} unread thread${unread === 1 ? "" : "s"}`;
  elements.weekCost.textContent = currency(state.cost?.currentWeekUsd);
  elements.totalCost.textContent = currency(state.cost?.allTimeUsd);
  elements.keepAwake.checked = state.keepSystemAwake === true;
  elements.updatedAt.textContent = updatedLabel(state.fetchedAt);
  elements.refresh.dataset.loading = "false";
  elements.refresh.textContent = "Refresh";

  elements.providers.replaceChildren();
  if (!state.providers?.length) {
    const empty = document.createElement("div");
    empty.className = "empty-providers";
    const title = document.createElement("strong");
    title.textContent = "No provider allowance yet";
    const detail = document.createElement("small");
    detail.textContent = "Sign in to Codex or Claude in Pixice to see live weekly limits here.";
    empty.append(title, detail);
    elements.providers.append(empty);
  } else {
    elements.providers.append(...state.providers.map(providerRow));
  }
  if (currentView === "work") renderWorkItems(state);
  requestResize();
}

api.subscribe(render);
document.querySelector("#open-pixice").addEventListener("click", () => api.action("open"));
document.querySelector("#open-active").addEventListener("click", () => setTrayView("work"));
document.querySelector("#open-usage").addEventListener("click", () => api.action("usage"));
document.querySelector("#quit").addEventListener("click", () => api.action("quit"));
document.querySelector("#work-back").addEventListener("click", () => setTrayView("summary"));
document.querySelector("#open-all-work").addEventListener("click", () => api.action("open"));
elements.keepAwake.addEventListener("change", () => api.action("keep-awake", elements.keepAwake.checked));
elements.refresh.addEventListener("click", () => {
  elements.refresh.dataset.loading = "true";
  elements.refresh.textContent = "Checking";
  api.action("refresh").catch(() => {
    elements.refresh.dataset.loading = "false";
    elements.refresh.textContent = "Refresh";
  });
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (composingThreadId) {
    composingThreadId = null;
    renderWorkItems(currentState);
    requestResize();
  } else if (currentView === "work") {
    setTrayView("summary");
  } else {
    api.action("dismiss");
  }
});
if (previewMode && previewParams.get("view") === "work") setTrayView("work");
