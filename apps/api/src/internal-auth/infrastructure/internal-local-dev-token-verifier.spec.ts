import { InternalLocalDevTokenVerifier } from './internal-local-dev-token-verifier';
import { signInternalDevJwt } from './internal-dev-jwt';
import { signDevJwt } from '../../customer-auth/infrastructure/dev-jwt';

describe('InternalLocalDevTokenVerifier', () => {
  const originalEnv = { ...process.env };
  const internalSecret = 'internal-verifier-spec-secret';
  const customerSecret = 'customer-verifier-spec-secret';
  let verifier: InternalLocalDevTokenVerifier;

  beforeEach(() => {
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = internalSecret;
    process.env.AUTH_DEV_JWT_SECRET = customerSecret;
    verifier = new InternalLocalDevTokenVerifier();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('verifies a genuine internal dev token and stamps provider "internal-dev"', async () => {
    const token = signInternalDevJwt(
      {
        sub: 'internal-dev:admin@example.com',
        email: 'admin@example.com',
        name: null,
      },
      internalSecret,
      3600,
    );

    await expect(verifier.verify(token)).resolves.toEqual({
      provider: 'internal-dev',
      subject: 'internal-dev:admin@example.com',
      email: 'admin@example.com',
      name: null,
    });
  });

  it('rejects a customer dev token signed with the customer secret', async () => {
    const customerToken = signDevJwt(
      {
        sub: 'dev:customer@example.com',
        email: 'customer@example.com',
        name: null,
      },
      customerSecret,
      3600,
    );
    await expect(verifier.verify(customerToken)).rejects.toThrow();
  });

  it('rejects a customer dev token even if it was signed with the internal secret', async () => {
    const customerToken = signDevJwt(
      {
        sub: 'dev:customer@example.com',
        email: 'customer@example.com',
        name: null,
      },
      internalSecret,
      3600,
    );
    await expect(verifier.verify(customerToken)).rejects.toThrow();
  });

  it('throws when INTERNAL_AUTH_DEV_JWT_SECRET is unset', async () => {
    delete process.env.INTERNAL_AUTH_DEV_JWT_SECRET;
    const token = signInternalDevJwt(
      { sub: 'internal-dev:x', email: null, name: null },
      internalSecret,
      3600,
    );
    await expect(verifier.verify(token)).rejects.toThrow();
  });
});
