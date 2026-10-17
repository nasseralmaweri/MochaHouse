import { ServiceUnavailableException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import type { InternalCognitoTokenVerifier } from '../../internal-auth/infrastructure/internal-cognito-token-verifier';
import {
  CognitoOwnerRegistrationProvider,
  cognitoSecretHash,
} from './cognito-owner-registration.provider';

// SC4a — the Cognito side of owner registration, with Cognito's HTTP API
// mocked: every registration call goes through the CONFIDENTIAL registration
// client with a correct SECRET_HASH, and every provider answer maps to an
// outcome or a 503 — never a guess.
type Reply = { ok: boolean; body: Record<string, unknown> };

const EMAIL = 'owner@example.com';
const CLIENT_ID = 'registration-client';
const CLIENT_SECRET = 'registration-client-secret';

function mockFetch(...replies: Reply[]) {
  const spy = jest.spyOn(global, 'fetch');
  for (const reply of replies) {
    spy.mockResolvedValueOnce({
      ok: reply.ok,
      json: () => Promise.resolve(reply.body),
    } as Response);
  }
  return spy;
}

function sent(spy: jest.SpiedFunction<typeof fetch>, call = 0) {
  const [url, init] = spy.mock.calls[call];
  const headers = (init as RequestInit).headers as Record<string, string>;
  return {
    url,
    target: headers['X-Amz-Target'],
    body: JSON.parse((init as RequestInit).body as string) as Record<
      string,
      unknown
    >,
  };
}

const fail = (type: string, message = '') => ({
  ok: false,
  body: { __type: type, message },
});

describe('CognitoOwnerRegistrationProvider', () => {
  const signIn = jest.fn();
  const verify = jest.fn();
  const provider = new CognitoOwnerRegistrationProvider({ signIn }, {
    verify,
  } as unknown as InternalCognitoTokenVerifier);
  const originalEnv = { ...process.env };
  const expectedHash = createHmac('sha256', CLIENT_SECRET)
    .update(EMAIL + CLIENT_ID)
    .digest('base64');

  beforeEach(() => {
    process.env.INTERNAL_COGNITO_USER_POOL_ID = 'eu-west-1_staffpool';
    process.env.INTERNAL_COGNITO_CLIENT_ID = 'staff-sign-in-client';
    process.env.INTERNAL_COGNITO_REGISTRATION_CLIENT_ID = CLIENT_ID;
    process.env.INTERNAL_COGNITO_REGISTRATION_CLIENT_SECRET = CLIENT_SECRET;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
    signIn.mockReset();
    verify.mockReset();
  });

  it('computes the SECRET_HASH Cognito expects', () => {
    expect(cognitoSecretHash(EMAIL, CLIENT_ID, CLIENT_SECRET)).toBe(
      expectedHash,
    );
  });

  it('creates the login through the registration client only, with the email as the only attribute', async () => {
    const spy = mockFetch({ ok: true, body: { UserSub: 'sub-1' } });
    await expect(provider.createLogin(EMAIL, 'Initial-1!')).resolves.toEqual({
      outcome: 'created',
      subject: 'sub-1',
    });
    const call = sent(spy);
    expect(call.url).toBe('https://cognito-idp.eu-west-1.amazonaws.com/');
    expect(call.target).toBe('AWSCognitoIdentityProviderService.SignUp');
    expect(call.body).toEqual({
      ClientId: CLIENT_ID,
      SecretHash: expectedHash,
      Username: EMAIL,
      Password: 'Initial-1!',
      UserAttributes: [{ Name: 'email', Value: EMAIL }],
    });
  });

  it('never registers when the registration client is not configured', async () => {
    delete process.env.INTERNAL_COGNITO_REGISTRATION_CLIENT_SECRET;
    const spy = mockFetch();
    await expect(provider.createLogin(EMAIL, 'Initial-1!')).rejects.toThrow(
      /INTERNAL_COGNITO_REGISTRATION_CLIENT_SECRET/,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('maps an existing login to "exists" and anything unrecognised to a 503', async () => {
    mockFetch(fail('UsernameExistsException'));
    await expect(provider.createLogin(EMAIL, 'x')).resolves.toEqual({
      outcome: 'exists',
    });
    mockFetch(fail('InvalidPasswordException'));
    await expect(provider.createLogin(EMAIL, 'x')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('maps sign-up confirmation answers, and never treats "already confirmed" as a confirmation', async () => {
    const cases: [Reply, string][] = [
      [{ ok: true, body: {} }, 'confirmed'],
      [fail('CodeMismatchException'), 'invalid-code'],
      [fail('ExpiredCodeException'), 'expired-code'],
      [fail('TooManyFailedAttemptsException'), 'invalid-code'],
      [fail('AliasExistsException'), 'invalid-code'],
      [fail('UserNotFoundException'), 'not-found'],
      [
        fail(
          'NotAuthorizedException',
          'User cannot be confirmed. Current status is CONFIRMED',
        ),
        'already-confirmed',
      ],
    ];
    for (const [reply, outcome] of cases) {
      const spy = mockFetch(reply);
      await expect(provider.confirmSignUp(EMAIL, '123456')).resolves.toEqual({
        outcome,
      });
      expect(sent(spy).body).toMatchObject({
        ClientId: CLIENT_ID,
        SecretHash: expectedHash,
        ConfirmationCode: '123456',
      });
      spy.mockRestore();
    }
    mockFetch(fail('NotAuthorizedException', 'Something else'));
    await expect(provider.confirmSignUp(EMAIL, '1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('sets the password by signing in with the initial one through the registration client, then ChangePassword', async () => {
    const spy = mockFetch(
      { ok: true, body: { AuthenticationResult: { AccessToken: 'access' } } },
      { ok: true, body: {} },
    );
    await expect(
      provider.setPassword(EMAIL, 'Initial-1!', 'Chosen-Pass-1!'),
    ).resolves.toEqual({ outcome: 'set' });
    expect(sent(spy, 0).body).toEqual({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: CLIENT_ID,
      AuthParameters: {
        USERNAME: EMAIL,
        PASSWORD: 'Initial-1!',
        SECRET_HASH: expectedHash,
      },
    });
    expect(sent(spy, 1)).toMatchObject({
      target: 'AWSCognitoIdentityProviderService.ChangePassword',
      body: {
        AccessToken: 'access',
        PreviousPassword: 'Initial-1!',
        ProposedPassword: 'Chosen-Pass-1!',
      },
    });

    mockFetch(fail('NotAuthorizedException'));
    await expect(provider.setPassword(EMAIL, 'a', 'b')).resolves.toEqual({
      outcome: 'rejected',
    });
    mockFetch(
      { ok: true, body: { AuthenticationResult: { AccessToken: 'access' } } },
      fail('InvalidPasswordException'),
    );
    await expect(provider.setPassword(EMAIL, 'a', 'b')).resolves.toEqual({
      outcome: 'invalid-password',
    });
    // A challenge instead of tokens is never treated as success.
    mockFetch({ ok: true, body: { ChallengeName: 'NEW_PASSWORD_REQUIRED' } });
    await expect(provider.setPassword(EMAIL, 'a', 'b')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('maps resend and password-setup answers', async () => {
    mockFetch(fail('InvalidParameterException', 'User is already confirmed.'));
    await expect(provider.resendSignUpCode(EMAIL)).resolves.toEqual({
      outcome: 'already-confirmed',
    });
    mockFetch(fail('LimitExceededException'));
    await expect(provider.resendSignUpCode(EMAIL)).resolves.toEqual({
      outcome: 'throttled',
    });
    jest.restoreAllMocks();
    const spy = mockFetch({ ok: true, body: {} });
    await expect(provider.sendPasswordSetupCode(EMAIL)).resolves.toEqual({
      outcome: 'sent',
    });
    expect(sent(spy)).toMatchObject({
      target: 'AWSCognitoIdentityProviderService.ForgotPassword',
      body: { ClientId: CLIENT_ID, SecretHash: expectedHash, Username: EMAIL },
    });
    mockFetch(fail('CodeMismatchException'));
    await expect(
      provider.confirmPasswordSetup(EMAIL, '1', 'p'),
    ).resolves.toEqual({ outcome: 'invalid-code' });
    mockFetch(fail('InvalidPasswordException'));
    await expect(
      provider.confirmPasswordSetup(EMAIL, '1', 'p'),
    ).resolves.toEqual({ outcome: 'invalid-password' });
  });

  it('reports the login exactly as the staff boundary verifies it', async () => {
    signIn.mockResolvedValue({
      outcome: 'success',
      idToken: 'id-token',
      expiresInSeconds: 3600,
    });
    verify.mockResolvedValue({
      provider: 'cognito-internal',
      subject: 'sub-1',
      email: EMAIL,
      name: null,
      emailVerified: true,
    });
    await expect(provider.signIn(EMAIL, 'pw')).resolves.toEqual({
      provider: 'cognito-internal',
      subject: 'sub-1',
      email: EMAIL,
      emailVerified: true,
    });
    expect(verify).toHaveBeenCalledWith('id-token');
    signIn.mockResolvedValue({ outcome: 'invalid-credentials' });
    await expect(provider.signIn(EMAIL, 'pw')).resolves.toBeNull();
  });
});
