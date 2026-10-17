import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { requireInternalEnv } from '../../internal-auth/infrastructure/require-internal-env';
import { callInternalCognito } from '../../internal-auth/infrastructure/internal-cognito-client';
import { InternalCognitoAuthProvider } from '../../internal-auth/infrastructure/internal-cognito-auth.provider';
import { InternalCognitoTokenVerifier } from '../../internal-auth/infrastructure/internal-cognito-token-verifier';
import type {
  ConfirmCodeOutcome,
  ConfirmPasswordSetupOutcome,
  CreateLoginOutcome,
  OwnerRegistrationProvider,
  SendCodeOutcome,
  SetPasswordOutcome,
  VerifiedLogin,
} from '../application/owner-registration-provider';

// SC4a — owner registration against the INTERNAL (staff) Cognito pool,
// through a DEDICATED, CONFIDENTIAL registration app client
// (INTERNAL_COGNITO_REGISTRATION_CLIENT_ID / _SECRET). Only this API holds
// the client secret, so only this API — behind the registration flag, rate
// limits and quotas — can compute the SECRET_HASH the client requires.
//
// Provider-level prerequisite (owner decision D9; an AWS change that needs
// its own approval, see docs/security/owner-self-registration.md): the pool's
// Pre sign-up trigger must refuse every SignUp that does not come from the
// registration client, so the public staff sign-in client can never be used
// to self-register around this API. Until that is in place this path must
// stay disabled (it is: SELF_SERVICE_REGISTRATION_ENABLED is off by default).
//
// Same plain JSON protocol as staff sign-in (no AWS credentials, no admin
// API). Cognito generates and emails every code; nothing here sees one.
// Unrecognised provider answers are a 503 — never guessed into an outcome.

interface SignUpResponse {
  UserSub?: string;
}

interface InitiateAuthResponse {
  AuthenticationResult?: { AccessToken?: string };
}

function registrationClient(): { clientId: string; clientSecret: string } {
  return {
    clientId: requireInternalEnv('INTERNAL_COGNITO_REGISTRATION_CLIENT_ID'),
    clientSecret: requireInternalEnv(
      'INTERNAL_COGNITO_REGISTRATION_CLIENT_SECRET',
    ),
  };
}

// Cognito's SECRET_HASH: Base64(HMAC-SHA256(secret, username + clientId)).
export function cognitoSecretHash(
  username: string,
  clientId: string,
  clientSecret: string,
): string {
  return createHmac('sha256', clientSecret)
    .update(username + clientId)
    .digest('base64');
}

function unexpected(): ServiceUnavailableException {
  return new ServiceUnavailableException(
    'The authentication service returned an unexpected response.',
  );
}

const THROTTLED = new Set([
  'LimitExceededException',
  'TooManyRequestsException',
]);

@Injectable()
export class CognitoOwnerRegistrationProvider implements OwnerRegistrationProvider {
  readonly providerName = 'cognito-internal';

  constructor(
    private readonly signInProvider: InternalCognitoAuthProvider,
    private readonly tokenVerifier: InternalCognitoTokenVerifier,
  ) {}

  private call<T>(
    target: string,
    email: string,
    body: Record<string, unknown>,
  ) {
    const { clientId, clientSecret } = registrationClient();
    return callInternalCognito<T>(target, {
      ClientId: clientId,
      SecretHash: cognitoSecretHash(email, clientId, clientSecret),
      Username: email,
      ...body,
    });
  }

  async createLogin(
    email: string,
    initialPassword: string,
  ): Promise<CreateLoginOutcome> {
    const result = await this.call<SignUpResponse>('SignUp', email, {
      Password: initialPassword,
      UserAttributes: [{ Name: 'email', Value: email }],
    });
    if (result.ok && result.body.UserSub) {
      return { outcome: 'created', subject: result.body.UserSub };
    }
    const type = !result.ok ? result.body?.__type : undefined;
    if (type === 'UsernameExistsException' || type === 'AliasExistsException') {
      return { outcome: 'exists' };
    }
    throw unexpected();
  }

  async resendSignUpCode(email: string): Promise<SendCodeOutcome> {
    const result = await this.call('ResendConfirmationCode', email, {});
    if (result.ok) return { outcome: 'sent' };
    const type = result.body?.__type;
    if (type === 'UserNotFoundException') return { outcome: 'not-found' };
    if (THROTTLED.has(type ?? '')) return { outcome: 'throttled' };
    // Cognito reports "User is already confirmed." this way.
    if (
      type === 'InvalidParameterException' &&
      /already confirmed/i.test(result.body?.message ?? '')
    ) {
      return { outcome: 'already-confirmed' };
    }
    throw unexpected();
  }

  async confirmSignUp(
    email: string,
    code: string,
  ): Promise<ConfirmCodeOutcome> {
    const result = await this.call('ConfirmSignUp', email, {
      ConfirmationCode: code,
    });
    if (result.ok) return { outcome: 'confirmed' };
    const type = result.body?.__type;
    if (type === 'CodeMismatchException') return { outcome: 'invalid-code' };
    if (type === 'ExpiredCodeException') return { outcome: 'expired-code' };
    if (type === 'UserNotFoundException') return { outcome: 'not-found' };
    // Too many wrong codes at the provider, or the email became another
    // login's alias meanwhile: no confirmation.
    if (
      type === 'TooManyFailedAttemptsException' ||
      type === 'AliasExistsException' ||
      THROTTLED.has(type ?? '')
    ) {
      return { outcome: 'invalid-code' };
    }
    // No dedicated type: "User cannot be confirmed. Current status is
    // CONFIRMED".
    if (
      type === 'NotAuthorizedException' &&
      /current status is confirmed/i.test(result.body?.message ?? '')
    ) {
      return { outcome: 'already-confirmed' };
    }
    throw unexpected();
  }

