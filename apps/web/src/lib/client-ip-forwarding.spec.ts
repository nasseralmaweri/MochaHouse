import {
  CLIENT_IP_HEADER,
  CLIENT_IP_SIGNATURE_HEADER,
  CLIENT_IP_TIMESTAMP_HEADER,
  clientIpFromHeaderValue,
  signClientIp,
  signedClientIpHeaders,
} from './client-ip-forwarding';

const SECRET = 'a-shared-secret-that-is-at-least-32-chars-long';
const NOW_MS = 1_800_000_000_000;

const source = (headers: Record<string, string>) => ({
  get: (name: string) => headers[name.toLowerCase()] ?? null,
});

describe('signClientIp', () => {
  // The same known answer as the API's spec (apps/api/src/rate-limit/
  // client-identity.spec.ts): the two independent implementations must agree.
  it('matches the published test vector shared with the API', () => {
    expect(
      signClientIp('0123456789abcdef0123456789abcdef', '203.0.113.7', 1_800_000_000),
    ).toBe('d6f91e1cf45b979cfd021295ca06a782b71430c002fd3ae4f93d2618bbe65e26');
  });
});

describe('clientIpFromHeaderValue', () => {
  it('takes the entry the declared number of trusted proxies from the END', () => {
    // client, proxy-added entries: one trusted proxy appended the last entry's source
    expect(clientIpFromHeaderValue('198.51.100.9, 203.0.113.7', 1)).toBe('203.0.113.7');
    expect(clientIpFromHeaderValue('198.51.100.9, 203.0.113.7, 192.0.2.1', 2)).toBe('203.0.113.7');
  });

  it('ignores client-controlled entries before the trusted ones (spoofing)', () => {
    expect(clientIpFromHeaderValue('1.2.3.4, 5.6.7.8, 203.0.113.7', 1)).toBe('203.0.113.7');
  });

  it('works for a single-value header set by the edge', () => {
    expect(clientIpFromHeaderValue('203.0.113.7', 1)).toBe('203.0.113.7');
    expect(clientIpFromHeaderValue('2001:db8::1', 1)).toBe('2001:db8::1');
  });

  it('fails safe when the list is shorter than the proxies declared, or empty, or not an IP', () => {
    expect(clientIpFromHeaderValue('203.0.113.7', 2)).toBeNull();
    expect(clientIpFromHeaderValue('', 1)).toBeNull();
    expect(clientIpFromHeaderValue(null, 1)).toBeNull();
    expect(clientIpFromHeaderValue('unknown', 1)).toBeNull();
    expect(clientIpFromHeaderValue('203.0.113.7', 0)).toBeNull();
  });
});

describe('signedClientIpHeaders', () => {
  const env = {
    CLIENT_IP_FORWARD_SECRET: SECRET,
    CLIENT_IP_HEADER: 'X-Forwarded-For',
  } as unknown as NodeJS.ProcessEnv;

  it('signs the visitor IP with a fresh timestamp', () => {
    const headers = signedClientIpHeaders(source({ 'x-forwarded-for': '198.51.100.9, 203.0.113.7' }), env, NOW_MS);
    expect(headers[CLIENT_IP_HEADER]).toBe('203.0.113.7');
    expect(headers[CLIENT_IP_TIMESTAMP_HEADER]).toBe('1800000000');
    expect(headers[CLIENT_IP_SIGNATURE_HEADER]).toBe(signClientIp(SECRET, '203.0.113.7', 1_800_000_000));
  });

  it('forwards nothing unless the deployment declares where the trustworthy IP comes from', () => {
    const request = source({ 'x-forwarded-for': '203.0.113.7' });
    expect(signedClientIpHeaders(request, {} as unknown as NodeJS.ProcessEnv, NOW_MS)).toEqual({});
    expect(signedClientIpHeaders(request, { CLIENT_IP_FORWARD_SECRET: SECRET } as unknown as NodeJS.ProcessEnv, NOW_MS)).toEqual({});
    expect(signedClientIpHeaders(request, { CLIENT_IP_HEADER: 'x-forwarded-for' } as unknown as NodeJS.ProcessEnv, NOW_MS)).toEqual({});
  });

  it('refuses a short secret, an invalid hop count, and a header that is not an address', () => {
    const request = source({ 'x-forwarded-for': '203.0.113.7' });
    expect(signedClientIpHeaders(request, { ...env, CLIENT_IP_FORWARD_SECRET: 'short' } as unknown as NodeJS.ProcessEnv, NOW_MS)).toEqual({});
    for (const hops of ['0', '-1', 'x', '11', '1.5']) {
      expect(signedClientIpHeaders(request, { ...env, CLIENT_IP_TRUSTED_HOPS: hops } as unknown as NodeJS.ProcessEnv, NOW_MS)).toEqual({});
    }
    expect(signedClientIpHeaders(source({ 'x-forwarded-for': 'not-an-ip' }), env, NOW_MS)).toEqual({});
    expect(signedClientIpHeaders(source({}), env, NOW_MS)).toEqual({});
  });

  it('honours the declared number of trusted proxies', () => {
    const headers = signedClientIpHeaders(
      source({ 'x-forwarded-for': '198.51.100.9, 203.0.113.7, 192.0.2.1' }),
      { ...env, CLIENT_IP_TRUSTED_HOPS: '2' } as unknown as NodeJS.ProcessEnv,
      NOW_MS,
    );
    expect(headers[CLIENT_IP_HEADER]).toBe('203.0.113.7');
  });

  it('can use a single-value platform header', () => {
    const headers = signedClientIpHeaders(
      source({ 'cf-connecting-ip': '203.0.113.7' }),
      { CLIENT_IP_FORWARD_SECRET: SECRET, CLIENT_IP_HEADER: 'CF-Connecting-IP' } as unknown as NodeJS.ProcessEnv,
      NOW_MS,
    );
    expect(headers[CLIENT_IP_HEADER]).toBe('203.0.113.7');
  });
});
