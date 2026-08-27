import { ServiceUnavailableException } from '@nestjs/common';
import { requireEnv } from './require-env';

export interface CognitoErrorBody {
  __type?: string;
  message?: string;
}

export type CognitoResult<T> =
  { ok: true; body: T } | { ok: false; body: CognitoErrorBody | null };

// Shared plumbing for Cognito's plain, unsigned JSON protocol (a public
// app client needs no AWS credentials/SigV4 — see cognito-auth.provider.ts
// for why) — used by every Cognito operation this boundary calls
// (InitiateAuth, SignUp, ConfirmSignUp, ResendConfirmationCode). Each
// caller still owns mapping that specific operation's `__type` values to
// its own outcome type; this only owns making the call and parsing the
// response envelope, so that mapping never has to duplicate the
// fetch/error-handling boilerplate.
export async function callCognito<T>(
  target: string,
  body: Record<string, unknown>,
): Promise<CognitoResult<T>> {
  const userPoolId = requireEnv('COGNITO_USER_POOL_ID');
  const region = userPoolId.split('_')[0];

  let response: Response;
  try {
    response = await fetch(`https://cognito-idp.${region}.amazonaws.com/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ServiceUnavailableException(
      'Could not reach the authentication service.',
    );
  }

  const parsed: unknown = await response.json().catch(() => null);
  if (response.ok) {
    return { ok: true, body: parsed as T };
  }
  return { ok: false, body: parsed as CognitoErrorBody | null };
}
