import { ServiceUnavailableException } from '@nestjs/common';
import { requireInternalEnv } from './require-internal-env';

export interface CognitoErrorBody {
  __type?: string;
  message?: string;
}

export type CognitoResult<T> =
  { ok: true; body: T } | { ok: false; body: CognitoErrorBody | null };

// Shared plumbing for Cognito's plain, unsigned JSON protocol, scoped to
// the INTERNAL user pool (region is derived from
// INTERNAL_COGNITO_USER_POOL_ID). A separate copy of the customer
// boundary's cognito-client so the internal boundary never reads customer
// Cognito configuration. Only InitiateAuth is used today; the envelope
// parsing is kept generic to match the customer version's shape.
export async function callInternalCognito<T>(
  target: string,
  body: Record<string, unknown>,
): Promise<CognitoResult<T>> {
  const userPoolId = requireInternalEnv('INTERNAL_COGNITO_USER_POOL_ID');
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
