import { cachedUsage, cacheUsage, rememberedLocalUsageIdentity } from './usage-cache.js';
import { requestJson } from './client.js';
import { normalizeEndpoint, PROTOCOL_VERSION } from '../../electron/connect/protocol.mjs';

const TOTAL_KEYS = ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens', 'costUsd', 'events', 'unpricedEvents', 'unpricedTokens'];
const STAT_KEYS = ['todayCostUsd', 'currentWeekCostUsd', 'currentMonthCostUsd', 'projectedMonthCostUsd', 'allTimeCostUsd', 'allTimeTokens'];
const number = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
const sum = (rows, keys) => Object.fromEntries(keys.map((key) => [key, rows.reduce((total, row) => total + number(row?.[key]), 0)]));

export function validateUsageSummary(value) {
  if (!value?.stats || !value?.selected || !Array.isArray(value.daily) || !Array.isArray(value.models)
    || !['allTimeCostUsd', 'allTimeTokens', 'currentMonthCostUsd'].every((key) => typeof value.stats[key] === 'number' && Number.isFinite(value.stats[key]) && value.stats[key] >= 0)
    || !['costUsd', 'totalTokens'].every((key) => typeof value.selected[key] === 'number' && Number.isFinite(value.selected[key]) && value.selected[key] >= 0)) {
    throw new Error('This instance did not return a compatible usage summary. Update Pixice on the host.');
  }
  for (const key of ['daily', 'heatmapDaily', 'models', 'providers', 'historyDailyModels']) {
    if (value[key] === undefined) continue;
    if (!Array.isArray(value[key]) || value[key].some((row) => !row || typeof row !== 'object'
      || TOTAL_KEYS.some((field) => row[field] !== undefined && (typeof row[field] !== 'number' || !Number.isFinite(row[field]) || row[field] < 0))
      || (['daily', 'heatmapDaily', 'historyDailyModels'].includes(key) && !/^\d{4}-\d{2}-\d{2}$/.test(row.date)))) {
      throw new Error('This instance returned invalid usage history. Its saved snapshot has been kept.');
    }
  }
  return value;
}

function group(rows, keyOf, identity) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].map((items) => ({ ...identity(items[0]), ...sum(items, TOTAL_KEYS) }));
}

function dateInZone(now, timeZone) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map(({ type, value }) => [type, value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  } catch { return now.toISOString().slice(0, 10); }
}
const dayTime = (date) => Date.parse(`${date}T00:00:00Z`);
const dayKey = (time) => new Date(time).toISOString().slice(0, 10);

// Calendar ranges advance even while a host is offline. Cached history is measured
// usage as of the last sync, never an estimate of work performed since then.
export function projectUsageSnapshot(snapshot, days, now = new Date()) {
  const data = validateUsageSummary(snapshot.summary);
  const today = dateInZone(now, data.calendarTimeZone);
  const todayTime = dayTime(today);
  const rangeStart = dayKey(todayTime - (days - 1) * 86_400_000);
  const weekStart = dayKey(todayTime - ((new Date(todayTime).getUTCDay() + 6) % 7) * 86_400_000);
  const monthStart = today.slice(0, 7) + '-01';
  const history = Array.isArray(data.historyDailyModels) ? data.historyDailyModels : null;
  const source = (history ?? data.heatmapDaily ?? data.daily).filter((row) => row.date <= today);
  const byDate = new Map(group(source, (row) => row.date, (row) => ({ date: row.date })).map((row) => [row.date, row]));
  const series = (count) => Array.from({ length: count }, (_, index) => {
    const date = dayKey(todayTime - (count - index - 1) * 86_400_000);
    return byDate.get(date) ?? { date, ...sum([], TOTAL_KEYS) };
  });
  const selectedRows = source.filter((row) => row.date >= rangeStart);
  const currentMonthCostUsd = sum(source.filter((row) => row.date >= monthStart), TOTAL_KEYS).costUsd;
  const started = data.recordingStartDate ?? data.recordingStartedAt?.slice(0, 10);
  const trackingDays = started ? Math.max(1, Math.round((todayTime - dayTime(started)) / 86_400_000) + 1) : 1;
  const dailyAverage = data.stats.allTimeCostUsd / trackingDays;
  const sameRange = data.rangeDays === days && (data.calendarDate ?? dateInZone(new Date(snapshot.checkedAt), data.calendarTimeZone)) === today;
  const models = history ? group(selectedRows, (row) => JSON.stringify([row.provider, row.model]), (row) => ({ provider: row.provider, model: row.model })) : sameRange ? data.models : [];
  return {
    ...data, rangeDays: days, trackingDays,
    stats: { ...data.stats,
      todayCostUsd: byDate.get(today)?.costUsd ?? 0,
      currentWeekCostUsd: sum(source.filter((row) => row.date >= weekStart), TOTAL_KEYS).costUsd,
      currentMonthCostUsd,
      projectedMonthCostUsd: currentMonthCostUsd / Number(today.slice(8)) * new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate(),
      dailyAverageCostUsd: dailyAverage, weeklyAverageCostUsd: dailyAverage * 7, monthlyAverageCostUsd: dailyAverage * (365.25 / 12)
    },
    selected: history || !sameRange ? sum(selectedRows, TOTAL_KEYS) : data.selected,
    daily: series(days), heatmapDaily: series(365), models,
    providers: history ? group(selectedRows, (row) => row.provider, (row) => ({ provider: row.provider })) : [],
    modelHistoryUnavailable: !history && !sameRange
  };
}

