import {
  AdminCreateUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { Logger } from '@nestjs/common';
import { CognitoStaffLoginProvider } from './cognito-staff-login.provider';

// V1 launch fix 2 — the Cognito staff invitation, with the AWS SDK MOCKED
// (no AWS call, no email). What matters: a new login is created with the
// provider's own emailed temporary password (none of ours), an existing
// login is never changed, and only answers the provider confirmed count.

const POOL = 'us-east-1_TestPool1';

function awsError(name: string, message = name): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe('CognitoStaffLoginProvider (mocked AWS SDK)', () => {
  const originalEnv = { ...process.env };
  let send: jest.SpyInstance;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    process.env.INTERNAL_COGNITO_USER_POOL_ID = POOL;
    send = jest.spyOn(CognitoIdentityProviderClient.prototype, 'send');
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });
  afterEach(() => {
    send.mockRestore();
    warn.mockRestore();
    process.env = { ...originalEnv };
  });

  const inputs = () =>
    send.mock.calls.map(
      ([command]) => (command as AdminCreateUserCommand).input,
    );

  it('creates the login with the address verified-by-delivery, emailed by Cognito — never a password of ours', async () => {
    send.mockResolvedValueOnce({});
    const result = await new CognitoStaffLoginProvider().inviteLogin({
      email: 'new.person@example.com',
      displayName: 'New Person',
    });
    expect(result).toEqual({ outcome: 'invited' });
    expect(inputs()).toEqual([
      {
        UserPoolId: POOL,
        Username: 'new.person@example.com',
        UserAttributes: [
          { Name: 'email', Value: 'new.person@example.com' },
          { Name: 'email_verified', Value: 'true' },
        ],
        DesiredDeliveryMediums: ['EMAIL'],
      },
    ]);
    expect(JSON.stringify(inputs())).not.toMatch(/TemporaryPassword|Password/);
  });

  it('a login still waiting for its first sign-in gets a new invitation (RESEND)', async () => {
    send
      .mockRejectedValueOnce(awsError('UsernameExistsException'))
      .mockResolvedValueOnce({});
    const result = await new CognitoStaffLoginProvider().inviteLogin({
      email: 'pending@example.com',
      displayName: 'P',
    });
    expect(result).toEqual({ outcome: 'invited' });
    expect(inputs()[1]).toEqual({
      UserPoolId: POOL,
      Username: 'pending@example.com',
      MessageAction: 'RESEND',
      DesiredDeliveryMediums: ['EMAIL'],
    });
  });

  it('a login that is already set up is reported and NEVER changed (no attributes, no password)', async () => {
    send
      .mockRejectedValueOnce(awsError('UsernameExistsException'))
      .mockRejectedValueOnce(awsError('UnsupportedUserStateException'));
    const result = await new CognitoStaffLoginProvider().inviteLogin({
      email: 'existing@example.com',
      displayName: 'E',
    });
    expect(result).toEqual({ outcome: 'existing-login' });
    // The second call is a RESEND only — Cognito refuses it for a set-up
    // login; no UserAttributes are ever sent for an existing login.
    expect(inputs()[1]).not.toHaveProperty('UserAttributes');
  });

  it.each([
    ['TooManyRequestsException'],
    ['LimitExceededException'],
    ['AccessDeniedException'],
    ['ResourceNotFoundException'],
    ['TimeoutError'],
    ['SomethingNew'],
  ])('%s: nothing is claimed as sent (unavailable)', async (name) => {
    send.mockRejectedValueOnce(awsError(name));
    expect(
      await new CognitoStaffLoginProvider().inviteLogin({
        email: 'x@example.com',
        displayName: 'X',
      }),
    ).toEqual({ outcome: 'unavailable' });
    // The address is never logged.
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/x@example\.com/);
  });

  it('a failed RESEND for an unclear reason is unavailable too', async () => {
    send
      .mockRejectedValueOnce(awsError('UsernameExistsException'))
      .mockRejectedValueOnce(awsError('TooManyRequestsException'));
    expect(
      await new CognitoStaffLoginProvider().inviteLogin({
        email: 'x@example.com',
        displayName: 'X',
      }),
    ).toEqual({ outcome: 'unavailable' });
  });

  it('an address Cognito refuses is invalid-email; a missing pool is unavailable without any call', async () => {
    send.mockRejectedValueOnce(
      awsError('InvalidParameterException', 'Invalid email address format.'),
    );
    expect(
      await new CognitoStaffLoginProvider().inviteLogin({
        email: 'odd@example.com',
        displayName: 'O',
      }),
    ).toEqual({ outcome: 'invalid-email' });

    delete process.env.INTERNAL_COGNITO_USER_POOL_ID;
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    send.mockClear();
    expect(
      await new CognitoStaffLoginProvider().inviteLogin({
        email: 'x@example.com',
        displayName: 'X',
      }),
    ).toEqual({ outcome: 'unavailable' });
    expect(send).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
