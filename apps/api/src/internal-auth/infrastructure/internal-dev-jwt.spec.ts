import { signInternalDevJwt, verifyInternalDevJwt } from './internal-dev-jwt';
import { signDevJwt } from '../../customer-auth/infrastructure/dev-jwt';

describe('internal dev JWT codec', () => {
  const secret = 'internal-dev-jwt-spec-secret';

  it('round-trips subject and basic claims', () => {
    const token = signInternalDevJwt(
      {
        sub: 'internal-dev:admin@example.com',
        email: 'admin@example.com',
        name: 'Admin',
      },
      secret,
      3600,
    );

    expect(verifyInternalDevJwt(token, secret)).toEqual({
      sub: 'internal-dev:admin@example.com',
      email: 'admin@example.com',
      name: 'Admin',
    });
  });

  it('rejects a token signed with a different secret', () => {
    const token = signInternalDevJwt(
      { sub: 'internal-dev:x', email: null, name: null },
      'other-secret',
      3600,
    );
    expect(() => verifyInternalDevJwt(token, secret)).toThrow();
  });

  it('rejects an expired token', () => {
    const token = signInternalDevJwt(
      { sub: 'internal-dev:x', email: null, name: null },
      secret,
      -10,
    );
    expect(() => verifyInternalDevJwt(token, secret)).toThrow();
  });

  it('rejects a malformed token', () => {
    expect(() => verifyInternalDevJwt('not-a-real-token', secret)).toThrow();
  });

  // The core isolation guarantee at the codec level: a genuine customer dev
  // token, even if it were ever signed with the same secret, has no internal
  // marker claim and must not verify here.
  it('rejects a customer dev token signed with the SAME secret (no internal marker)', () => {
    const customerToken = signDevJwt(
      {
        sub: 'dev:customer@example.com',
        email: 'customer@example.com',
        name: null,
      },
      secret,
      3600,
    );
    expect(() => verifyInternalDevJwt(customerToken, secret)).toThrow(
      'Not an internal token.',
    );
  });
});
