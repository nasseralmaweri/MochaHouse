import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type {
  CustomerRegisterRequest,
  CustomerVerifyRequest,
} from '@mocha-house/contracts';
import { requireEnv } from './require-env';
import { callCognito } from './cognito-client';
import type {
  CustomerRegistrationProvider,
  CustomerRegistrationOutcome,
  CustomerVerificationOutcome,
  CustomerResendOutcome,
} from '../application/customer-registration.types';

interface CognitoSignUpResponse {
  UserSub?: string;
}

// Calls Cognito's SignUp / ConfirmSignUp / ResendConfirmationCode — the
// same plain, unsigned JSON protocol InitiateAuth uses (see
// cognito-auth.provider.ts), against the same public app client (no
// SECRET_HASH, see that file's comment for the failure mode if the app
// client has a secret instead). Cognito is solely responsible for storing
// the password and generating/sending the verification code; nothing here
// ever sees or stores either.
@Injectable()
export class CognitoRegistrationProvider implements CustomerRegistrationProvider {
  async register(
    request: CustomerRegisterRequest,
  ): Promise<CustomerRegistrationOutcome> {
    const clientId = requireEnv('COGNITO_CLIENT_ID');

    const result = await callCognito<CognitoSignUpResponse>('SignUp', {
      ClientId: clientId,
      Username: request.email,
      Password: request.password,
      UserAttributes: [
        { Name: 'email', Value: request.email },
        { Name: 'name', Value: request.displayName },
      ],
    });

    if (result.ok && result.body.UserSub) {
      return {
        outcome: 'success',
        provider: 'cognito',
        subject: result.body.UserSub,
      };
    }

    const type = !result.ok ? result.body?.__type : undefined;
    if (type === 'UsernameExistsException') {
      return { outcome: 'already-exists' };
    }
    if (type === 'InvalidPasswordException') {
      return { outcome: 'invalid-password' };
    }
    if (type === 'InvalidParameterException') {
      return { outcome: 'invalid-input' };
    }

    throw new ServiceUnavailableException(
      'The authentication service returned an unexpected response.',
    );
  }

  async verify(
    request: CustomerVerifyRequest,
  ): Promise<CustomerVerificationOutcome> {
    const clientId = requireEnv('COGNITO_CLIENT_ID');

    const result = await callCognito('ConfirmSignUp', {
      ClientId: clientId,
      Username: request.email,
      ConfirmationCode: request.code,
    });

    if (result.ok) {
      return { outcome: 'success' };
    }

    const type = result.body?.__type;
    if (type === 'CodeMismatchException') {
      return { outcome: 'invalid-code' };
    }
    if (type === 'ExpiredCodeException') {
      return { outcome: 'expired-code' };
    }
    if (type === 'UserNotFoundException') {
      return { outcome: 'not-found' };
    }
    // Cognito has no dedicated "already confirmed" error type for
    // ConfirmSignUp — it reports NotAuthorizedException with a message
    // like "User cannot be confirmed. Current status is CONFIRMED". This
    // message-text match is a known heuristic, not a stable API contract,
    // but it's the only signal Cognito gives; anything else with this
    // __type still falls through to the generic failure below rather than
    // being misclassified.
    if (
      type === 'NotAuthorizedException' &&
      /current status is confirmed/i.test(result.body?.message ?? '')
    ) {
      return { outcome: 'already-verified' };
    }

    throw new ServiceUnavailableException(
      'The authentication service returned an unexpected response.',
    );
  }

  async resendVerification(email: string): Promise<CustomerResendOutcome> {
    const clientId = requireEnv('COGNITO_CLIENT_ID');

    const result = await callCognito('ResendConfirmationCode', {
      ClientId: clientId,
      Username: email,
    });

    if (result.ok) {
      return { outcome: 'sent' };
    }

    const type = result.body?.__type;
    if (type === 'UserNotFoundException') {
      return { outcome: 'not-found' };
    }
    // Same message-text heuristic as verify() above — Cognito reports
    // InvalidParameterException with "User is already confirmed." here.
    if (
      type === 'InvalidParameterException' &&
      /already confirmed/i.test(result.body?.message ?? '')
    ) {
      return { outcome: 'already-verified' };
    }

    throw new ServiceUnavailableException(
      'The authentication service returned an unexpected response.',
    );
  }
}
