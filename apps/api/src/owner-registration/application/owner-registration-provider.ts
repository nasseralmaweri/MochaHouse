// SC4a — the identity-provider side of owner registration: a login in the
// STAFF identity pool, created and verified only through this API (owner
// decision D9). The provider generates and emails every code itself;
// nothing here sees, stores or logs a code.
//
// Two implementations, chosen per request exactly like staff sign-in
// (isDevInternalAuthEnabled): the internal Cognito pool through a dedicated
// confidential registration app client (production), and an in-memory
// stand-in for local development and tests.
//
// A login is created with a server-only INITIAL password (see
// OwnerRegistrationService) and the owner chooses their own password only
// after proving the mailbox — so whoever started a registration for an
// address they do not control never knows the password the account ends
// up with (no account pre-hijacking).

export type CreateLoginOutcome =
  | { outcome: 'created'; subject: string }
  // A login with this email already exists (ours or anyone else's): never
  // touched, never revealed.
  | { outcome: 'exists' };

export type SendCodeOutcome =
  | { outcome: 'sent' }
  | { outcome: 'not-found' }
  // Resending a sign-up code to a login already confirmed.
  | { outcome: 'already-confirmed' }
  // The provider's own sending limit.
  | { outcome: 'throttled' };

export type ConfirmCodeOutcome =
  | { outcome: 'confirmed' }
  | { outcome: 'invalid-code' }
  | { outcome: 'expired-code' }
  | { outcome: 'not-found' }
  // ConfirmSignUp on a login confirmed earlier. NEVER proof of the mailbox
  // for this request.
  | { outcome: 'already-confirmed' };

export type SetPasswordOutcome =
  | { outcome: 'set' }
  | { outcome: 'invalid-password' }
  // The initial password was not accepted (the login's password changed).
  | { outcome: 'rejected' };

export type ConfirmPasswordSetupOutcome =
  | { outcome: 'set' }
  | { outcome: 'invalid-code' }
  | { outcome: 'expired-code' }
  | { outcome: 'invalid-password' }
  | { outcome: 'not-found' };

// What the provider itself asserts after a real sign-in with the new
// password — the same facts the staff boundary will see.
export interface VerifiedLogin {
  provider: string;
  subject: string;
  email: string | null;
  emailVerified: boolean;
}

export interface OwnerRegistrationProvider {
  // The identity provider marker logins from this provider carry
  // ('cognito-internal' / 'internal-dev').
  readonly providerName: string;
  // Creates an UNCONFIRMED login and emails its sign-up code.
  createLogin(
    email: string,
    initialPassword: string,
  ): Promise<CreateLoginOutcome>;
  resendSignUpCode(email: string): Promise<SendCodeOutcome>;
  confirmSignUp(email: string, code: string): Promise<ConfirmCodeOutcome>;
  // Replaces the initial password (right after confirmSignUp succeeded).
  setPassword(
    email: string,
    initialPassword: string,
    password: string,
  ): Promise<SetPasswordOutcome>;
  // For a confirmed login whose password was never set (an interrupted
  // completion): a password-setup code to the verified email, and setting
  // the password with it.
  sendPasswordSetupCode(email: string): Promise<SendCodeOutcome>;
  confirmPasswordSetup(
    email: string,
    code: string,
    password: string,
  ): Promise<ConfirmPasswordSetupOutcome>;
  // Signs in with the chosen password; null when refused.
  signIn(email: string, password: string): Promise<VerifiedLogin | null>;
  // SC4b — recovery when a login was created but its subject never got
  // recorded (an interruption between the two). Only this API knows the
  // initial password, so a login it can open with it is ours:
  //   whether the login with this email still has our initial password,
  //   confirmed or not ('not-ours' for anything else) — a hint only;
  probeInitialLogin(
    email: string,
    initialPassword: string,
  ): Promise<'ours-unconfirmed' | 'ours-confirmed' | 'not-ours'>;
  //   the login's own subject, from a real sign-in with the initial password
  //   (possible once it is confirmed); null when refused.
  loginWithInitialPassword(
    email: string,
    initialPassword: string,
  ): Promise<VerifiedLogin | null>;
}
