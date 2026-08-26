import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { CustomerSignInRequest } from '@mocha-house/contracts';
import { requireEnv } from './require-env';
import type {
  CustomerAuthProvider,
  CustomerSignInOutcome,
} from '../application/customer-sign-in.types';

// Cognito error types that unambiguously mean "the credentials were
// rejected" — mapped to the same generic invalid-credentials outcome as any
// other rejection, never surfaced individually, so a caller can't use the
// response to enumerate valid usernames.
const CREDENTIAL_REJECTION_TYPES = new Set([
  'NotAuthorizedException',
  'UserNotFoundException',
  'UserNotConfirmedException',
  'PasswordResetRequiredException',
]);

interface CognitoInitiateAuthResponse {
  AuthenticationResult?: { IdToken?: string; ExpiresIn?: number };
  __type?: string;
}

// Calls Cognito's InitiateAuth (USER_PASSWORD_AUTH) directly over HTTPS.
// This is Cognito's plain, unsigned JSON protocol for a public app client —
// it needs no AWS credentials/SigV4, only the app client id, which is not a
// secret. Cognito itself verifies the password; this process never stores
// or re-implements that check (see architecture guardrail: no custom
// production password system).
@Injectable()
export class CognitoAuthProvider implements CustomerAuthProvider {
  async signIn(request: CustomerSignInRequest): Promise<CustomerSignInOutcome> {
    const userPoolId = requireEnv('COGNITO_USER_POOL_ID');
    const clientId = requireEnv('COGNITO_CLIENT_ID');
    const region = userPoolId.split('_')[0];

    let response: Response;
    try {
      response = await fetch(`https://cognito-idp.${region}.amazonaws.com/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-amz-json-1.1',
          'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
        },
        body: JSON.stringify({
          AuthFlow: 'USER_PASSWORD_AUTH',
          ClientId: clientId,
          AuthParameters: {
            USERNAME: request.identifier,
            PASSWORD: request.password,
          },
        }),
      });
    } catch {
      throw new ServiceUnavailableException(
        'Could not reach the authentication service.',
      );
    }

    const body = (await response
      .json()
      .catch(() => null)) as CognitoInitiateAuthResponse | null;

    if (response.ok && body?.AuthenticationResult?.IdToken) {
      return {
        outcome: 'success',
        idToken: body.AuthenticationResult.IdToken,
        expiresInSeconds: body.AuthenticationResult.ExpiresIn ?? 3600,
      };
    }

    if (body?.__type && CREDENTIAL_REJECTION_TYPES.has(body.__type)) {
      return { outcome: 'invalid-credentials' };
    }

    throw new ServiceUnavailableException(
      'The authentication service returned an unexpected response.',
    );
  }
}
