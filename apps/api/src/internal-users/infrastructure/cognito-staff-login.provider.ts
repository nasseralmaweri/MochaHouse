import { Injectable, Logger } from '@nestjs/common';
import {
  AdminCreateUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { requireInternalEnv } from '../../internal-auth/infrastructure/require-internal-env';
import type {
  StaffLoginInvitationOutcome,
  StaffLoginProvider,
} from './staff-login-provider';

// V1 launch fix 2 — inviting a staff member to the INTERNAL (staff) Cognito
// pool with AdminCreateUser: Cognito creates the login and EMAILS a temporary
// password to the address. CENTERIVO never sees, generates, stores or shows
// a password; the person must choose their own at first sign-in (the
// NEW_PASSWORD_REQUIRED challenge, answered through the sign-in page).
//
// Why email_verified=true is set on the NEW login: the temporary password is
// delivered only to that mailbox, so a first sign-in with it proves control
// of the address — the provider's own invitation model. It is set only on a
// login this call creates; an existing login's attributes are never touched.
//
// Existing logins are never changed:
//   * a login that already exists answers UsernameExistsException;
//   * we then ask Cognito to RESEND the invitation, which Cognito performs
//     ONLY for a login still waiting for its first sign-in
//     (FORCE_CHANGE_PASSWORD) — a login that has been set up is refused with
//     UnsupportedUserStateException and stays exactly as it is: the person
//     signs in with their current password ("existing-login").
//
// AWS prerequisites (an infrastructure change needing separate approval;
// nothing here changes AWS): the API's runtime role needs
// cognito-idp:AdminCreateUser on the staff pool only, from the standard AWS
// credential chain — never a key in the browser or in this repository. The
// pool's invitation message should be worded for staff, and its temporary
// password validity (default 7 days) decides how long an invitation lasts.
// Public self sign-up stays disabled; this path needs no app client.

const TIMEOUT_MS = 10_000;

const RESENDABLE = 'UsernameExistsException';
const ALREADY_SET_UP = 'UnsupportedUserStateException';

@Injectable()
export class CognitoStaffLoginProvider implements StaffLoginProvider {
  readonly providerName = 'cognito-internal';
  private readonly logger = new Logger(CognitoStaffLoginProvider.name);
  private client: CognitoIdentityProviderClient | null = null;

  private clientFor(userPoolId: string): CognitoIdentityProviderClient {
    if (!this.client) {
      this.client = new CognitoIdentityProviderClient({
        region: userPoolId.split('_')[0],
        maxAttempts: 2,
      });
    }
    return this.client;
  }

  async inviteLogin(input: {
    email: string;
    displayName: string;
  }): Promise<StaffLoginInvitationOutcome> {
    let userPoolId: string;
    try {
      userPoolId = requireInternalEnv('INTERNAL_COGNITO_USER_POOL_ID');
    } catch {
      this.logger.error(
        'Staff invitations: the staff user pool is not configured.',
      );
      return { outcome: 'unavailable' };
    }
    const client = this.clientFor(userPoolId);

    const created = await this.send(client, {
      UserPoolId: userPoolId,
      Username: input.email,
      UserAttributes: [
        { Name: 'email', Value: input.email },
        { Name: 'email_verified', Value: 'true' },
      ],
      DesiredDeliveryMediums: ['EMAIL'],
    });
    if (created === 'ok') return { outcome: 'invited' };
    if (created === RESENDABLE) {
      // Exists: a new temporary password ONLY while its first sign-in is
      // still pending; a set-up login is refused and left untouched.
      const resent = await this.send(client, {
        UserPoolId: userPoolId,
        Username: input.email,
        MessageAction: 'RESEND',
        DesiredDeliveryMediums: ['EMAIL'],
      });
      if (resent === 'ok') return { outcome: 'invited' };
      if (resent === ALREADY_SET_UP) return { outcome: 'existing-login' };
      return { outcome: 'unavailable' };
    }
    if (created === 'invalid-email') return { outcome: 'invalid-email' };
    return { outcome: 'unavailable' };
  }

  // 'ok', the provider's error name, 'invalid-email', or 'failed'. Never
  // throws; never logs the address or any credential.
  private async send(
    client: CognitoIdentityProviderClient,
    input: ConstructorParameters<typeof AdminCreateUserCommand>[0],
  ): Promise<string> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
    timer.unref();
    try {
      await client.send(new AdminCreateUserCommand(input), {
        abortSignal: abort.signal,
      });
      return 'ok';
    } catch (error) {
      const name =
        typeof error === 'object' && error !== null && 'name' in error
          ? String((error as { name: unknown }).name)
          : 'UnknownError';
      if (name === RESENDABLE || name === ALREADY_SET_UP) return name;
      const message =
        typeof error === 'object' && error !== null && 'message' in error
          ? String((error as { message: unknown }).message)
          : '';
      if (name === 'InvalidParameterException' && /email/i.test(message)) {
        return 'invalid-email';
      }
      this.logger.warn(
        `Staff invitation not confirmed by the provider (${name}).`,
      );
      return 'failed';
    } finally {
      clearTimeout(timer);
    }
  }
}
