import { randomUUID } from 'node:crypto';
import { LocalDevRegistrationProvider } from './local-dev-registration.provider';
import { LocalDevCustomerDirectory } from './local-dev-customer-directory';
import { deriveDevVerificationCode } from './dev-verification-code';
import type { CustomerRegisterRequest } from '@mocha-house/contracts';

describe('LocalDevRegistrationProvider', () => {
  const secret = 'local-dev-registration-spec-secret';
  const originalEnv = { ...process.env };
  let provider: LocalDevRegistrationProvider;

  beforeEach(() => {
    process.env.AUTH_DEV_JWT_SECRET = secret;
    provider = new LocalDevRegistrationProvider(
      new LocalDevCustomerDirectory(),
    );
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function request(
    overrides: Partial<CustomerRegisterRequest> = {},
  ): CustomerRegisterRequest {
    return {
      email: `test-${randomUUID()}@example.com`,
      password: 'a-fine-password',
      displayName: 'Test Customer',
      ...overrides,
    };
  }

  it('registers successfully with a dev-provider subject derived from the email', async () => {
    const req = request({ email: 'new-customer@example.com' });
    const result = await provider.register(req);

    expect(result).toEqual({
      outcome: 'success',
      provider: 'dev',
      subject: 'dev:new-customer@example.com',
    });
  });

  it('rejects a password shorter than 8 characters as invalid-password', async () => {
    const result = await provider.register(request({ password: 'short' }));
    expect(result).toEqual({ outcome: 'invalid-password' });
  });

  it('rejects a duplicate registration for the same email as already-exists', async () => {
    const req = request();
    await provider.register(req);
    const second = await provider.register(req);
    expect(second).toEqual({ outcome: 'already-exists' });
  });

  it('verifies successfully with the correct derived code', async () => {
    const req = request();
    await provider.register(req);
    const code = deriveDevVerificationCode(req.email, secret);

    const result = await provider.verify({ email: req.email, code });
    expect(result).toEqual({ outcome: 'success' });
  });

  it('fails with invalid-code for an incorrect code', async () => {
    const req = request();
    await provider.register(req);
    const wrongCode =
      deriveDevVerificationCode(req.email, secret) === '000000'
        ? '111111'
        : '000000';

    const result = await provider.verify({ email: req.email, code: wrongCode });
    expect(result).toEqual({ outcome: 'invalid-code' });
  });

  it('fails with expired-code once the acceptance window has elapsed', async () => {
    provider.codeTtlMs = 10;
    const req = request();
    await provider.register(req);
    const code = deriveDevVerificationCode(req.email, secret);

    await new Promise((resolve) => setTimeout(resolve, 25));

    const result = await provider.verify({ email: req.email, code });
    expect(result).toEqual({ outcome: 'expired-code' });
  });

  it('reports not-found for an email that was never registered', async () => {
    const result = await provider.verify({
      email: 'never-registered@example.com',
      code: '123456',
    });
    expect(result).toEqual({ outcome: 'not-found' });
  });

  it('reports already-verified on a second verification of the same account', async () => {
    const req = request();
    await provider.register(req);
    const code = deriveDevVerificationCode(req.email, secret);
    await provider.verify({ email: req.email, code });

    const result = await provider.verify({ email: req.email, code });
    expect(result).toEqual({ outcome: 'already-verified' });
  });

  it('does not create a duplicate identity across register -> verify -> a repeat register attempt', async () => {
    const req = request();
    const first = await provider.register(req);
    const code = deriveDevVerificationCode(req.email, secret);
    await provider.verify({ email: req.email, code });

    const repeat = await provider.register(req);
    expect(repeat).toEqual({ outcome: 'already-exists' });
    expect(first).toEqual({
      outcome: 'success',
      provider: 'dev',
      subject: `dev:${req.email}`,
    });
  });

  it('resend resets the acceptance window and reports sent', async () => {
    provider.codeTtlMs = 10;
    const req = request();
    await provider.register(req);
    await new Promise((resolve) => setTimeout(resolve, 25));

    const resendResult = await provider.resendVerification(req.email);
    expect(resendResult).toEqual({ outcome: 'sent' });

    // The window was reset by resend, so the (still-deterministic) code
    // accepted a moment ago now verifies again without expiring.
    const code = deriveDevVerificationCode(req.email, secret);
    const verifyResult = await provider.verify({ email: req.email, code });
    expect(verifyResult).toEqual({ outcome: 'success' });
  });

  it('reports not-found when resending for an unregistered email', async () => {
    const result = await provider.resendVerification(
      'never-registered@example.com',
    );
    expect(result).toEqual({ outcome: 'not-found' });
  });

  it('reports already-verified when resending for an already-verified account', async () => {
    const req = request();
    await provider.register(req);
    const code = deriveDevVerificationCode(req.email, secret);
    await provider.verify({ email: req.email, code });

    const result = await provider.resendVerification(req.email);
    expect(result).toEqual({ outcome: 'already-verified' });
  });
});