// Last-known snapshots continue contributing while a host is unreachable.
export function combineUsage(entries, days) {
  const unique = [...new Map(entries.filter((entry) => entry.summary).map((entry) => [entry.id, entry])).values()];
  if (!unique.length) return null;
  const summaries = unique.map((entry) => entry.summary);
  const stats = sum(summaries.map((item) => item.stats), STAT_KEYS);
  const dates = summaries.map((item) => item.recordingStartedAt).filter((date) => date && Number.isFinite(Date.parse(date))).sort();
  const updated = summaries.map((item) => item.updatedAt).filter(Boolean).sort();
  const trackingDays = Math.max(1, ...summaries.map((item) => {
    if (item.trackingDays) return number(item.trackingDays);
    // Older hosts do not report the tracking span. Their own average uses this denominator.
    return item.stats.dailyAverageCostUsd > 0 ? Math.round(item.stats.allTimeCostUsd / item.stats.dailyAverageCostUsd) : 1;
  }));
  stats.dailyAverageCostUsd = stats.allTimeCostUsd / trackingDays;
  stats.weeklyAverageCostUsd = stats.dailyAverageCostUsd * 7;
  stats.monthlyAverageCostUsd = stats.dailyAverageCostUsd * (365.25 / 12);
  const byDate = (rows) => group(rows, (row) => row.date, (row) => ({ date: row.date })).sort((a, b) => a.date.localeCompare(b.date));
  const byModel = (rows, providerOnly = false) => group(rows, (row) => JSON.stringify([row.provider, providerOnly ? null : row.model]), (row) => ({ provider: row.provider, ...(!providerOnly ? { model: row.model } : {}) })).sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);
  const pricing = new Map();
  for (const item of summaries) for (const rate of item.pricing ?? []) {
    const key = JSON.stringify([rate.provider, rate.model]);
    const next = { ...rate, verifiedAt: rate.verifiedAt ?? item.pricingVerifiedAt };
    if (!pricing.has(key) || (next.verifiedAt ?? '') > (pricing.get(key).verifiedAt ?? '')) pricing.set(key, next);
  }
  return {
    rangeDays: days, trackingDays, recordingStartedAt: dates[0] ?? null, updatedAt: updated.at(-1) ?? null,
    stats, selected: sum(summaries.map((item) => item.selected), TOTAL_KEYS),
    daily: byDate(summaries.flatMap((item) => item.daily)),
    heatmapDaily: byDate(summaries.flatMap((item) => item.heatmapDaily ?? item.daily)),
    models: byModel(summaries.flatMap((item) => item.models)),
    providers: byModel(summaries.flatMap((item) => item.providers ?? []), true),
    modelHistoryUnavailable: summaries.some((item) => item.modelHistoryUnavailable),
    pricing: [...pricing.values()]
  };
}

