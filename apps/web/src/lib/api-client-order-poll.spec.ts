import { pollOrderStatusFromBrowser } from './api-client';

// The browser poll of a guest order's status: every non-success outcome must be
// a distinct, harmless result, and the request itself must not widen how the
// access token is exposed.
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
    const result = await pollOrderStatusFromBrowser('o1', 'tok');
    expect(result).toEqual({ outcome: 'success', status: validOrder });
  });

  it('asks for no caching and sends no Referer, with the id and token encoded', async () => {
    fetchMock.mockResolvedValue(respond(200, validOrder));
    await pollOrderStatusFromBrowser('../x/y', 'a b&c');
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'http://api.test/api/v1/orders/..%2Fx%2Fy?accessToken=a%20b%26c',
    );
    expect(options).toMatchObject({
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
  });

  it('reports a 404 (wrong id or token) as not-found', async () => {
    fetchMock.mockResolvedValue(respond(404, {}));
    expect(await pollOrderStatusFromBrowser('o1', 'bad')).toEqual({
      outcome: 'not-found',
    });
  });

  it.each([500, 502, 503, 429, 400, 401])(
    'reports HTTP %i as a failed poll, not not-found',
    async (status) => {
      fetchMock.mockResolvedValue(respond(status, {}));
      expect(await pollOrderStatusFromBrowser('o1', 't')).toEqual({
        outcome: 'error',
      });
    },
  );

  it('reports a network failure as a failed poll', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await pollOrderStatusFromBrowser('o1', 't')).toEqual({
      outcome: 'error',
    });
  });

  it('reports a missing API URL configuration as a failed poll, not a crash', async () => {
    delete process.env.NEXT_PUBLIC_API_URL;
    expect(await pollOrderStatusFromBrowser('o1', 't')).toEqual({
      outcome: 'error',
    });
    expect(fetchMock).not.toHaveBeenCalled();
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
    expect(await pollOrderStatusFromBrowser('o1', 't')).toEqual({
      outcome: 'error',
    });
  });
});
