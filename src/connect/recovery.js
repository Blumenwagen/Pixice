export const CONNECT_RECOVERY_STORAGE_KEY = 'pixice.connect.recovery';
export const CONNECT_RECOVERY_MAX_ITEMS = 100;
export const CONNECT_RECOVERY_TTL_MS = 24 * 60 * 60 * 1000;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~:@/-]{0,255}$/;

function boundedIdentifier(value) {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value) ? value : null;
}

export function recoveryRecordKey(record) {
  return JSON.stringify([
    record?.hostId ?? '',
    record?.deviceId ?? '',
    record?.commandId ?? '',
    record?.backendInstanceId ?? ''
  ]);
}

export function sanitizeRecoveryRecord(value, fallback = {}) {
  const source = { ...fallback, ...(value ?? {}) };
  const hostId = boundedIdentifier(source.hostId);
  const deviceId = boundedIdentifier(source.deviceId);
  const commandId = boundedIdentifier(source.commandId ?? source.id);
  const backendInstanceId = boundedIdentifier(source.backendInstanceId ?? source.instanceId);
  const operation = boundedIdentifier(source.operation);
  const issuedAt = Number(source.issuedAt);
  if (!hostId || !deviceId || !commandId || !backendInstanceId || !operation || !Number.isFinite(issuedAt)) return null;
  const record = { hostId, deviceId, commandId, backendInstanceId, operation, issuedAt };
  const projectId = boundedIdentifier(source.projectId);
  const threadId = boundedIdentifier(source.threadId);
  const originHostId = boundedIdentifier(source.originHostId ?? source.originHost);
  const originProjectId = boundedIdentifier(source.originProjectId ?? source.originProject);
  if (projectId) record.projectId = projectId;
  if (threadId) record.threadId = threadId;
  if (originHostId) record.originHostId = originHostId;
  if (originProjectId) record.originProjectId = originProjectId;
  record.key = recoveryRecordKey(record);
  return record;
}

export function loadRecoveryRecords(storage = globalThis.localStorage, now = Date.now()) {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(CONNECT_RECOVERY_STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    const unique = new Map();
    for (const value of parsed) {
      const record = sanitizeRecoveryRecord(value);
      if (!record || record.issuedAt > now + 5 * 60_000 || now - record.issuedAt > CONNECT_RECOVERY_TTL_MS) continue;
      unique.set(recoveryRecordKey(record), record);
    }
    return [...unique.values()].sort((left, right) => right.issuedAt - left.issuedAt).slice(0, CONNECT_RECOVERY_MAX_ITEMS);
  } catch {
    return [];
  }
}

export function saveRecoveryRecords(records, storage = globalThis.localStorage, now = Date.now()) {
  if (!storage) return [];
  const unique = new Map();
  for (const value of records ?? []) {
    const record = sanitizeRecoveryRecord(value);
    if (!record || record.issuedAt > now + 5 * 60_000 || now - record.issuedAt > CONNECT_RECOVERY_TTL_MS) continue;
    unique.set(recoveryRecordKey(record), record);
  }
  const safe = [...unique.values()].sort((left, right) => right.issuedAt - left.issuedAt).slice(0, CONNECT_RECOVERY_MAX_ITEMS);
  try { storage.setItem(CONNECT_RECOVERY_STORAGE_KEY, JSON.stringify(safe)); } catch { /* Recovery is best effort when storage is unavailable. */ }
  return safe;
}
