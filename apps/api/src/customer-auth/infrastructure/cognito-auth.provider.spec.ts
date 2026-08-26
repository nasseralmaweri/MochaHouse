import { ServiceUnavailableException } from '@nestjs/common';
import { CognitoAuthProvider } from './cognito-auth.provider';

function mockFetchResolvedWith(response: {
  ok: boolean;
  body: Record<string, unknown>;
}): jest.SpiedFunction<typeof fetch> {
  return jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: response.ok,
    json: () => Promise.resolve(response.body),
  } as Response);
}

describe('CognitoAuthProvider', () => {
  const provider = new CognitoAuthProvider();
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.COGNITO_USER_POOL_ID = 'us-east-1_testpool';
    process.env.COGNITO_CLIENT_ID = 'test-client-id';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  it('calls Cognito InitiateAuth against the region derived from the user pool id', async () => {
    const fetchSpy = mockFetchResolvedWith({
      ok: true,
      body: {
        AuthenticationResult: { IdToken: 'id-token-value', ExpiresIn: 3600 },
      },
    });

    const result = await provider.signIn({
      identifier: 'test@example.com',
      password: 'correct-password',
    });

    expect(result).toEqual({
      outcome: 'success',
      idToken: 'id-token-value',
      expiresInSeconds: 3600,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, requestInit] = fetchSpy.mock.calls[0];
    expect(calledUrl).toBe('https://cognito-idp.us-east-1.amazonaws.com/');
    expect(requestInit?.method).toBe('POST');
    expect(
      (requestInit?.headers as Record<string, string>)['X-Amz-Target'],
    ).toBe('AWSCognitoIdentityProviderService.InitiateAuth');
    const body = JSON.parse(requestInit?.body as string) as {
      AuthFlow: string;
      AuthParameters: Record<string, string>;
    };
    expect(body.AuthFlow).toBe('USER_PASSWORD_AUTH');
    expect(body.AuthParameters).toEqual({
      USERNAME: 'test@example.com',
      PASSWORD: 'correct-password',
    });
  });

  it('maps a known Cognito auth-failure type to invalid-credentials without leaking which', async () => {
    mockFetchResolvedWith({
      ok: false,
      body: {
        __type: 'NotAuthorizedException',
        message: 'Incorrect username or password.',
      },
    });

    const result = await provider.signIn({
      identifier: 'test@example.com',
      password: 'wrong',
    });

    expect(result).toEqual({ outcome: 'invalid-credentials' });
  });

  it('throws for an unexpected/unrecognized response rather than guessing an outcome', async () => {
    mockFetchResolvedWith({
      ok: false,
      body: { __type: 'InternalErrorException' },
    });

    await expect(
      provider.signIn({ identifier: 'test@example.com', password: 'x' }),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it('throws when the network call itself fails', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('network down'));

    await expect(
      provider.signIn({ identifier: 'test@example.com', password: 'x' }),
    ).rejects.toThrow(ServiceUnavailableException);
  });
});
