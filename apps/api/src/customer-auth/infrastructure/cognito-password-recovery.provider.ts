import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { CustomerResetPasswordRequest } from '@mocha-house/contracts';
import { requireEnv } from './require-env';
import { callCognito } from './cognito-client';
import type {
  CustomerPasswordRecoveryProvider,
  CustomerStartPasswordRecoveryOutcome,
  CustomerConfirmPasswordResetOutcome,
} from '../application/customer-password-recovery.types';

// Calls Cognito's ForgotPassword / ConfirmForgotPassword over the same
// plain unsigned JSON protocol (and the same public app client — no
// SECRET_HASH) as every other Cognito operation this boundary uses (see
// cognito-client.ts, cognito-auth.provider.ts). Cognito alone generates
// and emails the recovery code and stores the new password; nothing here
// ever sees or persists either.
//
// Account-recovery configuration this assumes on the user pool (no
// app-client change beyond the public client already required for 4A–4C):
// the pool must have a working email delivery channel (Cognito default or
// SES) and 'Email' selected as an account-recovery method. See
// apps/api/.env.example.
@Injectable()
export class CognitoPasswordRecoveryProvider implements CustomerPasswordRecoveryProvider {
  async startPasswordRecovery(
    email: string,
  ): Promise<CustomerStartPasswordRecoveryOutcome> {
    const clientId = requireEnv('COGNITO_CLIENT_ID');

    const result = await callCognito('ForgotPassword', {
      ClientId: clientId,
      Username: email,
    });

    if (result.ok) {
      return { outcome: 'initiated' };
    }

    const type = result.body?.__type;
    // Unknown user.
    if (type === 'UserNotFoundException') {
      return { outcome: 'account-not-recoverable' };
    }
    // Cognito's response for a user with no confirmed/verified email to
    // send a code to (typically an unconfirmed registration): it reports
    // InvalidParameterException with a message naming the missing verified
    // contact. Anything else with this __type falls through to the generic
    // failure rather than being misclassified as "not recoverable".
    if (
      type === 'InvalidParameterException' &&
      /verified (email|phone)/i.test(result.body?.message ?? '')
    ) {
      return { outcome: 'account-not-recoverable' };
    }

    // LimitExceededException / TooManyRequestsException / CodeDeliveryFailureException
    // / anything unrecognized: a real, transient system condition. Surface
    // it as a failure — never as a fake "code sent" — so the caller can
    // return a temporary-service error and monitoring still sees it.
    throw new ServiceUnavailableException(
      'The authentication service is temporarily unavailable. Please try again shortly.',
    );
  }

  async confirmPasswordReset(
    request: CustomerResetPasswordRequest,
  ): Promise<CustomerConfirmPasswordResetOutcome> {
    const clientId = requireEnv('COGNITO_CLIENT_ID');

    const result = await callCognito('ConfirmForgotPassword', {
      ClientId: clientId,
      Username: request.email,
      ConfirmationCode: request.code,
      Password: request.newPassword,
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
    // The only caller-supplied free-form value on this call is the new
    // password, so both of Cognito's password-shape rejections map here.
    if (
      type === 'InvalidPasswordException' ||
      type === 'InvalidParameterException'
    ) {
      return { outcome: 'invalid-password' };
    }
    // Unknown user, or a code/recovery state Cognito will no longer honour
    // (e.g. NotAuthorizedException "... cannot be reset in the current
    // state"). Collapsed into one neutral value — the customer is told to
    // start over, never whether the account exists.
    if (type === 'UserNotFoundException' || type === 'NotAuthorizedException') {
      return { outcome: 'invalid-recovery-state' };
    }

    throw new ServiceUnavailableException(
      'The authentication service is temporarily unavailable. Please try again shortly.',
    );
  }
}
