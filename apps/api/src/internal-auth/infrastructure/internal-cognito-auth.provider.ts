import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { InternalSignInRequest } from '@mocha-house/contracts';
import { requireInternalEnv } from './require-internal-env';
import { callInternalCognito } from './internal-cognito-client';
import type {
  InternalAuthProvider,
  InternalNewPasswordOutcome,
  InternalSignInOutcome,
} from '../application/internal-sign-in.types';

// Cognito error types that unambiguously mean "the credentials were
// rejected" — all mapped to the same generic invalid-credentials outcome so
// a caller cannot use the response to enumerate valid internal usernames.
const CREDENTIAL_REJECTION_TYPES = new Set([
  'NotAuthorizedException',
  'UserNotFoundException',
  'UserNotConfirmedException',
  'PasswordResetRequiredException',
]);

interface CognitoAuthResponse {
  AuthenticationResult?: { IdToken?: string; ExpiresIn?: number };
  ChallengeName?: string;
  Session?: string;
}

// Production internal sign-in. Calls the INTERNAL Cognito user pool's
// InitiateAuth (USER_PASSWORD_AUTH). Cognito verifies the password; this
// process never stores or re-implements that check.
//
// Like the customer provider, this expects a PUBLIC internal app client (no
// client secret) with ALLOW_USER_PASSWORD_AUTH enabled — no SECRET_HASH is
// computed. Supporting a confidential client is out of scope for 5A. No
// production AWS infrastructure is provisioned by this codebase; this path
// is inert until INTERNAL_COGNITO_* point at a real pool.
//
// V1 launch fix 2 — a login created by an administrator's invitation
// (AdminCreateUser) answers its first sign-in with the NEW_PASSWORD_REQUIRED
// challenge: the person chooses their own password, which goes straight to
// Cognito (RespondToAuthChallenge) and is never stored here. Any other
// challenge (e.g. MFA, if ever enabled on the pool) is not supported yet and
// is a 503, never a guessed success.
@Injectable()
export class InternalCognitoAuthProvider implements InternalAuthProvider {
  async signIn(request: InternalSignInRequest): Promise<InternalSignInOutcome> {
    const clientId = requireInternalEnv('INTERNAL_COGNITO_CLIENT_ID');

    const result = await callInternalCognito<CognitoAuthResponse>(
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
      result.ok &&
      result.body.ChallengeName === 'NEW_PASSWORD_REQUIRED' &&
      typeof result.body.Session === 'string' &&
      result.body.Session.length > 0
    ) {
      return { outcome: 'new-password-required', session: result.body.Session };
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

  async completeNewPassword(request: {
    identifier: string;
    session: string;
    newPassword: string;
  }): Promise<InternalNewPasswordOutcome> {
    const clientId = requireInternalEnv('INTERNAL_COGNITO_CLIENT_ID');

    const result = await callInternalCognito<CognitoAuthResponse>(
      'RespondToAuthChallenge',
      {
        ChallengeName: 'NEW_PASSWORD_REQUIRED',
        ClientId: clientId,
        Session: request.session,
        ChallengeResponses: {
          USERNAME: request.identifier,
          NEW_PASSWORD: request.newPassword,
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
    if (!result.ok && result.body?.__type === 'InvalidPasswordException') {
      return { outcome: 'invalid-password' };
    }
    if (
      !result.ok &&
      result.body?.__type &&
      (CREDENTIAL_REJECTION_TYPES.has(result.body.__type) ||
        result.body.__type === 'ExpiredCodeException' ||
        result.body.__type === 'CodeMismatchException')
    ) {
      return { outcome: 'session-expired' };
    }
    throw new ServiceUnavailableException(
      'The authentication service returned an unexpected response.',
    );
  }
}
