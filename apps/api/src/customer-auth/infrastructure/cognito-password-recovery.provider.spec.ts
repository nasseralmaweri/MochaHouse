import { ServiceUnavailableException } from '@nestjs/common';
import { CognitoPasswordRecoveryProvider } from './cognito-password-recovery.provider';

function mockFetchResolvedWith(response: {
  ok: boolean;
  body: Record<string, unknown>;
}): jest.SpiedFunction<typeof fetch> {
  return jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: response.ok,
    json: () => Promise.resolve(response.body),
  } as Response);
}

describe('CognitoPasswordRecoveryProvider', () => {
  const provider = new CognitoPasswordRecoveryProvider();
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.COGNITO_USER_POOL_ID = 'us-east-1_testpool';
    process.env.COGNITO_CLIENT_ID = 'test-client-id';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  describe('startPasswordRecovery', () => {
    it('maps a successful ForgotPassword to initiated', async () => {
      mockFetchResolvedWith({
        ok: true,
        body: { CodeDeliveryDetails: { Destination: 't***@e***' } },
      });

      const result = await provider.startPasswordRecovery('test@example.com');
      expect(result).toEqual({ outcome: 'initiated' });
    });

    it('maps UserNotFoundException to account-not-recoverable (no raw message forwarded)', async () => {
      mockFetchResolvedWith({
        ok: false,
        body: {
          __type: 'UserNotFoundException',
          message: 'Username/client id combination not found.',
        },
      });

      const result = await provider.startPasswordRecovery('nobody@example.com');
      expect(result).toEqual({ outcome: 'account-not-recoverable' });
    });

    it('maps the "no verified email" InvalidParameterException (unconfirmed user) to account-not-recoverable', async () => {
      mockFetchResolvedWith({
        ok: false,
        body: {
          __type: 'InvalidParameterException',
          message:
            'Cannot reset password for the user as there is no registered/verified email or phone_number',
        },
      });

      const result = await provider.startPasswordRecovery(
        'pending@example.com',
      );
      expect(result).toEqual({ outcome: 'account-not-recoverable' });
    });

    it('throws ServiceUnavailable for a rate-limit rather than reporting a fake "code sent"', async () => {
      mockFetchResolvedWith({
        ok: false,
        body: {
          __type: 'LimitExceededException',
          message: 'Attempt limit exceeded',
        },
      });

      await expect(
        provider.startPasswordRecovery('test@example.com'),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('throws ServiceUnavailable for an unrecognized error', async () => {
      mockFetchResolvedWith({
        ok: false,
        body: { __type: 'InternalErrorException' },
      });

      await expect(
        provider.startPasswordRecovery('test@example.com'),
      ).rejects.toThrow(ServiceUnavailableException);
    });
  });

  describe('confirmPasswordReset', () => {
    const request = {
      email: 'test@example.com',
      code: '123456',
      newPassword: 'a-fine-new-password',
    };

    it('maps a successful ConfirmForgotPassword to success', async () => {
      mockFetchResolvedWith({ ok: true, body: {} });

      const result = await provider.confirmPasswordReset(request);
      expect(result).toEqual({ outcome: 'success' });
    });

    it('maps CodeMismatchException to invalid-code', async () => {
      mockFetchResolvedWith({
        ok: false,
        body: { __type: 'CodeMismatchException' },
      });

      const result = await provider.confirmPasswordReset(request);
      expect(result).toEqual({ outcome: 'invalid-code' });
    });

    it('maps ExpiredCodeException to expired-code', async () => {
      mockFetchResolvedWith({
        ok: false,
        body: { __type: 'ExpiredCodeException' },
      });

      const result = await provider.confirmPasswordReset(request);
      expect(result).toEqual({ outcome: 'expired-code' });
    });

    it('maps InvalidPasswordException to invalid-password without forwarding the raw policy text', async () => {
      mockFetchResolvedWith({
        ok: false,
        body: {
          __type: 'InvalidPasswordException',
          message:
            'Password did not conform with policy: Password not long enough',
        },
      });

      const result = await provider.confirmPasswordReset({
        ...request,
        newPassword: 'weak',
      });
      expect(result).toEqual({ outcome: 'invalid-password' });
    });

    it('maps InvalidParameterException to invalid-password', async () => {
      mockFetchResolvedWith({
        ok: false,
        body: { __type: 'InvalidParameterException' },
      });

      const result = await provider.confirmPasswordReset(request);
      expect(result).toEqual({ outcome: 'invalid-password' });
    });

    it('maps UserNotFoundException to a neutral invalid-recovery-state', async () => {
      mockFetchResolvedWith({
        ok: false,
        body: { __type: 'UserNotFoundException' },
      });

      const result = await provider.confirmPasswordReset(request);
      expect(result).toEqual({ outcome: 'invalid-recovery-state' });
    });

    it('maps NotAuthorizedException (stale/consumed recovery state) to invalid-recovery-state', async () => {
      mockFetchResolvedWith({
        ok: false,
        body: {
          __type: 'NotAuthorizedException',
          message: 'User password cannot be reset in the current state.',
        },
      });

      const result = await provider.confirmPasswordReset(request);
      expect(result).toEqual({ outcome: 'invalid-recovery-state' });
    });

    it('throws ServiceUnavailable for an unrecognized error', async () => {
      mockFetchResolvedWith({
        ok: false,
        body: { __type: 'InternalErrorException' },
      });

      await expect(provider.confirmPasswordReset(request)).rejects.toThrow(
        ServiceUnavailableException,
      );
    });
  });
});