  async setPassword(
    email: string,
    initialPassword: string,
    password: string,
  ): Promise<SetPasswordOutcome> {
    const { clientId, clientSecret } = registrationClient();
    const auth = await callInternalCognito<InitiateAuthResponse>(
      'InitiateAuth',
      {
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: clientId,
        AuthParameters: {
          USERNAME: email,
          PASSWORD: initialPassword,
          SECRET_HASH: cognitoSecretHash(email, clientId, clientSecret),
        },
      },
    );
    const accessToken = auth.ok
      ? auth.body.AuthenticationResult?.AccessToken
      : undefined;
    if (!accessToken) {
      if (!auth.ok && auth.body?.__type === 'NotAuthorizedException') {
        return { outcome: 'rejected' };
      }
      throw unexpected();
    }
    const change = await callInternalCognito('ChangePassword', {
      AccessToken: accessToken,
      PreviousPassword: initialPassword,
      ProposedPassword: password,
    });
    if (change.ok) return { outcome: 'set' };
    const type = change.body?.__type;
    if (type === 'InvalidPasswordException') {
      return { outcome: 'invalid-password' };
    }
    if (type === 'NotAuthorizedException') return { outcome: 'rejected' };
    throw unexpected();
  }

  async sendPasswordSetupCode(email: string): Promise<SendCodeOutcome> {
    const result = await this.call('ForgotPassword', email, {});
    if (result.ok) return { outcome: 'sent' };
    const type = result.body?.__type;
    // No such login, or no verified email to send to.
    if (
      type === 'UserNotFoundException' ||
      type === 'InvalidParameterException' ||
      type === 'NotAuthorizedException'
    ) {
      return { outcome: 'not-found' };
    }
    if (THROTTLED.has(type ?? '')) return { outcome: 'throttled' };
    throw unexpected();
  }

  async confirmPasswordSetup(
    email: string,
    code: string,
    password: string,
  ): Promise<ConfirmPasswordSetupOutcome> {
    const result = await this.call('ConfirmForgotPassword', email, {
      ConfirmationCode: code,
      Password: password,
    });
    if (result.ok) return { outcome: 'set' };
    const type = result.body?.__type;
    if (
      type === 'CodeMismatchException' ||
      type === 'TooManyFailedAttemptsException' ||
      THROTTLED.has(type ?? '')
    ) {
      return { outcome: 'invalid-code' };
    }
    if (type === 'ExpiredCodeException') return { outcome: 'expired-code' };
    if (type === 'InvalidPasswordException') {
      return { outcome: 'invalid-password' };
    }
    if (type === 'UserNotFoundException') return { outcome: 'not-found' };
    throw unexpected();
  }

  // A real staff sign-in (the public staff client), its ID token verified
  // exactly as the staff boundary verifies it.
  async signIn(email: string, password: string): Promise<VerifiedLogin | null> {
    const outcome = await this.signInProvider.signIn({
      identifier: email,
      password,
    });
    if (outcome.outcome !== 'success') return null;
    const identity = await this.tokenVerifier.verify(outcome.idToken);
    return {
      provider: identity.provider,
      subject: identity.subject,
      email: identity.email,
      emailVerified: identity.emailVerified === true,
    };
  }

  // SC4b — Cognito answers an unconfirmed login's sign-in with
  // UserNotConfirmedException only for its correct password, and a wrong
  // password with NotAuthorizedException. Either way nothing is decided
  // from this alone: a subject is recorded only after a real sign-in
  // (loginWithInitialPassword) returns it.
  async probeInitialLogin(
    email: string,
    initialPassword: string,
  ): Promise<'ours-unconfirmed' | 'ours-confirmed' | 'not-ours'> {
    const { clientId, clientSecret } = registrationClient();
    const auth = await callInternalCognito<InitiateAuthResponse>(
      'InitiateAuth',
      {
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: clientId,
        AuthParameters: {
          USERNAME: email,
          PASSWORD: initialPassword,
          SECRET_HASH: cognitoSecretHash(email, clientId, clientSecret),
        },
      },
    );
    if (auth.ok && auth.body.AuthenticationResult?.AccessToken) {
      return 'ours-confirmed';
    }
    const type = !auth.ok ? auth.body?.__type : undefined;
    if (type === 'UserNotConfirmedException') return 'ours-unconfirmed';
    if (
      type === 'NotAuthorizedException' ||
      type === 'UserNotFoundException' ||
      type === 'PasswordResetRequiredException'
    ) {
      return 'not-ours';
    }
    throw unexpected();
  }

  loginWithInitialPassword(
    email: string,
    initialPassword: string,
  ): Promise<VerifiedLogin | null> {
    return this.signIn(email, initialPassword);
  }
}
