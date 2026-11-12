// V1 launch fix 2 — the identity-provider boundary for inviting a staff
// member to sign in. AdminInternalUsersService depends only on this
// interface; the production Cognito implementation and the local/test
// stand-in are chosen by the same switch as staff sign-in
// (isDevInternalAuthEnabled), so a dev provider can never be used where
// production staff authentication is configured.
//
// Rules every implementation keeps:
//   * never sets, generates, returns or stores a password — the provider
//     creates the login and emails its own temporary password to the
//     address, which only the person can read;
//   * never changes an EXISTING login (its password, attributes or state);
//   * never confirms an invitation it did not make or verify: an unclear
//     answer is "unavailable" (nothing is claimed as sent).

export type StaffLoginInvitationOutcome =
  // A new login was created and the provider emailed its temporary password
  // (or, for a login still waiting for its first sign-in, emailed a new one).
  | { outcome: 'invited' }
  // A login already exists for this address and has been set up: the person
  // signs in with their current password. Nothing about it was changed.
  | { outcome: 'existing-login' }
  // The provider refused the address itself (malformed for the pool).
  | { outcome: 'invalid-email' }
  // The provider could not be reached, throttled us, or answered in a way we
  // do not recognise: nothing is claimed; the invitation can be sent again.
  | { outcome: 'unavailable' };

export interface StaffLoginProvider {
  // The `externalProvider` marker the person's sign-in will present (the
  // same one staff sign-in tokens carry), stored on the staff row.
  readonly providerName: string;
  inviteLogin(input: {
    email: string;
    displayName: string;
  }): Promise<StaffLoginInvitationOutcome>;
}

export const STAFF_LOGIN_PROVIDER = Symbol('STAFF_LOGIN_PROVIDER');
