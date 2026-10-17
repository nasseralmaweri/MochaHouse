import {
  STOREFRONT_HOST_HEADER,
  STOREFRONT_HOST_SIGNATURE_HEADER,
  STOREFRONT_HOST_TIMESTAMP_HEADER,
  isUsableStorefrontLabel,
  normalizeStorefrontHost,
  platformStorefrontHost,
} from '@mocha-house/contracts';
import { signClientIp } from '../rate-limit/client-identity';
import {
  StorefrontRoutingConfigError,
  signStorefrontContext,
  storefrontRoutingConfig,
  verifyStorefrontContext,
} from './storefront-context';
import { isBusinessFreeRoute } from './tenant-context.middleware';

// SC4f-1 — the routing switch and the signed storefront context, in
// isolation (the integration spec drives them through real requests).
describe('storefrontRoutingConfig', () => {
  const secret = 's'.repeat(32);

  it('is off by default and for explicit off values', () => {
    for (const value of [undefined, '', '0', 'false', ' FALSE ']) {
      expect(
        storefrontRoutingConfig({ STOREFRONT_HOST_ROUTING_ENABLED: value }),
      ).toEqual({ hostRouting: false, secret: null });
    }
  });

  it('is on with a secret of at least 32 characters', () => {
    for (const value of ['1', 'true', 'TRUE']) {
      expect(
        storefrontRoutingConfig({
          STOREFRONT_HOST_ROUTING_ENABLED: value,
          STOREFRONT_CONTEXT_SECRET: secret,
        }),
      ).toEqual({ hostRouting: true, secret });
    }
  });

  it('fails closed when on without a usable secret, or when malformed', () => {
    expect(() =>
      storefrontRoutingConfig({ STOREFRONT_HOST_ROUTING_ENABLED: '1' }),
    ).toThrow(StorefrontRoutingConfigError);
    expect(() =>
      storefrontRoutingConfig({
        STOREFRONT_HOST_ROUTING_ENABLED: '1',
        STOREFRONT_CONTEXT_SECRET: 's'.repeat(31),
      }),
    ).toThrow(StorefrontRoutingConfigError);
    expect(() =>
      storefrontRoutingConfig({
        STOREFRONT_HOST_ROUTING_ENABLED: 'yes',
        STOREFRONT_CONTEXT_SECRET: secret,
      }),
    ).toThrow(StorefrontRoutingConfigError);
  });

  it('never puts the secret in its error message', () => {
    try {
      storefrontRoutingConfig({
        STOREFRONT_HOST_ROUTING_ENABLED: '1',
        STOREFRONT_CONTEXT_SECRET: 'short-secret-value',
      });
    } catch (error) {
      expect((error as Error).message).not.toContain('short-secret-value');
    }
  });
});

