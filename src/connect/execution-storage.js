export const LOCAL_EXECUTION_HOST = 'local';
const WORKSPACE_PREFIX = 'pixice.connect.workspace.';
const MIGRATION_VERSION = 2;
const UNSCOPED_MIGRATION_KEY = `${WORKSPACE_PREFIX}migration.v${MIGRATION_VERSION}.unscoped`;

function token(value) {
  const valueString = String(value ?? LOCAL_EXECUTION_HOST);
  // encodeURIComponent leaves dots alone, so the old `host.` prefix made
  // host `a` match host `a.b`. The length is part of the token and the final
  // dot is a delimiter, which makes the prefix exact for every host id.
  return `${valueString.length}:${encodeURIComponent(valueString)}`;
}

function isSharedKey(key) {
  const value = String(key);
  return (value.startsWith('pixice.connect.') && !value.startsWith(WORKSPACE_PREFIX))
    || /^(pixice\.(preferences|accentColor|reduceTransparency))$/.test(String(key));
}

export function workspaceStorageKey(hostId, key) {
  const raw = String(key);
  return isSharedKey(raw) ? raw : `${WORKSPACE_PREFIX}${token(hostId)}.${raw}`;
}

export function createWorkspaceStorage(hostId = LOCAL_EXECUTION_HOST, baseStorage = globalThis.localStorage) {
  const prefix = `${WORKSPACE_PREFIX}${token(hostId)}.`;
  migrateLegacyWorkspace(hostId, baseStorage);
  const scopedKeys = () => {
    const keys = [];
    for (let index = 0; index < baseStorage.length; index += 1) {
      const key = baseStorage.key(index);
      if (key?.startsWith(prefix)) keys.push(key.slice(prefix.length));
    }
    return keys;
  };
  const sharedKeys = () => {
    const keys = [];
    for (let index = 0; index < baseStorage.length; index += 1) {
      const key = baseStorage.key(index);
      if (key && isSharedKey(key)) keys.push(key);
    }
    return keys;
  };
  const keys = () => [...scopedKeys(), ...sharedKeys()];
  return {
    getItem(key) { return baseStorage.getItem(workspaceStorageKey(hostId, key)); },
    setItem(key, value) { baseStorage.setItem(workspaceStorageKey(hostId, key), String(value)); },
    removeItem(key) { baseStorage.removeItem(workspaceStorageKey(hostId, key)); },
    clear() { scopedKeys().forEach((key) => baseStorage.removeItem(`${prefix}${key}`)); },
    // Each call takes a fresh snapshot, so key swaps with the same cardinality
    // cannot leak a stale enumeration. Consumers that need to walk the store
    // should call keys() once instead of repeatedly calling length/key().
    keys,
    entries() { return keys().map((key) => [key, baseStorage.getItem(workspaceStorageKey(hostId, key))]); },
    key(index) { return keys()[index] ?? null; },
    get length() { return keys().length; },
    hostId
  };
}

function migrationMarkerKey(hostId) {
  return `${WORKSPACE_PREFIX}migration.v${MIGRATION_VERSION}.${token(hostId)}`;
}

function readLegacyActiveHost(storage) {
  try {
    return storage.getItem('pixice.connect.active') || LOCAL_EXECUTION_HOST;
  } catch {
    return LOCAL_EXECUTION_HOST;
  }
}

function migrateLegacyWorkspace(hostId, storage) {
  if (!storage) return;
  const prefix = `${WORKSPACE_PREFIX}${token(hostId)}.`;
  const marker = migrationMarkerKey(hostId);

  const copySnapshot = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [key, content] of Object.entries(value)) {
      if (!key.startsWith('pixice.') || isSharedKey(key) || typeof content !== 'string') continue;
      const scopedKey = `${prefix}${key}`;
      if (storage.getItem(scopedKey) === null) storage.setItem(scopedKey, content);
    }
  };

  // The first Connect implementation kept a whole workspace as JSON under
  // this unscoped key. Restore it before the new adapter is used. A marker is
  // durable, while the old snapshot remains untouched for recovery.
  if (!storage.getItem(marker)) {
    try {
      copySnapshot(JSON.parse(storage.getItem(`${WORKSPACE_PREFIX}${hostId}`) || 'null'));
      storage.setItem(marker, 'snapshot-copied');
    } catch {
      // A damaged snapshot or blocked write must not prevent later retries.
    }
  }

  // A local desktop used unscoped pixice.* keys before Connect existed. The
  // old active host owns those keys, even when this adapter is for another
  // host. Copy them once into that host's scope and leave originals intact.
  const owner = readLegacyActiveHost(storage);
  if (String(owner) !== String(hostId) || storage.getItem(UNSCOPED_MIGRATION_KEY)) return;
  const keys = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith('pixice.') && !isSharedKey(key) && !key.startsWith(WORKSPACE_PREFIX)) keys.push(key);
  }
  try {
    for (const key of keys) {
      const scopedKey = `${prefix}${key}`;
      if (storage.getItem(scopedKey) === null) storage.setItem(scopedKey, storage.getItem(key));
    }
    storage.setItem(UNSCOPED_MIGRATION_KEY, `host:${String(hostId)}`);
  } catch {
    // Keep the marker absent so a blocked or partial copy can be retried.
  }
}

