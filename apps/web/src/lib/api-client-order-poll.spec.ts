import {
  fetchGuestShareToken,
  pollOrderStatusFromBrowser,
  startGuestSession,
} from './api-client';

// The browser poll of a guest order's status: every non-success outcome must be
// a distinct, harmless result, and the request carries NO credential at all
// (S3c: the token lives in an HttpOnly cookie read by the same-origin route).
describe('pollOrderStatusFromBrowser', () => {
  const originalFetch = global.fetch;
  const originalUrl = process.env.NEXT_PUBLIC_API_URL;
  let fetchMock: jest.Mock;

  const validOrder = {
    orderId: 'o1',
    orderNumber: 'ABC123',
    status: 'PREPARING',
    lines: [],
  };

  const respond = (status: number, body: unknown, json = true) =>
    ({
      status,
      ok: status >= 200 && status < 300,
      json: json
        ? async () => body
        : async () => {
            throw new SyntaxError('not json');
          },
    }) as unknown as Response;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_API_URL = 'http://api.test/api/v1';
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
    process.env.NEXT_PUBLIC_API_URL = originalUrl;
  });

  it('returns the order on a well-formed 200', async () => {
    fetchMock.mockResolvedValue(respond(200, validOrder));
    const result = await pollOrderStatusFromBrowser('o1');
    expect(result).toEqual({ outcome: 'success', status: validOrder });
  });

  it.each(['REJECTED', 'CANCELLED'])(
    'accepts a %s order as a successful poll, not a failed one',
    async (status) => {
      const closed = { ...validOrder, status };
      fetchMock.mockResolvedValue(respond(200, closed));
      const result = await pollOrderStatusFromBrowser('o1');
      expect(result).toEqual({ outcome: 'success', status: closed });
    },
  );

  it('polls the same-origin route with no credential in the URL, no caching, no Referer', async () => {
    fetchMock.mockResolvedValue(respond(200, validOrder));
    await pollOrderStatusFromBrowser('../x/y');
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/orders/..%2Fx%2Fy/status');
    expect(url).not.toMatch(/token|accessToken|\?/i);
    expect(options).toMatchObject({
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
    expect(options.headers).toBeUndefined();
  });

  it('reports a 404 (wrong id or token) as not-found', async () => {
    fetchMock.mockResolvedValue(respond(404, {}));
    expect(await pollOrderStatusFromBrowser('o1')).toEqual({
      outcome: 'not-found',
    });
  });

  it.each([500, 502, 503, 429, 400, 401])(
    'reports HTTP %i as a failed poll, not not-found',
    async (status) => {
      fetchMock.mockResolvedValue(respond(status, {}));
      expect(await pollOrderStatusFromBrowser('o1')).toEqual({
        outcome: 'error',
      });
    },
  );

  it('reports a network failure as a failed poll', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await pollOrderStatusFromBrowser('o1')).toEqual({
      outcome: 'error',
    });
  });

  it.each([
    ['an unreadable body', respond(200, null, false)],
    ['an empty object', respond(200, {})],
    ['an array', respond(200, [])],
    ['null', respond(200, null)],
    ['a string', respond(200, 'ok')],
    ['an unknown status', respond(200, { ...validOrder, status: 'TELEPORTED' })],
    ['no lines list', respond(200, { orderId: 'o1', status: 'READY' })],
    ['a non-string id', respond(200, { ...validOrder, orderId: 7 })],
  ])('reports %s as a failed poll', async (_label, response) => {
    fetchMock.mockResolvedValue(response);
    expect(await pollOrderStatusFromBrowser('o1')).toEqual({
      outcome: 'error',
    });
  });
});

describe('startGuestSession', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;
  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('posts the token in the BODY (never the URL) with the request marker', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    expect(await startGuestSession('o1', 'tok_en')).toEqual({ outcome: 'ok' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/orders/o1/guest-session');
    expect(url).not.toContain('tok_en');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ token: 'tok_en' });
    expect(new Headers(init.headers).get('x-centerivo-request')).toBe('1');
    expect(init).toMatchObject({ cache: 'no-store', referrerPolicy: 'no-referrer' });
  });

  it('maps 404 to not-found and anything else, or a network failure, to error', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
    expect(await startGuestSession('o1', 't')).toEqual({ outcome: 'not-found' });
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429 });
    expect(await startGuestSession('o1', 't')).toEqual({ outcome: 'error' });
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    expect(await startGuestSession('o1', 't')).toEqual({ outcome: 'error' });
  });
});

describe('fetchGuestShareToken', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });
  it('returns the token on 200 and null otherwise', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: 'abc' }),
    }) as unknown as typeof fetch;
    expect(await fetchGuestShareToken('o1')).toBe('abc');
    global.fetch = jest.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch;
    expect(await fetchGuestShareToken('o1')).toBeNull();
    global.fetch = jest.fn().mockRejectedValue(new Error('x')) as unknown as typeof fetch;
    expect(await fetchGuestShareToken('o1')).toBeNull();
  });
});
