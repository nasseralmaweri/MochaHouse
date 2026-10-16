import { Injectable } from '@nestjs/common';
import { platformCognitoConfig } from '../infrastructure/platform-config';
import type { PlatformChallengeRecord } from './platform-challenge-store';
import {
  PlatformSignInRefusedError,
  type PlatformSignInCompletion,
  type PlatformSignInProvider,
  type PlatformSignInStart,
} from './platform-sign-in.types';

// SC1b — sign-in against the DEDICATED platform Cognito pool (SC1a):
//
//   InitiateAuth (USER_PASSWORD_AUTH)
//     -> SOFTWARE_TOKEN_MFA  -> RespondToAuthChallenge(code)      -> ID token
//     -> MFA_SETUP           -> AssociateSoftwareToken -> secret
//                               VerifySoftwareToken(code)
//                               RespondToAuthChallenge(MFA_SETUP) -> ID token
//
// MFA is mandatory here, independently of the pool: if Cognito ever answers
// InitiateAuth with tokens and NO MFA challenge (an MFA-optional or
// misconfigured pool), the sign-in is REFUSED and nothing is returned. Any
// challenge other than the two above (SMS, custom, new password ...) is
// refused too. Cognito error details never leave this file: callers get one
// of a few generic outcomes.
//
// Public app client, no secret (no SECRET_HASH), like the staff boundary.
// No AWS credentials: these are the unauthenticated user-pool APIs.

const CREDENTIAL_REJECTION_TYPES = new Set([
  'NotAuthorizedException',
  'UserNotFoundException',
  'UserNotConfirmedException',
]);
const ACCOUNT_SETUP_TYPES = new Set(['PasswordResetRequiredException']);
const CODE_REJECTION_TYPES = new Set([
  'CodeMismatchException',
  'ExpiredCodeException',
  'EnableSoftwareTokenMFAException',
  // A spent or expired challenge session.
  'NotAuthorizedException',
]);

interface CognitoErrorBody {
  __type?: string;
}
interface CognitoAuthResponse {
  AuthenticationResult?: { IdToken?: string; ExpiresIn?: number };
  ChallengeName?: string;
  Session?: string;
  ChallengeParameters?: Record<string, string>;
}

type CognitoResult<T> =
  { ok: true; body: T } | { ok: false; type: string | null };

async function callPlatformCognito<T>(
  target: string,
  body: Record<string, unknown>,
): Promise<CognitoResult<T>> {
  const { userPoolId } = platformCognitoConfig();
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
    throw new PlatformSignInRefusedError(
      'The platform identity provider could not be reached.',
    );
  }
  const parsed: unknown = await response.json().catch(() => null);
  if (response.ok) {
    return { ok: true, body: parsed as T };
  }
  return {
    ok: false,
    type: (parsed as CognitoErrorBody | null)?.__type?.split('#').pop() ?? null,
  };
}

function authenticated(body: CognitoAuthResponse): PlatformSignInCompletion {
  const idToken = body.AuthenticationResult?.IdToken;
  if (!idToken) {
    throw new PlatformSignInRefusedError(
      'The identity provider did not complete the sign-in.',
    );
  }
  return {
    outcome: 'authenticated',
    idToken,
    expiresInSeconds: body.AuthenticationResult?.ExpiresIn ?? 3600,
  };
}

function requireSession(record: PlatformChallengeRecord): string {
  if (record.provider !== 'cognito' || !record.cognitoSession) {
    throw new PlatformSignInRefusedError('Not a Cognito sign-in challenge.');
  }
  return record.cognitoSession;
}

