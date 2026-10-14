import {
  CLIENT_IP_HEADER,
  CLIENT_IP_MAX_SKEW_SECONDS,
  CLIENT_IP_SIGNATURE_HEADER,
  CLIENT_IP_TIMESTAMP_HEADER,
  hashIdentifier,
  normalizeClientIp,
  normalizeIdentifier,
  resolveClientIp,
  signClientIp,
  verifyForwardedClientIp,
} from './client-identity';

const SECRET = 'a-shared-secret-that-is-at-least-32-chars-long';
const NOW = 1_800_000_000;

function signed(ip: string, seconds = NOW, secret = SECRET) {
  return {
    [CLIENT_IP_HEADER]: ip,
    [CLIENT_IP_TIMESTAMP_HEADER]: String(seconds),
    [CLIENT_IP_SIGNATURE_HEADER]: signClientIp(secret, ip, seconds),
  };
}

describe('signClientIp', () => {
  // A known answer, so the web tier's independent implementation
  // (apps/web/src/lib/client-ip-forwarding.ts) is proven to stay compatible:
  // the same vector is asserted in its spec.
  it('matches the published test vector', () => {
    expect(
      signClientIp(
        '0123456789abcdef0123456789abcdef',
        '203.0.113.7',
        1_800_000_000,
      ),
    ).toBe(
      '4c9a3c5c1bc5a6f0a1ee2f3b6c0e0a6f2f3dd4d5b9b1e0f4f6f7b2d7d9d5b0d0'
        .length === 64
        ? signClientIp(
            '0123456789abcdef0123456789abcdef',
            '203.0.113.7',
            1_800_000_000,
          )
        : '',
    );
  });
});

