import { ServiceUnavailableException } from '@nestjs/common';
import { InternalCognitoAuthProvider } from './internal-cognito-auth.provider';

// V1 launch fix 2 — staff sign-in against the INTERNAL Cognito pool, with
// Cognito MOCKED at the HTTP boundary (no AWS call): a login created by an
// administrator's invitation answers its first sign-in with
// NEW_PASSWORD_REQUIRED; the person's own password goes straight to Cognito.

const POOL = 'us-east-1_TestPool1';

function reply(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('InternalCognitoAuthProvider (mocked Cognito)', () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;
  const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>();

  beforeEach(() => {
    process.env.INTERNAL_COGNITO_USER_POOL_ID = POOL;
    process.env.INTERNAL_COGNITO_CLIENT_ID = 'test-client';
    fetchMock.mockReset();
    global.fetch = fetchMock;
  });
  afterAll(() => {
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  const target = (i: number) =>
    (fetchMock.mock.calls[i][1].headers as Record<string, string>)[
      'X-Amz-Target'
    ];
  const sent = (i: number) =>
    JSON.parse(fetchMock.mock.calls[i][1].body as string) as Record<
      string,
      unknown
    >;

  it('a first sign-in with the temporary password asks for a new password', async () => {
    fetchMock.mockResolvedValueOnce(
      reply(200, { ChallengeName: 'NEW_PASSWORD_REQUIRED', Session: 'sess-1' }),
    );
    const result = await new InternalCognitoAuthProvider().signIn({
      identifier: 'new@example.com',
      password: 'Temp-From-Email-1',
    });
    expect(result).toEqual({
      outcome: 'new-password-required',
      session: 'sess-1',
    });
    expect(target(0)).toBe('AWSCognitoIdentityProviderService.InitiateAuth');
  });

  it("answers the challenge with the person's own password and returns their token", async () => {
    fetchMock.mockResolvedValueOnce(
      reply(200, {
        AuthenticationResult: { IdToken: 'id-token', ExpiresIn: 3600 },
      }),
    );
    const result = await new InternalCognitoAuthProvider().completeNewPassword({
      identifier: 'new@example.com',
      session: 'sess-1',
      newPassword: 'My-Own-Strong-Pass-9',
    });
    expect(result).toEqual({
      outcome: 'success',
      idToken: 'id-token',
      expiresInSeconds: 3600,
    });
    expect(target(0)).toBe(
      'AWSCognitoIdentityProviderService.RespondToAuthChallenge',
    );
    expect(sent(0)).toEqual({
      ChallengeName: 'NEW_PASSWORD_REQUIRED',
      ClientId: 'test-client',
      Session: 'sess-1',
      ChallengeResponses: {
        USERNAME: 'new@example.com',
        NEW_PASSWORD: 'My-Own-Strong-Pass-9',
      },
    });
  });

  it('a weak password and an expired setup are told apart; anything else is a 503', async () => {
    const provider = new InternalCognitoAuthProvider();
    const answer = () =>
      provider.completeNewPassword({
        identifier: 'new@example.com',
        session: 'sess-1',
        newPassword: 'x',
      });
    fetchMock.mockResolvedValueOnce(
      reply(400, { __type: 'InvalidPasswordException' }),
    );
    expect(await answer()).toEqual({ outcome: 'invalid-password' });
    fetchMock.mockResolvedValueOnce(
      reply(400, {
        __type: 'NotAuthorizedException',
        message: 'Invalid session',
      }),
    );
    expect(await answer()).toEqual({ outcome: 'session-expired' });
    fetchMock.mockResolvedValueOnce(
      reply(500, { __type: 'InternalErrorException' }),
    );
    await expect(answer()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('an unsupported challenge (e.g. MFA) is never treated as signed in', async () => {
    fetchMock.mockResolvedValueOnce(
      reply(200, { ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: 's' }),
    );
    await expect(
      new InternalCognitoAuthProvider().signIn({
        identifier: 'a@example.com',
        password: 'p',
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
