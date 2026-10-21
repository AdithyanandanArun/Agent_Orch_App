import { afterEach, describe, expect, it, vi } from 'vitest';
import { summarizeOpencodeSession, type OpencodeRuntime } from './runtime.js';

const TEST_PASSWORD = 'fake-opencode-password-for-test-only';
const RUNTIME_PORT = 43_891;
const SESSION_ID = 'ses_native1234';

function fakeOpencodeRuntime(): OpencodeRuntime {
  return {
    child: {} as OpencodeRuntime['child'],
    conn: {} as OpencodeRuntime['conn'],
    version: 'test',
    capabilities: {},
    stderr: {} as OpencodeRuntime['stderr'],
    secrets: [],
    serverPort: RUNTIME_PORT,
    serverUsername: 'opencode',
    serverPassword: TEST_PASSWORD,
  };
}

function stubFetch(response: Response) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function compactionInput(signal = new AbortController().signal) {
  return { sessionId: SESSION_ID, providerID: 'fake-provider', modelID: 'fake-model', signal };
}

afterEach(() => vi.unstubAllGlobals());

describe('OpenCode native session compaction', () => {
  it('posts an authenticated, model-specific summarize request to the runtime loopback session URL', async () => {
    const fetchMock = stubFetch(new Response('true', { status: 200 }));

    await summarizeOpencodeSession(fakeOpencodeRuntime(), compactionInput());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    if (!call) return;
    const [url, init] = call;

    expect(url).toBe(`http://127.0.0.1:${RUNTIME_PORT}/session/${encodeURIComponent(SESSION_ID)}/summarize`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ providerID: 'fake-provider', modelID: 'fake-model' });

    const authorization = new Headers(init?.headers).get('authorization');
    const expectedAuthorization = `Basic ${Buffer.from(`opencode:${TEST_PASSWORD}`).toString('base64')}`;
    expect(authorization === expectedAuthorization).toBe(true);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(false);
  });

  it.each([false, null, { accepted: true }])('rejects non-true success bodies (%j)', async (result) => {
    stubFetch(new Response(JSON.stringify(result), { status: 200 }));

    await expect(summarizeOpencodeSession(fakeOpencodeRuntime(), compactionInput()))
      .rejects.toMatchObject({ code: 'compaction_unconfirmed' });
  });

  it.each([404, 405])('treats HTTP %i as unsupported native summarization', async (status) => {
    stubFetch(new Response('', { status }));

    await expect(summarizeOpencodeSession(fakeOpencodeRuntime(), compactionInput()))
      .rejects.toMatchObject({ code: 'compaction_unsupported', statusCode: status });
  });

  it('surfaces other HTTP failures with bounded detail and no runtime password', async () => {
    stubFetch(new Response(`upstream failed password=${TEST_PASSWORD} ${'x'.repeat(1_000)}`, { status: 500 }));

    let failure: unknown;
    try {
      await summarizeOpencodeSession(fakeOpencodeRuntime(), compactionInput());
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: 'compaction_failed', statusCode: 500 });
    const message = failure instanceof Error ? failure.message : '';
    expect(message.includes('HTTP 500')).toBe(true);
    expect(message.includes('upstream failed')).toBe(true);
    expect(message.includes(TEST_PASSWORD)).toBe(false);
    expect(message.length <= 600).toBe(true);
  });

  it('rejects as interrupted when the caller aborts the request', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error('fetch did not receive an abort signal'));
        return;
      }
      signal.addEventListener('abort', () => reject(new DOMException('Request aborted', 'AbortError')), { once: true });
      controller.abort();
    }));
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await summarizeOpencodeSession(fakeOpencodeRuntime(), compactionInput(controller.signal))
      .then(() => undefined, (error: unknown) => error);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ name: 'AbortError', message: 'OpenCode compaction was interrupted' });
  });
});
