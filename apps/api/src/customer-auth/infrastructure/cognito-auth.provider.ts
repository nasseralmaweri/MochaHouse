import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { CustomerSignInRequest } from '@mocha-house/contracts';
import { requireEnv } from './require-env';
import { callCognito } from './cognito-client';
import type {
  CustomerAuthProvider,
  CustomerSignInOutcome,
} from '../application/customer-sign-in.types';

// Cognito error types that unambiguously mean "the credentials were
// rejected" — mapped to the same generic invalid-credentials outcome as any
// other rejection, never surfaced individually, so a caller can't use the
// response to enumerate valid usernames. UserNotConfirmedException also
// belongs here: an unverified registration (Milestone 4C) must not yield a
// valid session any more than a wrong password would.
const CREDENTIAL_REJECTION_TYPES = new Set([
  'NotAuthorizedException',
  'UserNotFoundException',
  'UserNotConfirmedException',
  'PasswordResetRequiredException',
]);

interface CognitoInitiateAuthResponse {
  AuthenticationResult?: { IdToken?: string; ExpiresIn?: number };
}

// Calls Cognito's InitiateAuth (USER_PASSWORD_AUTH). Cognito itself
// verifies the password; this process never stores or re-implements that
// check (see architecture guardrail: no custom production password
// system).
//
// This implementation deliberately expects the production app client to be
// a *public* client (no client secret) with ALLOW_USER_PASSWORD_AUTH
// enabled — no SECRET_HASH is computed or sent. If the configured app
// client has a secret instead, Cognito rejects every InitiateAuth call
// with NotAuthorizedException ("Unable to verify secret hash for client
// ..."), which CREDENTIAL_REJECTION_TYPES maps to the same
// invalid-credentials outcome as a wrong password — i.e. sign-in would
// fail for every customer, indistinguishably from bad credentials, until
// the app client configuration itself is fixed. Supporting a confidential
// client (computing SECRET_HASH) is out of scope for this slice.
@Injectable()
export class CognitoAuthProvider implements CustomerAuthProvider {
  async signIn(request: CustomerSignInRequest): Promise<CustomerSignInOutcome> {
    const clientId = requireEnv('COGNITO_CLIENT_ID');

    const result = await callCognito<CognitoInitiateAuthResponse>(
      'InitiateAuth',
      {
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: clientId,
        AuthParameters: {
          USERNAME: request.identifier,
          PASSWORD: request.password,
        },
      },
    );

    if (result.ok && result.body.AuthenticationResult?.IdToken) {
      return {
        outcome: 'success',
        idToken: result.body.AuthenticationResult.IdToken,
        expiresInSeconds: result.body.AuthenticationResult.ExpiresIn ?? 3600,
      };
    }

    if (
      !result.ok &&
      result.body?.__type &&
      CREDENTIAL_REJECTION_TYPES.has(result.body.__type)
    ) {
      return { outcome: 'invalid-credentials' };
    }

    throw new ServiceUnavailableException(
      'The authentication service returned an unexpected response.',
    );
  }
}
