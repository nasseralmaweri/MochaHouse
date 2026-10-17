import type { CheckoutRequest } from '@mocha-house/contracts';

// SC4f-1 — storefront-context.ts is server-only; stand the marker in.
jest.mock('server-only', () => ({}));
import { getPublicJobOpenings, getStorefrontFeatures } from './api';
import {
  getCheckoutRewardsFromBrowser,
  submitCheckoutFromBrowser,
} from './api-client';

// SC2b — the storefront's view of features its business does not offer.
// The API enforces every rule; these helpers only decide what the customer
// sees, and must never invent availability or hide that nothing was charged.
describe('SC2b storefront feature handling', () => {
  const originalFetch = global.fetch;
  const originalApiUrl = process.env.API_URL;
  let fetchMock: jest.Mock;

  const respond = (status: number, body: unknown) =>
    ({
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
    }) as unknown as Response;

  beforeEach(() => {
    process.env.API_URL = 'http://api.test/api/v1';
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
    process.env.API_URL = originalApiUrl;
  });

  describe('getStorefrontFeatures', () => {
    const features = {
      loyalty: true,
      promotions: false,
      giftcards: true,
      careers: false,
      franchising: true,
      cms: true,
    };

    it('returns the business features from the API, uncached', async () => {
      fetchMock.mockResolvedValue(respond(200, { features }));
      await expect(getStorefrontFeatures()).resolves.toEqual(features);
      expect(fetchMock).toHaveBeenCalledWith(
        'http://api.test/api/v1/storefront/features',
        { cache: 'no-store' },
      );
    });

    it('returns null (never invented availability) when the read fails', async () => {
      fetchMock.mockResolvedValue(respond(503, { message: 'down' }));
      await expect(getStorefrontFeatures()).resolves.toBeNull();
      fetchMock.mockRejectedValue(new Error('offline'));
      await expect(getStorefrontFeatures()).resolves.toBeNull();
    });
  });

  it('getPublicJobOpenings reports an unavailable careers module (404) as null, and still throws on errors', async () => {
    fetchMock.mockResolvedValue(respond(404, { message: 'Page not found.' }));
    await expect(getPublicJobOpenings()).resolves.toBeNull();
    fetchMock.mockResolvedValue(respond(500, {}));
    await expect(getPublicJobOpenings()).rejects.toThrow('500');
  });

  describe('submitCheckoutFromBrowser', () => {
    const request = {
      idempotencyKey: 'k-12345678',
      locationId: 'loc',
      guest: { name: 'G', phone: '5551234567' },
      lines: [],
    } as unknown as CheckoutRequest;

    it('maps 403 FEATURE_NOT_AVAILABLE to "unavailable" with the server message', async () => {
      fetchMock.mockResolvedValue(
        respond(403, {
          code: 'FEATURE_NOT_AVAILABLE',
          feature: 'promotions',
          message: 'Promotions and coupons are not available here right now.',
        }),
      );
      await expect(submitCheckoutFromBrowser(request)).resolves.toEqual({
        outcome: 'unavailable',
        message: 'Promotions and coupons are not available here right now.',
      });
    });

    it('any other 403 is still "unavailable" and says nothing was charged', async () => {
      fetchMock.mockResolvedValue(respond(403, { message: 'nope' }));
      const result = await submitCheckoutFromBrowser(request);
      expect(result.outcome).toBe('unavailable');
      expect('message' in result && result.message).toContain('Nothing was charged');
    });
  });

  it('getCheckoutRewardsFromBrowser offers no rewards (and no availability) when the quote fails', async () => {
    fetchMock.mockResolvedValue(respond(500, {}));
    await expect(
      getCheckoutRewardsFromBrowser({ locationId: 'loc', lines: [] }),
    ).resolves.toEqual({ balance: 0, rewards: [], available: false });
  });
});
