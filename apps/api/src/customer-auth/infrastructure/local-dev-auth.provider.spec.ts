import { LocalDevAuthProvider } from './local-dev-auth.provider';
import { LocalDevCustomerDirectory } from './local-dev-customer-directory';
import { deriveDevPasswordHash } from './dev-password-hash';

describe('LocalDevAuthProvider', () => {
  const originalEnv = { ...process.env };
  let directory: LocalDevCustomerDirectory;
  let provider: LocalDevAuthProvider;

  beforeEach(() => {
    process.env.AUTH_DEV_JWT_SECRET = 'local-dev-auth-spec-secret';
    directory = new LocalDevCustomerDirectory();
    provider = new LocalDevAuthProvider(directory);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('signs in successfully for an identifier the directory has never seen (unchanged pre-registration behavior)', async () => {
    const result = await provider.signIn({
      identifier: 'never-registered@example.com',
      password: 'anything',
    });

    expect(result.outcome).toBe('success');
  });

  it('refuses to sign in an identifier that is registered but not yet verified', async () => {
    directory.set('pending@example.com', {
      subject: 'dev:pending@example.com',
      displayName: null,
      issuedAt: Date.now(),
      verified: false,
    });

    const result = await provider.signIn({
      identifier: 'pending@example.com',
      password: 'anything',
    });

    expect(result).toEqual({ outcome: 'invalid-credentials' });
  });

  it('signs in successfully once the directory marks the identifier verified', async () => {
    directory.set('verified@example.com', {
      subject: 'dev:verified@example.com',
      displayName: null,
      issuedAt: Date.now(),
      verified: true,
    });

    const result = await provider.signIn({
      identifier: 'verified@example.com',
      password: 'anything',
    });

    expect(result.outcome).toBe('success');
  });

  it('checks the stored password hash when the directory record has one', async () => {
    directory.set('has-password@example.com', {
      subject: 'dev:has-password@example.com',
      displayName: null,
      issuedAt: Date.now(),
      verified: true,
      passwordHash: deriveDevPasswordHash(
        'the-real-password',
        'local-dev-auth-spec-secret',
      ),
    });

    expect(
      await provider.signIn({
        identifier: 'has-password@example.com',
        password: 'the-wrong-password',
      }),
    ).toEqual({ outcome: 'invalid-credentials' });

    expect(
      (
        await provider.signIn({
          identifier: 'has-password@example.com',
          password: 'the-real-password',
        })
      ).outcome,
    ).toBe('success');
  });
});