export function remoteThreadLinksKey(originHostId, originProjectId) {
  // One encoded JSON tuple avoids ambiguities from dots, slashes, and legacy
  // escape substitutions in either identity component.
  return `pixice.connect.threads.${encodeURIComponent(JSON.stringify([
    String(originHostId ?? LOCAL_EXECUTION_HOST),
    String(originProjectId ?? '')
  ]))}`;
}

function parseLinkKey(key) {
  const prefix = 'pixice.connect.threads.';
  if (!key?.startsWith(prefix)) return null;
  const encoded = key.slice(prefix.length);
  try {
    const tuple = JSON.parse(decodeURIComponent(encoded));
    if (Array.isArray(tuple) && tuple.length >= 2) return { originHostId: tuple[0], originProjectId: tuple[1] };
  } catch { /* Try the pre-tuple key shape below. */ }
  const pieces = encoded.split('.');
  if (pieces.length !== 2) return null;
  try { return { originHostId: decodeURIComponent(pieces[0]), originProjectId: decodeURIComponent(pieces[1]) }; } catch { return null; }
}

function normalizeLink(entry, fallback = {}) {
  if (!entry || typeof entry !== 'object' || !entry.rawThreadId) return null;
  const normalized = {
    originHostId: entry.originHostId ?? entry.originHost ?? fallback.originHostId ?? LOCAL_EXECUTION_HOST,
    originProjectId: entry.originProjectId ?? entry.originProject ?? fallback.originProjectId ?? entry.projectId ?? null,
    executionHostId: entry.executionHostId ?? entry.hostId,
    executionProjectId: entry.executionProjectId ?? entry.targetProjectId,
    rawThreadId: entry.rawThreadId ?? entry.threadId,
    cachedOriginHostLabel: entry.cachedOriginHostLabel ?? '',
    cachedExecutionHostLabel: entry.cachedExecutionHostLabel ?? '',
    cachedProjectLabel: entry.cachedProjectLabel ?? '',
    cachedThreadTitle: entry.cachedThreadTitle ?? entry.rawTaskName ?? '',
    rawTaskName: entry.rawTaskName ?? entry.cachedThreadTitle ?? ''
  };
  return normalized.executionHostId && normalized.executionProjectId && normalized.originProjectId
    ? normalized
    : null;
}

function linkIdentity(entry) {
  return JSON.stringify([entry.originHostId, entry.originProjectId, entry.executionHostId, entry.executionProjectId, entry.rawThreadId]);
}

function storageKeys(storage) {
  if (typeof storage?.keys === 'function') return storage.keys();
  const keys = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key) keys.push(key);
  }
  return keys;
}

function storedLinks(storage) {
  const links = [];
  const records = [];
  for (const key of storageKeys(storage)) {
    if (!key?.startsWith('pixice.connect.threads.')) continue;
    let value;
    try { value = JSON.parse(storage.getItem(key) || '[]'); } catch { continue; }
    if (!Array.isArray(value)) continue;
    const fallback = parseLinkKey(key);
    value.forEach((entry) => {
      const normalized = normalizeLink(entry, fallback);
      if (normalized) records.push({ key, normalized, fallback });
    });
  }
  // Canonical tuple keys are authoritative over the old escaped/dotted key
  // shape. Sort only by the key that owns each record, then preserve order
  // within a record so fresh metadata remains deterministic.
  records.sort((left, right) => {
    const leftCanonical = left.fallback && left.key === remoteThreadLinksKey(left.fallback.originHostId, left.fallback.originProjectId);
    const rightCanonical = right.fallback && right.key === remoteThreadLinksKey(right.fallback.originHostId, right.fallback.originProjectId);
    return Number(rightCanonical) - Number(leftCanonical);
  });
  return records.map(({ normalized }) => normalized);
}

