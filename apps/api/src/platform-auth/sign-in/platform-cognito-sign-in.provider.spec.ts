import { PlatformCognitoSignInProvider } from './platform-cognito-sign-in.provider';
import type { PlatformChallengeRecord } from './platform-challenge-store';
import { PlatformSignInRefusedError } from './platform-sign-in.types';
import { PlatformAuthNotConfiguredError } from '../infrastructure/platform-config';

// SC1b — the dedicated-pool Cognito sign-in, against a scripted Cognito
// (fetch is replaced; no AWS is contacted). Every branch that could lead to a
// session without the second factor must refuse; every Cognito error must
// collapse to a generic outcome.
describe('PlatformCognitoSignInProvider', () => {
  const provider = new PlatformCognitoSignInProvider();
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };
  let fetchMock: jest.Mock;

  const respond = (status: number, body: unknown) =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    }) as unknown as Response;
  const calls = () =>
    fetchMock.mock.calls.map(([url, init]: [string, RequestInit]) => ({
      url,
      target: (init.headers as Record<string, string>)['X-Amz-Target'],
      body: JSON.parse(init.body as string) as Record<string, unknown>,
    }));

  const mfaRecord: PlatformChallengeRecord = {
    provider: 'cognito',
    kind: 'mfa',
    username: 'op@example.test',
    cognitoSession: 'session-1',
    secretIssued: false,
  };
  const setupRecord: PlatformChallengeRecord = {
    ...mfaRecord,
    kind: 'mfa-setup',
  };

  beforeEach(() => {
    process.env.PLATFORM_COGNITO_USER_POOL_ID = 'eu-west-1_Platform1';
    process.env.PLATFORM_COGNITO_CLIENT_ID = 'platformclient';
    process.env.INTERNAL_COGNITO_USER_POOL_ID = 'eu-west-1_Staff1';
    process.env.INTERNAL_COGNITO_CLIENT_ID = 'staffclient';
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });
  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  describe('start (password step)', () => {
    it('calls InitiateAuth on the platform pool with the platform client only', async () => {
      fetchMock.mockResolvedValue(
        respond(200, {
          ChallengeName: 'SOFTWARE_TOKEN_MFA',
          Session: 'session-1',
          ChallengeParameters: { USER_ID_FOR_SRP: 'user-sub-name' },
        }),
      );
      const outcome = await provider.start('op@example.test', 'pw');
      expect(outcome).toEqual({
        outcome: 'challenge',
        record: {
          provider: 'cognito',
          kind: 'mfa',
          username: 'user-sub-name',
          cognitoSession: 'session-1',
          secretIssued: false,
        },
      });
      expect(calls()).toEqual([
        {
          url: 'https://cognito-idp.eu-west-1.amazonaws.com/',
          target: 'AWSCognitoIdentityProviderService.InitiateAuth',
          body: {
            AuthFlow: 'USER_PASSWORD_AUTH',
            ClientId: 'platformclient',
            AuthParameters: { USERNAME: 'op@example.test', PASSWORD: 'pw' },
          },
        },
      ]);
    });

    it('a first sign-in asks for authenticator enrolment (MFA_SETUP)', async () => {
      fetchMock.mockResolvedValue(
        respond(200, { ChallengeName: 'MFA_SETUP', Session: 's' }),
      );
      const outcome = await provider.start('op@example.test', 'pw');
      expect(outcome).toMatchObject({
        outcome: 'challenge',
        record: { kind: 'mfa-setup', cognitoSession: 's' },
      });
    });

    it('REFUSES tokens issued without an MFA challenge (pool not enforcing MFA)', async () => {
      fetchMock.mockResolvedValue(
        respond(200, { AuthenticationResult: { IdToken: 'id.token.value' } }),
      );
      await expect(provider.start('op@example.test', 'pw')).rejects.toThrow(
        PlatformSignInRefusedError,
      );
    });

    it.each(['SMS_MFA', 'CUSTOM_CHALLENGE', 'SELECT_MFA_TYPE', undefined])(
      'refuses any other challenge (%s)',
      async (name) => {
        fetchMock.mockResolvedValue(
          respond(200, { ChallengeName: name, Session: 's' }),
        );
        await expect(provider.start('op@example.test', 'pw')).rejects.toThrow(
          PlatformSignInRefusedError,
        );
      },
    );

    it('a temporary password or forced reset needs an administrator, not a session', async () => {
      fetchMock.mockResolvedValueOnce(
        respond(200, { ChallengeName: 'NEW_PASSWORD_REQUIRED', Session: 's' }),
      );
      expect(await provider.start('a@example.test', 'pw')).toEqual({
        outcome: 'account-setup-required',
      });
      fetchMock.mockResolvedValueOnce(
        respond(400, {
          __type: 'PasswordResetRequiredException',
          message: 'Password reset required',
        }),
      );
      expect(await provider.start('a@example.test', 'pw')).toEqual({
        outcome: 'account-setup-required',
      });
    });

    it.each([
      'NotAuthorizedException',
      'UserNotFoundException',
      'UserNotConfirmedException',
      'com.amazonaws#NotAuthorizedException',
    ])('%s is the same generic invalid-credentials outcome', async (type) => {
      fetchMock.mockResolvedValue(
        respond(400, {
          __type: type,
          message: 'Incorrect username or password.',
        }),
      );
      expect(await provider.start('a@example.test', 'pw')).toEqual({
        outcome: 'invalid-credentials',
      });
    });

    it('any other error or an unreachable provider fails closed', async () => {
      fetchMock.mockResolvedValueOnce(
        respond(400, { __type: 'InvalidParameterException' }),
      );
      await expect(provider.start('a@example.test', 'pw')).rejects.toThrow(
        PlatformSignInRefusedError,
      );
      fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
      await expect(provider.start('a@example.test', 'pw')).rejects.toThrow(
        PlatformSignInRefusedError,
      );
    });

    it('a platform pool shared with the staff pool is never called', async () => {
      process.env.PLATFORM_COGNITO_USER_POOL_ID =
        process.env.INTERNAL_COGNITO_USER_POOL_ID;
      await expect(provider.start('a@example.test', 'pw')).rejects.toThrow(
        PlatformAuthNotConfiguredError,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('MFA step', () => {
    it('answers SOFTWARE_TOKEN_MFA and returns the ID token', async () => {
      fetchMock.mockResolvedValue(
        respond(200, {
          AuthenticationResult: { IdToken: 'id.token', ExpiresIn: 1800 },
        }),
      );
      expect(await provider.respondToMfa(mfaRecord, '123456')).toEqual({
        outcome: 'authenticated',
        idToken: 'id.token',
        expiresInSeconds: 1800,
      });
      expect(calls()[0]).toMatchObject({
        target: 'AWSCognitoIdentityProviderService.RespondToAuthChallenge',
        body: {
          ClientId: 'platformclient',
          ChallengeName: 'SOFTWARE_TOKEN_MFA',
          Session: 'session-1',
          ChallengeResponses: {
            USERNAME: 'op@example.test',
            SOFTWARE_TOKEN_MFA_CODE: '123456',
          },
        },
      });
    });

    it.each([
      'CodeMismatchException',
      'ExpiredCodeException',
      'NotAuthorizedException',
    ])('%s is a generic invalid-code', async (type) => {
      fetchMock.mockResolvedValue(respond(400, { __type: type }));
      expect(await provider.respondToMfa(mfaRecord, '123456')).toEqual({
        outcome: 'invalid-code',
      });
    });

    it('refuses a further challenge or a response without a token', async () => {
      fetchMock.mockResolvedValueOnce(
        respond(200, { ChallengeName: 'SMS_MFA', Session: 's2' }),
      );
      await expect(provider.respondToMfa(mfaRecord, '123456')).rejects.toThrow(
        PlatformSignInRefusedError,
      );
      fetchMock.mockResolvedValueOnce(respond(200, {}));
      await expect(provider.respondToMfa(mfaRecord, '123456')).rejects.toThrow(
        PlatformSignInRefusedError,
      );
    });

    it('refuses a record of the wrong kind or provider without calling Cognito', async () => {
      await expect(
        provider.respondToMfa(setupRecord, '123456'),
      ).rejects.toThrow();
      await expect(
        provider.respondToMfa(
          { ...mfaRecord, provider: 'dev', cognitoSession: null },
          '123456',
        ),
      ).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('first-time authenticator enrolment', () => {
    it('associates a software token and carries Cognito’s new session forward', async () => {
      fetchMock.mockResolvedValue(
        respond(200, { SecretCode: 'BASE32SECRET', Session: 'session-2' }),
      );
      const result = await provider.beginMfaSetup(setupRecord);
      expect(result).toEqual({
        secret: 'BASE32SECRET',
        record: {
          ...setupRecord,
          cognitoSession: 'session-2',
          secretIssued: true,
        },
      });
      expect(calls()[0]).toMatchObject({
        target: 'AWSCognitoIdentityProviderService.AssociateSoftwareToken',
        body: { Session: 'session-1' },
      });
    });

    it('verifies the first code, then completes MFA_SETUP for the ID token', async () => {
      fetchMock
        .mockResolvedValueOnce(
          respond(200, { Status: 'SUCCESS', Session: 'session-3' }),
        )
        .mockResolvedValueOnce(
          respond(200, { AuthenticationResult: { IdToken: 'id.token' } }),
        );
      const outcome = await provider.completeMfaSetup(
        { ...setupRecord, cognitoSession: 'session-2', secretIssued: true },
        '654321',
      );
      expect(outcome).toEqual({
        outcome: 'authenticated',
        idToken: 'id.token',
        expiresInSeconds: 3600,
      });
      expect(calls().map((c) => [c.target, c.body])).toEqual([
        [
          'AWSCognitoIdentityProviderService.VerifySoftwareToken',
          {
            Session: 'session-2',
            UserCode: '654321',
            FriendlyDeviceName: 'CENTERIVO platform',
          },
        ],
        [
          'AWSCognitoIdentityProviderService.RespondToAuthChallenge',
          {
            ClientId: 'platformclient',
            ChallengeName: 'MFA_SETUP',
            Session: 'session-3',
            ChallengeResponses: { USERNAME: 'op@example.test' },
          },
        ],
      ]);
    });

    it('a wrong first code is invalid-code and completes nothing', async () => {
      fetchMock.mockResolvedValue(
        respond(400, { __type: 'EnableSoftwareTokenMFAException' }),
      );
      expect(
        await provider.completeMfaSetup(
          { ...setupRecord, secretIssued: true },
          '000000',
        ),
      ).toEqual({ outcome: 'invalid-code' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('cannot complete an enrolment for which no secret was issued', async () => {
      await expect(
        provider.completeMfaSetup(setupRecord, '654321'),
      ).rejects.toThrow(PlatformSignInRefusedError);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
