import { isCanonicalAccountKey } from './account-key.mjs';

const REQUEST_ID_PATTERN = /^[0-9a-f]{32}$/;
const STORAGE_REASONS = new Set([
  'web-runtime',
  'no-keyring',
  'keyring-unavailable',
  'key-unreadable',
  'storage-write-failed',
  'ipc-unavailable',
]);
const BACKEND_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

export function isAccountKeyRequest(message) {
  return message?.type === 'mingle.account-key.request'
    && typeof message.requestId === 'string'
    && REQUEST_ID_PATTERN.test(message.requestId);
}

function normalizeResult(requestId, result) {
  const storage = result?.storage;
  const backend = typeof storage?.backend === 'string' && BACKEND_PATTERN.test(storage.backend)
    ? storage.backend
    : null;
  if (storage?.status === 'available' && storage.reason === null && isCanonicalAccountKey(result.key)) {
    return {
      type: 'mingle.account-key', requestId, key: result.key,
      storage: { status: 'available', backend, reason: null, retryable: false },
    };
  }

  const reason = STORAGE_REASONS.has(storage?.reason) ? storage.reason : 'keyring-unavailable';
  return {
    type: 'mingle.account-key', requestId, key: null,
    storage: {
      status: 'unavailable', backend,
      reason,
      retryable: storage?.retryable === true,
    },
  };
}

/** Serializes keyring access and emits no more than one response for each valid id. */
export function createAccountKeyIpcHandler({ getAccountKey, send }) {
  const seenRequestIds = new Set();
  let queue = Promise.resolve();

  return function handleAccountKeyMessage(message) {
    if (!isAccountKeyRequest(message) || seenRequestIds.has(message.requestId)) return false;
    seenRequestIds.add(message.requestId);

    queue = queue.then(async () => {
      let result;
      try { result = getAccountKey(); }
      catch {
        result = {
          key: null,
          storage: { status: 'unavailable', backend: null, reason: 'keyring-unavailable', retryable: true },
        };
      }
      try { await send(normalizeResult(message.requestId, result)); }
      catch { /* A disconnected child cannot receive an IPC response. */ }
    }).catch(() => {});
    return true;
  };
}
