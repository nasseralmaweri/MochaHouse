import { signDevJwt, verifyDevJwt } from './dev-jwt';

describe('dev-jwt', () => {
  const secret = 'test-secret';

  it('round-trips a signed token back to its claims', () => {
    const token = signDevJwt(
      { sub: 'dev:test@example.com', email: 'test@example.com', name: null },
      secret,
      3600,
    );

    const payload = verifyDevJwt(token, secret);

    expect(payload.sub).toBe('dev:test@example.com');
    expect(payload.email).toBe('test@example.com');
    expect(payload.name).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const token = signDevJwt(
      { sub: 'dev:x', email: null, name: null },
      secret,
      3600,
    );

    expect(() => verifyDevJwt(token, 'wrong-secret')).toThrow();
  });

  it('rejects a token whose payload was tampered with', () => {
    const token = signDevJwt(
      { sub: 'dev:x', email: null, name: null },
      secret,
      3600,
    );
    const [header, , signature] = token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({
        sub: 'dev:someone-else',
        email: null,
        name: null,
        exp: 9999999999,
      }),
      'utf8',
    ).toString('base64url');
    const forged = `${header}.${forgedPayload}.${signature}`;

    expect(() => verifyDevJwt(forged, secret)).toThrow();
  });

  it('rejects an expired token', () => {
    const token = signDevJwt(
      { sub: 'dev:x', email: null, name: null },
      secret,
      -1,
    );

    expect(() => verifyDevJwt(token, secret)).toThrow('expired');
  });

  it('rejects a malformed token', () => {
    expect(() => verifyDevJwt('not-a-jwt', secret)).toThrow();
  });
});
