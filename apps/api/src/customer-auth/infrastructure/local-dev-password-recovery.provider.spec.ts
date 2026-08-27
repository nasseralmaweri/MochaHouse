import { randomUUID } from 'node:crypto';
import { LocalDevPasswordRecoveryProvider } from './local-dev-password-recovery.provider';
import { LocalDevRegistrationProvider } from './local-dev-registration.provider';
import { LocalDevAuthProvider } from './local-dev-auth.provider';
import { LocalDevCustomerDirectory } from './local-dev-customer-directory';
import { deriveDevVerificationCode } from './dev-verification-code';
import { deriveDevRecoveryCode } from './dev-recovery-code';

describe('LocalDevPasswordRecoveryProvider', () => {
  const secret = 'local-dev-password-recovery-spec-secret';
  const originalEnv = { ...process.env };
  let directory: LocalDevCustomerDirectory;
  let registration: LocalDevRegistrationProvider;
  let recovery: LocalDevPasswordRecoveryProvider;
  let auth: LocalDevAuthProvider;

  beforeEach(() => {
    process.env.AUTH_DEV_JWT_SECRET = secret;
    directory = new LocalDevCustomerDirectory();
    registration = new LocalDevRegistrationProvider(directory);
    recovery = new LocalDevPasswordRecoveryProvider(directory);
    auth = new LocalDevAuthProvider(directory);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  async function registerVerified(
    email: string,
    password = 'original-password',
  ): Promise<void> {
    await registration.register({ email, password, displayName: 'Test' });
    await registration.verify({
      email,
      code: deriveDevVerificationCode(email, secret),
    });
  }

  function newEmail(): string {
    return `recovery-${randomUUID()}@example.com`;
  }

  describe('startPasswordRecovery', () => {
    it('initiates for a known, verified account', async () => {
      const email = newEmail();
      await registerVerified(email);

      const result = await recovery.startPasswordRecovery(email);
      expect(result).toEqual({ outcome: 'initiated' });
    });

    it('reports account-not-recoverable for an unknown email', async () => {
      const result = await recovery.startPasswordRecovery(newEmail());
      expect(result).toEqual({ outcome: 'account-not-recoverable' });
    });

    it('reports account-not-recoverable for a registered but unverified account', async () => {
      const email = newEmail();
      await registration.register({
        email,
        password: 'original-password',
        displayName: 'Test',
      });

      const result = await recovery.startPasswordRecovery(email);
      expect(result).toEqual({ outcome: 'account-not-recoverable' });
    });
  });

  describe('confirmPasswordReset', () => {
    it('succeeds with the correct recovery code and a valid new password, and swaps the sign-in password', async () => {
      const email = newEmail();
      await registerVerified(email, 'original-password');
      await recovery.startPasswordRecovery(email);

      const result = await recovery.confirmPasswordReset({
        email,
        code: deriveDevRecoveryCode(email, secret),
        newPassword: 'brand-new-password',
      });
      expect(result).toEqual({ outcome: 'success' });

      expect(
        await auth.signIn({ identifier: email, password: 'original-password' }),
      ).toEqual({ outcome: 'invalid-credentials' });
      expect(
        (
          await auth.signIn({
            identifier: email,
            password: 'brand-new-password',
          })
        ).outcome,
      ).toBe('success');
    });

    it('rejects a wrong code without changing the password', async () => {
      const email = newEmail();
      await registerVerified(email, 'original-password');
      await recovery.startPasswordRecovery(email);

      const correct = deriveDevRecoveryCode(email, secret);
      const wrong = correct === '000000' ? '111111' : '000000';

      const result = await recovery.confirmPasswordReset({
        email,
        code: wrong,
        newPassword: 'brand-new-password',
      });
      expect(result).toEqual({ outcome: 'invalid-code' });
      expect(
        (
          await auth.signIn({
            identifier: email,
            password: 'original-password',
          })
        ).outcome,
      ).toBe('success');
    });

    it('rejects an expired code once the window has elapsed', async () => {
      recovery.recoveryCodeTtlMs = 10;
      const email = newEmail();
      await registerVerified(email);
      await recovery.startPasswordRecovery(email);
      await new Promise((resolve) => setTimeout(resolve, 25));

      const result = await recovery.confirmPasswordReset({
        email,
        code: deriveDevRecoveryCode(email, secret),
        newPassword: 'brand-new-password',
      });
      expect(result).toEqual({ outcome: 'expired-code' });
    });

    it('rejects a weak new password', async () => {
      const email = newEmail();
      await registerVerified(email);
      await recovery.startPasswordRecovery(email);

      const result = await recovery.confirmPasswordReset({
        email,
        code: deriveDevRecoveryCode(email, secret),
        newPassword: 'short',
      });
      expect(result).toEqual({ outcome: 'invalid-password' });
    });

    it('rejects a reset with no preceding forgot-password call as invalid-recovery-state', async () => {
      const email = newEmail();
      await registerVerified(email);

      const result = await recovery.confirmPasswordReset({
        email,
        code: deriveDevRecoveryCode(email, secret),
        newPassword: 'brand-new-password',
      });
      expect(result).toEqual({ outcome: 'invalid-recovery-state' });
    });

    it('rejects a reset for an unknown email as invalid-recovery-state', async () => {
      const result = await recovery.confirmPasswordReset({
        email: newEmail(),
        code: '123456',
        newPassword: 'brand-new-password',
      });
      expect(result).toEqual({ outcome: 'invalid-recovery-state' });
    });

    it('consumes the code — a replay of the same successful reset then fails', async () => {
      const email = newEmail();
      await registerVerified(email);
      await recovery.startPasswordRecovery(email);
      const code = deriveDevRecoveryCode(email, secret);

      expect(
        await recovery.confirmPasswordReset({
          email,
          code,
          newPassword: 'brand-new-password',
        }),
      ).toEqual({ outcome: 'success' });

      expect(
        await recovery.confirmPasswordReset({
          email,
          code,
          newPassword: 'another-new-password',
        }),
      ).toEqual({ outcome: 'invalid-recovery-state' });
    });

    it('does not mark an account verified or otherwise change verification state', async () => {
      const email = newEmail();
      await registerVerified(email);
      await recovery.startPasswordRecovery(email);
      await recovery.confirmPasswordReset({
        email,
        code: deriveDevRecoveryCode(email, secret),
        newPassword: 'brand-new-password',
      });

      // Still exactly one directory record, still verified, subject intact.
      const entry = directory.get(email);
      expect(entry?.verified).toBe(true);
      expect(entry?.subject).toBe(`dev:${email}`);
    });
  });
});