describe('verifyStorefrontContext', () => {
  const secret = 'k'.repeat(40);
  const now = 1_800_000_000;
  const host = 'bravo.shop.test';
  const headersFor = (
    hostname: string,
    seconds = now,
    key = secret,
  ): Record<string, string | string[] | undefined> => ({
    [STOREFRONT_HOST_HEADER]: hostname,
    [STOREFRONT_HOST_TIMESTAMP_HEADER]: String(seconds),
    [STOREFRONT_HOST_SIGNATURE_HEADER]: signStorefrontContext(
      key,
      hostname,
      seconds,
    ),
  });
  const verify = (headers: Record<string, string | string[] | undefined>) =>
    verifyStorefrontContext({ headers, secret, nowSeconds: now });

  it('accepts a fresh, correctly signed, normalized hostname', () => {
    expect(verify(headersFor(host))).toBe(host);
    expect(verify(headersFor(host, now - 60))).toBe(host);
    expect(verify(headersFor(host, now + 60))).toBe(host);
  });

  it('refuses anything missing, duplicated, stale or forged', () => {
    const good = headersFor(host);
    for (const name of [
      STOREFRONT_HOST_HEADER,
      STOREFRONT_HOST_TIMESTAMP_HEADER,
      STOREFRONT_HOST_SIGNATURE_HEADER,
    ]) {
      expect(verify({ ...good, [name]: undefined })).toBeNull();
      expect(
        verify({ ...good, [name]: [good[name] as string, 'x'] }),
      ).toBeNull();
    }
    expect(verify(headersFor(host, now - 61))).toBeNull();
    expect(verify(headersFor(host, now + 61))).toBeNull();
    expect(verify(headersFor(host, now, 'z'.repeat(40)))).toBeNull();
    expect(
      verify({
        ...headersFor('alpha.shop.test'),
        [STOREFRONT_HOST_HEADER]: host,
      }),
    ).toBeNull();
    expect(verify(headersFor('Bravo.Shop.Test'))).toBeNull();
    expect(verify(headersFor(`${host}.`))).toBeNull();
    expect(verify(headersFor('10.0.0.1'))).toBeNull();
    expect(
      verify({ ...good, [STOREFRONT_HOST_SIGNATURE_HEADER]: 'ab'.repeat(16) }),
    ).toBeNull();
    expect(
      verify({ ...good, [STOREFRONT_HOST_TIMESTAMP_HEADER]: ` ${now}` }),
    ).toBeNull();
  });

  it('never accepts a client-IP signature in place of a storefront one', () => {
    // Even under the same secret, the two messages are domain-separated.
    const seconds = now;
    expect(
      verify({
        [STOREFRONT_HOST_HEADER]: host,
        [STOREFRONT_HOST_TIMESTAMP_HEADER]: String(seconds),
        [STOREFRONT_HOST_SIGNATURE_HEADER]: signClientIp(secret, host, seconds),
      }),
    ).toBeNull();
  });
});

describe('isBusinessFreeRoute', () => {
  it('lists only the probe and the local media bytes, for reads', () => {
    expect(isBusinessFreeRoute('GET', '/')).toBe(true);
    expect(isBusinessFreeRoute('HEAD', '/?x=1')).toBe(true);
    expect(
      isBusinessFreeRoute('GET', '/api/v1/media/objects/media/a.png'),
    ).toBe(true);
    expect(isBusinessFreeRoute('POST', '/')).toBe(false);
    expect(isBusinessFreeRoute('GET', '/api/v1/locations')).toBe(false);
    expect(
      isBusinessFreeRoute('GET', '/api/v1/media/objects/media/a/b.png'),
    ).toBe(false);
  });
});

describe('signStorefrontContext', () => {
  // The same known answer as the web app's spec (apps/web/src/lib/
  // storefront-context.spec.ts): the two implementations must agree.
  it('matches the published test vector shared with the web app', () => {
    expect(
      signStorefrontContext(
        '0123456789abcdef0123456789abcdef',
        'mocha.shop.test',
        1_800_000_000,
      ),
    ).toBe('1db54d133e3e0fa3d4962767d8d42985949054473dbf11f40f67649828b6bf50');
  });
});

describe('storefront hostname rules (contracts)', () => {
  it('normalizes consistently and rejects what is not a DNS hostname', () => {
    expect(normalizeStorefrontHost('Order.Example.COM:443')).toBe(
      'order.example.com',
    );
    expect(normalizeStorefrontHost('order.example.com.')).toBe(
      'order.example.com',
    );
    expect(normalizeStorefrontHost('localhost:3000')).toBe('localhost');
    for (const bad of [
      '',
      'single',
      '10.0.0.1',
      '[::1]',
      'a..b.test',
      '-a.b.test',
      'a_b.test',
      `${'a'.repeat(64)}.test`,
      null,
      42,
    ]) {
      expect(normalizeStorefrontHost(bad)).toBeNull();
    }
  });

  it('builds platform subdomains only from usable, unreserved slugs', () => {
    expect(platformStorefrontHost('bravo-cafe', 'centerivo.test')).toBe(
      'bravo-cafe.centerivo.test',
    );
    for (const reserved of ['admin', 'api', 'www', 'platform', 'centerivo']) {
      expect(isUsableStorefrontLabel(reserved)).toBe(false);
      expect(platformStorefrontHost(reserved, 'centerivo.test')).toBeNull();
    }
    for (const bad of ['Bravo', 'bravo_cafe', '-bravo', 'bravo-', '']) {
      expect(isUsableStorefrontLabel(bad)).toBe(false);
    }
  });
});