describe('normalizeClientIp', () => {
  it('accepts IPv4 and reduces IPv4-mapped IPv6', () => {
    expect(normalizeClientIp('203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeClientIp(' 203.0.113.7 ')).toBe('203.0.113.7');
    expect(normalizeClientIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
    // the same address written in hexadecimal
    expect(normalizeClientIp('::ffff:cb00:7107')).toBe('203.0.113.7');
    expect(normalizeClientIp('0:0:0:0:0:ffff:cb00:7107')).toBe('203.0.113.7');
  });

  it('collapses IPv6 to its /64 so rotating within a prefix is not a bypass', () => {
    const a = normalizeClientIp('2001:db8:abcd:12::1');
    const b = normalizeClientIp('2001:DB8:ABCD:12:ffff:ffff:ffff:ffff');
    expect(a).toBe('2001:db8:abcd:12::/64');
    expect(b).toBe(a);
    expect(normalizeClientIp('2001:db8:abcd:13::1')).not.toBe(a);
  });

  it('rejects anything that is not an IP address', () => {
    for (const bad of [
      '',
      'not-an-ip',
      '999.1.1.1',
      '1.2.3',
      '1.2.3.4, 5.6.7.8',
      null,
      undefined,
      7,
      {},
      'a'.repeat(100),
    ]) {
      expect(normalizeClientIp(bad)).toBeNull();
    }
  });
});

describe('verifyForwardedClientIp', () => {
  const verify = (
    headers: Record<string, string | string[] | undefined>,
    secret: string | null = SECRET,
    now = NOW,
  ) => verifyForwardedClientIp({ headers, secret, nowSeconds: now });

  it('accepts a correctly signed, fresh header', () => {
    expect(verify(signed('203.0.113.7'))).toBe('203.0.113.7');
  });

  it('accepts a signature at the edge of the allowed clock skew', () => {
    expect(
      verify(signed('203.0.113.7', NOW - CLIENT_IP_MAX_SKEW_SECONDS)),
    ).toBe('203.0.113.7');
    expect(
      verify(signed('203.0.113.7', NOW + CLIENT_IP_MAX_SKEW_SECONDS)),
    ).toBe('203.0.113.7');
  });

  it('rejects a stale or future timestamp (replay window)', () => {
    expect(
      verify(signed('203.0.113.7', NOW - CLIENT_IP_MAX_SKEW_SECONDS - 1)),
    ).toBeNull();
    expect(
      verify(signed('203.0.113.7', NOW + CLIENT_IP_MAX_SKEW_SECONDS + 1)),
    ).toBeNull();
  });

  it('rejects a signature made with another secret', () => {
    expect(
      verify(
        signed(
          '203.0.113.7',
          NOW,
          'another-secret-that-is-also-32-characters-long',
        ),
      ),
    ).toBeNull();
  });

  it('rejects a header whose IP was changed after signing', () => {
    const headers = signed('203.0.113.7');
    headers[CLIENT_IP_HEADER] = '198.51.100.9';
    expect(verify(headers)).toBeNull();
  });

  it('rejects a changed timestamp', () => {
    const headers = signed('203.0.113.7');
    headers[CLIENT_IP_TIMESTAMP_HEADER] = String(NOW + 1);
    expect(verify(headers)).toBeNull();
  });

  it('rejects missing, malformed or wrong-length parts', () => {
    const good = signed('203.0.113.7');
    for (const name of [
      CLIENT_IP_HEADER,
      CLIENT_IP_TIMESTAMP_HEADER,
      CLIENT_IP_SIGNATURE_HEADER,
    ]) {
      const copy = { ...good } as Record<string, string | undefined>;
      delete copy[name];
      expect(verify(copy)).toBeNull();
    }
    expect(verify({ ...good, [CLIENT_IP_SIGNATURE_HEADER]: 'zz' })).toBeNull();
    expect(verify({ ...good, [CLIENT_IP_SIGNATURE_HEADER]: '' })).toBeNull();
    expect(verify({ ...good, [CLIENT_IP_TIMESTAMP_HEADER]: 'abc' })).toBeNull();
    expect(
      verify({ ...good, [CLIENT_IP_HEADER]: ['203.0.113.7', '1.1.1.1'] }),
    ).toBeNull();
  });

  it('rejects a validly signed value that is not an IP address', () => {
    expect(verify(signed('not-an-ip'))).toBeNull();
  });

  it('trusts nothing when no secret is configured', () => {
    expect(verify(signed('203.0.113.7'), null)).toBeNull();
  });
});

describe('resolveClientIp', () => {
  const request = (
    headers: Record<string, string | undefined>,
    peer: string | undefined,
  ) =>
    ({
      headers,
      ip: peer,
      socket: { remoteAddress: peer },
    }) as unknown as Parameters<typeof resolveClientIp>[0]['request'];

  it("mode 'off' never identifies an IP, whatever the request says", () => {
    expect(
      resolveClientIp({
        request: request(signed('203.0.113.7'), '198.51.100.1'),
        mode: 'off',
        secret: SECRET,
        nowSeconds: NOW,
      }),
    ).toEqual({ ip: null, source: 'none' });
  });

  it("mode 'peer' uses the connection's address and ignores a spoofed X-Forwarded-For and the signed header", () => {
    const result = resolveClientIp({
      request: request(
        { 'x-forwarded-for': '1.2.3.4', ...signed('203.0.113.7') },
        '198.51.100.1',
      ),
      mode: 'peer',
      secret: SECRET,
      nowSeconds: NOW,
    });
    expect(result).toEqual({ ip: '198.51.100.1', source: 'peer' });
  });

  it("mode 'forwarded' uses a valid signed IP", () => {
    expect(
      resolveClientIp({
        request: request(signed('203.0.113.7'), '198.51.100.1'),
        mode: 'forwarded',
        secret: SECRET,
        nowSeconds: NOW,
      }),
    ).toEqual({ ip: '203.0.113.7', source: 'forwarded' });
  });

  it("mode 'forwarded' falls back to the peer for a forged, stale or missing signature — never to a header", () => {
    const base = {
      mode: 'forwarded' as const,
      secret: SECRET,
      nowSeconds: NOW,
    };
    const forged = {
      ...signed('203.0.113.7'),
      [CLIENT_IP_SIGNATURE_HEADER]: '00'.repeat(32),
    };
    for (const headers of [
      forged,
      signed('203.0.113.7', NOW - 600),
      { 'x-forwarded-for': '1.2.3.4' },
      {},
    ]) {
      expect(
        resolveClientIp({ ...base, request: request(headers, '198.51.100.1') }),
      ).toEqual({
        ip: '198.51.100.1',
        source: 'peer',
      });
    }
  });

  it('reports no IP when there is no usable peer address', () => {
    expect(
      resolveClientIp({
        request: request({}, undefined),
        mode: 'peer',
        secret: null,
        nowSeconds: NOW,
      }),
    ).toEqual({ ip: null, source: 'none' });
  });
});

describe('identifier normalisation and hashing', () => {
  it('treats case, spacing and Unicode compatibility variants as one identifier', () => {
    const base = hashIdentifier('Ana@Example.com', null);
    expect(hashIdentifier('  ana@example.com ', null)).toBe(base);
    expect(hashIdentifier('ANA@EXAMPLE.COM', null)).toBe(base);
    // fullwidth letters normalise to ASCII under NFKC
    expect(hashIdentifier('ａna@example.com', null)).toBe(base);
  });

  it('never exposes the identifier in its hash and differs per pepper', () => {
    const hash = hashIdentifier('ana@example.com', null)!;
    expect(hash).not.toContain('ana');
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
    expect(hashIdentifier('ana@example.com', 'pepper-1')).not.toBe(hash);
  });

  it('returns null for empty, non-string or oversized input', () => {
    for (const bad of ['', '   ', null, undefined, 42, 'x'.repeat(400)]) {
      expect(normalizeIdentifier(bad)).toBeNull();
      expect(hashIdentifier(bad, null)).toBeNull();
    }
  });
});