@Injectable()
export class PlatformCognitoSignInProvider implements PlatformSignInProvider {
  async start(email: string, password: string): Promise<PlatformSignInStart> {
    const { clientId } = platformCognitoConfig();
    const result = await callPlatformCognito<CognitoAuthResponse>(
      'InitiateAuth',
      {
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: clientId,
        AuthParameters: { USERNAME: email, PASSWORD: password },
      },
    );
    if (!result.ok) {
      if (result.type && CREDENTIAL_REJECTION_TYPES.has(result.type)) {
        return { outcome: 'invalid-credentials' };
      }
      if (result.type && ACCOUNT_SETUP_TYPES.has(result.type)) {
        return { outcome: 'account-setup-required' };
      }
      throw new PlatformSignInRefusedError(
        'The identity provider rejected the sign-in unexpectedly.',
      );
    }
    const body = result.body;
    if (body.AuthenticationResult) {
      // Tokens without a second factor: the pool is not enforcing MFA.
      throw new PlatformSignInRefusedError(
        'The platform identity provider issued tokens without MFA; refusing.',
      );
    }
    const username = body.ChallengeParameters?.USER_ID_FOR_SRP ?? email;
    switch (body.ChallengeName) {
      case 'SOFTWARE_TOKEN_MFA':
      case 'MFA_SETUP':
        if (!body.Session) {
          throw new PlatformSignInRefusedError('Missing challenge session.');
        }
        return {
          outcome: 'challenge',
          record: {
            provider: 'cognito',
            kind: body.ChallengeName === 'MFA_SETUP' ? 'mfa-setup' : 'mfa',
            username,
            cognitoSession: body.Session,
            secretIssued: false,
          },
        };
      case 'NEW_PASSWORD_REQUIRED':
        return { outcome: 'account-setup-required' };
      default:
        throw new PlatformSignInRefusedError(
          'The identity provider asked for an unsupported challenge.',
        );
    }
  }

  async respondToMfa(
    record: PlatformChallengeRecord,
    code: string,
  ): Promise<PlatformSignInCompletion> {
    if (record.kind !== 'mfa') {
      throw new PlatformSignInRefusedError('Not an MFA challenge.');
    }
    const { clientId } = platformCognitoConfig();
    const result = await callPlatformCognito<CognitoAuthResponse>(
      'RespondToAuthChallenge',
      {
        ClientId: clientId,
        ChallengeName: 'SOFTWARE_TOKEN_MFA',
        Session: requireSession(record),
        ChallengeResponses: {
          USERNAME: record.username,
          SOFTWARE_TOKEN_MFA_CODE: code,
        },
      },
    );
    if (!result.ok) {
      if (result.type && CODE_REJECTION_TYPES.has(result.type)) {
        return { outcome: 'invalid-code' };
      }
      throw new PlatformSignInRefusedError(
        'The identity provider rejected the MFA step unexpectedly.',
      );
    }
    if (result.body.ChallengeName) {
      throw new PlatformSignInRefusedError(
        'The identity provider asked for a further challenge.',
      );
    }
    return authenticated(result.body);
  }

  async beginMfaSetup(
    record: PlatformChallengeRecord,
  ): Promise<{ secret: string; record: PlatformChallengeRecord }> {
    if (record.kind !== 'mfa-setup') {
      throw new PlatformSignInRefusedError('Not an MFA enrolment challenge.');
    }
    const result = await callPlatformCognito<{
      SecretCode?: string;
      Session?: string;
    }>('AssociateSoftwareToken', { Session: requireSession(record) });
    if (!result.ok || !result.body.SecretCode || !result.body.Session) {
      throw new PlatformSignInRefusedError(
        'The identity provider could not start authenticator enrolment.',
      );
    }
    return {
      secret: result.body.SecretCode,
      record: {
        ...record,
        cognitoSession: result.body.Session,
        secretIssued: true,
      },
    };
  }

  async completeMfaSetup(
    record: PlatformChallengeRecord,
    code: string,
  ): Promise<PlatformSignInCompletion> {
    if (record.kind !== 'mfa-setup' || !record.secretIssued) {
      throw new PlatformSignInRefusedError('No authenticator enrolment.');
    }
    const verified = await callPlatformCognito<{
      Status?: string;
      Session?: string;
    }>('VerifySoftwareToken', {
      Session: requireSession(record),
      UserCode: code,
      FriendlyDeviceName: 'CENTERIVO platform',
    });
    if (!verified.ok) {
      if (verified.type && CODE_REJECTION_TYPES.has(verified.type)) {
        return { outcome: 'invalid-code' };
      }
      throw new PlatformSignInRefusedError(
        'The identity provider rejected the enrolment unexpectedly.',
      );
    }
    if (verified.body.Status !== 'SUCCESS' || !verified.body.Session) {
      return { outcome: 'invalid-code' };
    }
    const { clientId } = platformCognitoConfig();
    const result = await callPlatformCognito<CognitoAuthResponse>(
      'RespondToAuthChallenge',
      {
        ClientId: clientId,
        ChallengeName: 'MFA_SETUP',
        Session: verified.body.Session,
        ChallengeResponses: { USERNAME: record.username },
      },
    );
    if (!result.ok || result.body.ChallengeName) {
      throw new PlatformSignInRefusedError(
        'The identity provider did not complete the enrolment.',
      );
    }
    return authenticated(result.body);
  }
}