function bounded(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

// Read-only snapshots: no workspace switch, agent bootstrap, event stream, or command retry.
export async function readInstanceUsage(instance, days, signal) {
  const endpoint = normalizeEndpoint(instance.endpoint);
  const info = await requestJson(endpoint, 'info', { signal });
  if (info.hostId !== instance.id) throw new Error('Host identity changed. Pair this instance again.');
  if (info.protocol !== PROTOCOL_VERSION) throw new Error('Update this instance to a compatible Pixice version.');
  const read = async (operation, payload) => (await requestJson(endpoint, 'call', {
    token: instance.token, signal,
    body: { operation, payload, id: crypto.randomUUID(), issuedAt: Date.now(), instanceId: info.instanceId }
  })).result;
  const [summary, limits] = await Promise.allSettled([read('usage.summary', { days }).then(validateUsageSummary), read('usage.limits')]);
  if (summary.status === 'rejected') throw summary.reason;
  return { summary: summary.value, limits: limits.status === 'fulfilled' ? limits.value : null, limitsError: limits.status === 'rejected' ? limits.reason.message : null };
}

export async function collectUnifiedUsage({ instances, localApi, days, signal, onEntries }) {
  const scopedSignal = () => AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
  let localIdentity = localApi?.usage ? rememberedLocalUsageIdentity() : undefined;
  let identityError;
  if (localApi?.usage) {
    try { localIdentity = localApi.connect?.status ? await bounded(localApi.connect.status(), scopedSignal()) : { hostId: 'local', name: 'This device' }; }
    catch (error) { identityError = error; }
    if (localIdentity && !identityError) rememberedLocalUsageIdentity(localIdentity);
  }
  if (signal.aborted) return;
  const unique = [...new Map(instances.map((instance) => [instance.id, instance])).values()].filter((instance) => instance.id !== localIdentity?.hostId);
  // A remembered local identity also deduplicates a self-connection during a local outage.
  let entries = [
    ...(localApi?.usage ? [{ id: localIdentity?.hostId ?? 'local', name: localIdentity?.name ?? 'This device', local: true, status: identityError ? 'unavailable' : 'loading', error: identityError ? 'Could not reach this device’s connection service.' : null }] : []),
    ...unique.map(({ id, name, endpoint }) => ({ id, name, endpoint, status: 'loading' }))
  ];
  const withCached = (entry) => {
    const snapshot = cachedUsage(entry.id, days);
    if (!snapshot) return entry;
    try {
      return { ...snapshot, ...entry, summary: projectUsageSnapshot(snapshot, days), cached: true };
    } catch { return entry; }
  };
  entries = entries.map(withCached);
  onEntries(entries);
  const update = (id, patch) => { if (!signal.aborted) { entries = entries.map((entry) => entry.id === id ? { ...entry, ...patch } : entry); onEntries(entries); } };
  await Promise.allSettled(entries.filter((entry) => entry.status === 'loading').map(async (entry) => {
    try {
      const requestSignal = scopedSignal();
      let result;
      if (entry.local) {
        const [summary, limits] = await Promise.allSettled([
          bounded(localApi.usage.summary({ days }), requestSignal).then(validateUsageSummary),
          bounded(localApi.usage.limits?.(), requestSignal)
        ]);
        if (summary.status === 'rejected') throw summary.reason;
        result = { summary: summary.value, limits: limits.status === 'fulfilled' ? limits.value : null, limitsError: limits.status === 'rejected' ? limits.reason.message : null };
      } else result = await readInstanceUsage(unique.find((instance) => instance.id === entry.id), days, requestSignal);
      if (signal.aborted) return;
      const snapshot = { ...result, checkedAt: Date.now() };
      const projected = projectUsageSnapshot(snapshot, days);
      const persisted = cacheUsage(entry.id, days, snapshot);
      update(entry.id, { ...snapshot, summary: projected, status: 'online', cached: false, cacheError: persisted ? null : 'Snapshot kept for this session only; browser storage is full or unavailable.' });
    } catch (error) {
      update(entry.id, { status: error.status === 401 ? 'unauthorized' : 'unavailable', error: error.name === 'TimeoutError' ? 'This instance did not respond in time.' : error.name === 'TypeError' ? 'Could not reach this instance.' : error.message });
    }
  }));
}
