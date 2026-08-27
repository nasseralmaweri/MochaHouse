import { ServiceUnavailableException } from '@nestjs/common';
import { CognitoRegistrationProvider } from './cognito-registration.provider';

function mockFetchResolvedWith(response: {
  ok: boolean;
  body: Record<string, unknown>;
}): jest.SpiedFunction<typeof fetch> {
  return jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: response.ok,
    json: () => Promise.resolve(response.body),
  } as Response);
}

describe('CognitoRegistrationProvider', () => {
  const provider = new CognitoRegistrationProvider();
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.COGNITO_USER_POOL_ID = 'us-east-1_testpool';
    process.env.COGNITO_CLIENT_ID = 'test-client-id';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  describe('register', () => {
    it('maps a successful SignUp to a success outcome with the UserSub as subject', async () => {
      mockFetchResolvedWith({
        ok: true,
        body: { UserSub: 'abc-123', UserConfirmed: false },
      });

      const result = await provider.register({
        email: 'test@example.com',
        password: 'a-fine-password',
        displayName: 'Test Customer',
      });

      expect(result).toEqual({
        outcome: 'success',
        provider: 'cognito',
        subject: 'abc-123',
      });
    });

    it('maps UsernameExistsException to already-exists', async () => {
      mockFetchResolvedWith({
        ok: false,
        body: { __type: 'UsernameExistsException' },
      });

      const result = await provider.register({
        email: 'test@example.com',
        password: 'a-fine-password',
        displayName: 'Test Customer',
      });

      expect(result).toEqual({ outcome: 'already-exists' });
    });

    it('maps InvalidPasswordException to invalid-password without forwarding the raw Cognito message', async () => {
      mockFetchResolvedWith({
        ok: false,
        body: {
          __type: 'InvalidPasswordException',
          message:
            'Password did not conform with policy: Password must have uppercase characters',
        },
      });

      const result = await provider.register({
        email: 'test@example.com',
        password: 'weak',
        displayName: 'Test Customer',
      });

      expect(result).toEqual({ outcome: 'invalid-password' });
    });

    it('maps InvalidParameterException to invalid-input', async () => {
      mockFetchResolvedWith({
        ok: false,
        body: { __type: 'InvalidParameterException' },
      });

      const result = await provider.register({
        email: 'not-an-email',
        password: 'a-fine-password',
        displayName: 'Test Customer',
      });

      expect(result).toEqual({ outcome: 'invalid-input' });
    });

    it('throws for an unrecognized error rather than guessing an outcome', async () => {
      mockFetchResolvedWith({
        ok: false,
        body: { __type: 'InternalErrorException' },
      });

      await expect(
        provider.register({
          email: 'test@example.com',
          password: 'x',
          displayName: 'X',
        }),
      ).rejects.toThrow(ServiceUnavailableException);
    });
  });

  describe('verify', () => {
    it('maps a successful ConfirmSignUp to success', async () => {
      mockFetchResolvedWith({ ok: true, body: {} });

      const result = await provider.verify({
        email: 'test@example.com',
        code: '123456',
      });
      expect(result).toEqual({ outcome: 'success' });
    });

    it('maps CodeMismatchException to invalid-code', async () => {
      mockFetchResolvedWith({
        ok: false,
        body: { __type: 'CodeMismatchException' },
      });

      const result = await provider.verify({
        email: 'test@example.com',
        code: 'wrong',
      });
      expect(result).toEqual({ outcome: 'invalid-code' });
    });

    it('maps ExpiredCodeException to expired-code', async () => {
      mockFetchResolvedWith({
        ok: false,
        body: { __type: 'ExpiredCodeException' },
      });

      const result = await provider.verify({
        email: 'test@example.com',
        code: '123456',
      });
      expect(result).toEqual({ outcome: 'expired-code' });
    });

    it('maps UserNotFoundException to not-found', async () => {
      mockFetchResolvedWith({
        ok: false,
        body: { __type: 'UserNotFoundException' },
      });

      const result = await provider.verify({
        email: 'test@example.com',
        code: '123456',
      });
      expect(result).toEqual({ outcome: 'not-found' });
    });

    it('normalizes an already-confirmed account to already-verified', async () => {
      mockFetchResolvedWith({
        ok: false,
        body: {
          __type: 'NotAuthorizedException',
          message: 'User cannot be confirmed. Current status is CONFIRMED',
        },
      });

      const result = await provider.verify({
        email: 'test@example.com',
        code: '123456',
      });
      expect(result).toEqual({ outcome: 'already-verified' });
    });

    it('throws for a NotAuthorizedException that is not the already-confirmed case', async () => {
      mockFetchResolvedWith({
        ok: false,
        body: {
          __type: 'NotAuthorizedException',
          message: 'Some other reason',
        },
      });

      await expect(
        provider.verify({ email: 'test@example.com', code: '123456' }),
      ).rejects.toThrow(ServiceUnavailableException);
    });
  });

  describe('resendVerification', () => {
    it('maps a successful ResendConfirmationCode to sent', async () => {
      mockFetchResolvedWith({ ok: true, body: { CodeDeliveryDetails: {} } });

      const result = await provider.resendVerification('test@example.com');
      expect(result).toEqual({ outcome: 'sent' });
    });

    it('maps UserNotFoundException to not-found', async () => {
      mockFetchResolvedWith({
        ok: false,
        body: { __type: 'UserNotFoundException' },
      });

      const result = await provider.resendVerification('test@example.com');
      expect(result).toEqual({ outcome: 'not-found' });
    });

    it('normalizes an already-confirmed account to already-verified', async () => {
      mockFetchResolvedWith({
        ok: false,
        body: {
          __type: 'InvalidParameterException',
          message: 'User is already confirmed.',
        },
      });

      const result = await provider.resendVerification('test@example.com');
      expect(result).toEqual({ outcome: 'already-verified' });
    });
  });
});