export function loadRemoteThreadLinks(originHostId, originProjectId, storage = globalThis.localStorage) {
  if (!originHostId || !originProjectId || !storage) return [];
  const wanted = storedLinks(storage).filter((entry) => entry.originHostId === originHostId && entry.originProjectId === originProjectId);
  const seen = new Set();
  return wanted.filter((entry) => {
    const identity = linkIdentity(entry);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

export function upsertRemoteThreadLink(reference, storage = globalThis.localStorage) {
  const normalized = normalizeLink(reference);
  if (!normalized) return null;
  const current = loadRemoteThreadLinks(normalized.originHostId, normalized.originProjectId, storage);
  saveRemoteThreadLinks(normalized.originHostId, normalized.originProjectId, [...current, normalized], storage);
  return normalized;
}

function mergeLinks(links) {
  const merged = new Map();
  for (const entry of links ?? []) {
    const normalized = normalizeLink(entry);
    if (!normalized) continue;
    const identity = linkIdentity(normalized);
    const previous = merged.get(identity);
    // A later event may carry a newly generated task title. Preserve the
    // identity and labels, but let fresh non-empty metadata replace stale
    // cached values.
    if (!previous) {
      merged.set(identity, normalized);
      continue;
    }
    const nextTitle = normalized.cachedThreadTitle || previous.cachedThreadTitle;
    const freshTitle = Boolean(normalized.cachedThreadTitle && normalized.cachedThreadTitle !== previous.cachedThreadTitle);
    const nextRawTaskName = normalized.rawTaskName && (!freshTitle || normalized.rawTaskName !== previous.rawTaskName)
      ? normalized.rawTaskName
      : freshTitle ? nextTitle : previous.rawTaskName;
    merged.set(identity, {
      ...previous,
      ...normalized,
      cachedOriginHostLabel: normalized.cachedOriginHostLabel || previous.cachedOriginHostLabel,
      cachedExecutionHostLabel: normalized.cachedExecutionHostLabel || previous.cachedExecutionHostLabel,
      cachedProjectLabel: normalized.cachedProjectLabel || previous.cachedProjectLabel,
      cachedThreadTitle: nextTitle,
      rawTaskName: nextRawTaskName
    });
  }
  return [...merged.values()];
}

export function listRemoteThreadLinks(storage = globalThis.localStorage) {
  return mergeLinks(storedLinks(storage));
}

export function saveRemoteThreadLinks(originHostId, originProjectId, links, storage = globalThis.localStorage) {
  if (!originHostId || !originProjectId || !storage) return;
  const existing = loadRemoteThreadLinks(originHostId, originProjectId, storage);
  const incoming = (links ?? []).map((entry) => normalizeLink(entry, { originHostId, originProjectId }));
  const safe = mergeLinks([...existing, ...incoming]).filter((entry) => entry.originHostId === originHostId && entry.originProjectId === originProjectId);
  storage.setItem(remoteThreadLinksKey(originHostId, originProjectId), JSON.stringify(safe));
}

export function threadReference({ originHostId = LOCAL_EXECUTION_HOST, originProjectId = null, executionHostId, executionProjectId, rawThreadId, cachedOriginHostLabel = '', cachedExecutionHostLabel = '', cachedProjectLabel = '', cachedThreadTitle = '', rawTaskName = '' }) {
  if (!executionHostId || !executionProjectId || !rawThreadId) throw new Error('A thread reference needs an execution host, project, and thread id.');
  return { originHostId, originProjectId, executionHostId, executionProjectId, rawThreadId, cachedOriginHostLabel, cachedExecutionHostLabel, cachedProjectLabel, cachedThreadTitle: cachedThreadTitle || rawTaskName, rawTaskName: rawTaskName || cachedThreadTitle };
}

export function executionWorkspaceId(hostId, threadId) {
  return `execution:${token(hostId)}:${token(threadId)}`;
}
