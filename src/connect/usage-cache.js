// Stored on the receiving device, separately from workspace drafts and connection credentials.
const KEY = 'pixice.connect.usage-snapshots';
let memory = null;
const empty = () => ({ version: 1, hosts: {} });
function read() {
  try {
    const text = localStorage.getItem(KEY);
    if (memory?.text === text) return memory.value;
    const parsed = JSON.parse(text || 'null');
    const value = parsed?.version === 1 && parsed.hosts && typeof parsed.hosts === 'object' && !Array.isArray(parsed.hosts) ? parsed : empty();
    memory = { text, value };
    return value;
  } catch { return memory?.value ?? empty(); }
}
function write(value) {
  memory = { text: memory?.text ?? null, value };
  try {
    const text = JSON.stringify(value);
    localStorage.setItem(KEY, text);
    memory.text = text;
    return true;
  } catch { return false; }
}
export function cachedUsage(id, days) {
  const host = read().hosts[id];
  return host?.latest?.summary?.historyDailyModels ? host.latest : host?.ranges?.[days] ?? host?.latest ?? null;
}
export function cacheUsage(id, days, snapshot) {
  const value = read();
  const previous = value.hosts[id] ?? {};
  const current = previous.latest;
  // A cancelled, older refresh must not overwrite a newer successful snapshot.
  if (current?.checkedAt > snapshot.checkedAt) return true;
  value.hosts[id] = { ...previous, latest: snapshot, ranges: Array.isArray(snapshot.summary.historyDailyModels) ? {} : { ...previous.ranges, [days]: snapshot } };
  return write(value);
}
export function forgetUsage(id) {
  const value = read();
  delete value.hosts[id];
  write(value);
}
export function rememberedLocalUsageIdentity(value) {
  const cache = read();
  if (value) { cache.localIdentity = { hostId: value.hostId, name: value.name }; write(cache); }
  return cache.localIdentity;
}
