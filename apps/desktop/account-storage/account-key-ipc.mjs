import { isCanonicalAccountKey } from './account-key.mjs';

const REQUEST_ID_PATTERN = /^[0-9a-f]{32}$/;
export const ACCOUNT_KEY_IPC_QUEUE_LIMIT = 8;
export const ACCOUNT_KEY_IPC_COMPLETED_HISTORY_LIMIT = 128;
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

function overflowResponse(requestId) {
  return {
    type: 'mingle.account-key', requestId, key: null,
    storage: { status: 'unavailable', backend: null, reason: 'ipc-unavailable', retryable: true },
  };
}

/** Serializes keyring access with bounded queue and recent duplicate history. */
export function createAccountKeyIpcHandler({ getAccountKey, send }) {
  const pendingRequestIds = new Set();
  const completedRequestIds = new Set();
  const completedOrder = [];
  const queue = [];
  let processing = false;

  function rememberCompleted(requestId) {
    pendingRequestIds.delete(requestId);
    if (completedRequestIds.has(requestId)) return;
    completedRequestIds.add(requestId);
    completedOrder.push(requestId);
    if (completedOrder.length > ACCOUNT_KEY_IPC_COMPLETED_HISTORY_LIMIT) {
      completedRequestIds.delete(completedOrder.shift());
    }
  }

  async function deliver(response) {
    try { await send(response); }
    catch { /* A disconnected child cannot receive an IPC response. */ }
  }

  async function processQueue() {
    if (processing) return;
    processing = true;
    try {
      while (queue.length > 0) {
        const requestId = queue.shift();
        let result;
        try { result = getAccountKey(); }
        catch {
          result = {
            key: null,
            storage: { status: 'unavailable', backend: null, reason: 'keyring-unavailable', retryable: true },
          };
        }
        try { await deliver(normalizeResult(requestId, result)); }
        finally { rememberCompleted(requestId); }
      }
    } finally {
      processing = false;
      if (queue.length > 0) void processQueue();
    }
  }

  return function handleAccountKeyMessage(message) {
    if (!isAccountKeyRequest(message)) return false;
    const { requestId } = message;
    if (pendingRequestIds.has(requestId) || completedRequestIds.has(requestId)) return false;
    if (queue.length >= ACCOUNT_KEY_IPC_QUEUE_LIMIT) {
      rememberCompleted(requestId);
      void deliver(overflowResponse(requestId));
      return true;
    }

    pendingRequestIds.add(requestId);
    queue.push(requestId);
    void processQueue();
    return true;
  };
}
