import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { PierreClient } from '../src/pierre/client';

const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function makeClient(overrides: Record<string, unknown> = {}) {
  return new PierreClient({
    apiKey: 'test-key',
    baseUrl: 'https://api.test',
    logger: noopLogger,
    ...overrides,
  });
}

describe('PierreClient requests', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn(async () => jsonResponse({ success: true, data: [] }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  test('sends the bearer token and accepts JSON', async () => {
    await makeClient().getAccounts();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.test/get-accounts');
    expect(init.headers.Authorization).toBe('Bearer test-key');
    expect(init.headers.Accept).toBe('application/json');
    expect(init.method).toBe('GET');
  });

  test('strips trailing slashes from the base url', async () => {
    await makeClient({ baseUrl: 'https://api.test///' }).getAccounts();

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.test/get-accounts');
  });

  test('builds the transactions query string from the date range', async () => {
    await makeClient().getTransactions('2026-06-01', '2026-06-30');

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.test/get-transactions?startDate=2026-06-01&endDate=2026-06-30',
    );
  });

  test('omits the query string when no dates are given', async () => {
    await makeClient().getTransactions();

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.test/get-transactions');
  });

  test('manual update is a POST', async () => {
    await makeClient().triggerManualUpdate();

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.test/manual-update');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
  });

  test('returns the parsed body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, count: 3, data: [1, 2, 3] }));

    const result = await makeClient().getAccounts();

    expect(result.count).toBe(3);
  });
});

describe('PierreClient retry behavior', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  test('retries a network failure and succeeds on the second attempt', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: [] }));

    const promise = makeClient().getAccounts();
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toEqual({ success: true, data: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('retries on a non-2xx response', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: [] }));

    const promise = makeClient().getAccounts();
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toEqual({ success: true, data: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('gives up after 3 attempts and surfaces the last error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'unauthorized' }, 401));

    const promise = makeClient().getAccounts();
    const assertion = expect(promise).rejects.toThrow(/401/);
    await vi.runAllTimersAsync();
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test('backs off exponentially between attempts', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'boom' }, 500));
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const promise = makeClient().getAccounts();
    const assertion = expect(promise).rejects.toThrow();
    await vi.runAllTimersAsync();
    await assertion;

    const delays = setTimeoutSpy.mock.calls.map((c) => c[1]);
    expect(delays).toEqual([1000, 2000]); // 2 waits between 3 attempts
  });
});
