# Staff invitations and first sign-in (V1 launch fix 2)

An authorized administrator adds an employee in **Administration → Users →
Add employee**. The employee receives a sign-in invitation from the identity
provider, chooses their own password at their first sign-in, and only then
gains the access the administrator granted.

## Adding an employee

`POST /api/v1/admin/internal-users`

The request carries the employee's name, email, one of the business's existing
access levels and, for a location-level access, the locations it covers.

- **Optional details.** Phone (digits, spaces and `+ ( ) - .`, 7–15 digits) and
  job title (plain text, at most 80 characters) are optional, validated by the
  API and bounded by database CHECKs (migration
  `20261201100000_staff_profile_fields`). A job title is a label only and never
  grants anything; access comes only from the assigned access level.
- **Locations.** For an access level that applies to specific locations:
  - one active location is assigned automatically;
  - several active locations let the administrator choose one or more;
  - no active location means the page explains that a location must be set up
    first.

  Business-wide access levels show no selector. The API validates every
  assignment. A location added later is never granted automatically.
- **Permissions.** The administrator needs **both** `users.manage_roles` and
  `users.manage_status`, both held at CORPORATE scope, plus the existing
  **privilege ceiling**: an access level can be granted only where the
  administrator holds everything it includes.
- **Same checks as granting access.** Access level, shape and locations go
  through the checks used for granting access (`validateGrant`). The level must
  be this business's own and fully recognised; each location must be this
  business's and active.
- **What the server decides.** The business is always the administrator's own
  sign-in. No business id, identity subject or permission is accepted from the
  browser.
- **One person per address.** Email is stored lower-case. There is one person
  per address in a business, compared case-insensitively. The same human may
  belong to other businesses.
- **Atomic and safe to repeat.** The person (status **INVITED**, no login
  bound), their access and the audit events (`user.created`,
  `user.role_assigned`) are written in one Serializable transaction.
  Concurrent attempts create exactly one person; the others get 409.
- **Invitation outside the transaction.** The identity provider is then asked
  to invite the login. Only a confirmed invitation is recorded:
  `InternalUser.loginInvitedAt` and `user.login_invited`. When the provider is
  unavailable, the person stays **setup pending** and nothing is claimed as
  sent. `POST …/:internalUserId/login-invitation` sends it again.
- **Refused addresses.** If the provider refuses the address itself while an
  employee is being **added**, the just-added person and their access are
  removed again in one guarded transaction. The guard requires them to be
  still INVITED, unbound and with no confirmed invitation. The history is kept,
  with `user.creation_reverted` added, and the administrator is told "Nothing
  was added", so they can retry with the same or a corrected address. On
  **Send invitation again**, an existing person is never removed; the
  administrator is told to cancel the invitation and add them again.
- **Rate limits.** Both routes are limited (`staff-invitations`: 10 per 5
  minutes per IP, 40 per hour per business).
- **Withdrawing an invitation.** An administrator can move INVITED → DISABLED,
  for example after a mistyped address. INVITED is never moved to ACTIVE by an
  administrator.

## Identity provider (Cognito staff pool)

`CognitoStaffLoginProvider` uses **AdminCreateUser**. Cognito creates the login
and emails its own temporary password. CENTERIVO never generates, sees, stores
or shows a password.

- **New login.** It is created with `email_verified=true`. The temporary
  password reaches only that mailbox, so a first sign-in with it proves the
  person controls the address.
- **Existing login.** CENTERIVO asks Cognito to RESEND. Cognito does that only
  for a login still waiting for its first sign-in. A login that has been set up
  is refused (`UnsupportedUserStateException`) and is **never changed**. The
  person signs in with their current password ("existing login").
- **Unclear answers.** Throttling, permissions, timeouts and unknown errors are
  "unavailable": nothing is claimed as sent.

**AWS prerequisites.** These are an infrastructure change needing separate
approval; this code changes nothing in AWS.

1. The API's runtime role needs `cognito-idp:AdminCreateUser` on the **staff**
   pool only, from the standard AWS credential chain. Credentials are never
   placed in the repository or sent to a browser.
2. The pool's invitation message should be worded for staff. Its temporary
   password validity (7 days by default) is how long an invitation lasts.
   After that, use "Send invitation again".
3. Public self sign-up stays **disabled** for staff. This path needs no app
   client and does not use owner self-registration.

Locally and in tests, a stand-in provider is used (the same fail-closed switch
as staff sign-in). It sends nothing.

## First sign-in

1. The employee signs in with their email and the temporary password. Cognito
   answers `NEW_PASSWORD_REQUIRED`. The web app keeps the challenge handle in
   an HttpOnly cookie for 5 minutes and asks the employee to choose a password.
2. `POST /api/v1/internal/auth/new-password` sends the new password straight to
   Cognito (`RespondToAuthChallenge`). It is never stored or logged, and is
   rate limited like sign-in.
3. With the resulting token, the business lookup activates the invitation
   (`InternalTenantMembershipService.activateInvitedMemberships`). The row
   becomes **ACTIVE** and is bound to this login only when **all** of these
   hold, re-checked in one conditional write:
   - the email is provider-verified;
   - the row is the business's single unbound row for that address;
   - the login is not a public owner self-registration;
   - the row is still INVITED;
   - the provider confirmed its invitation.

   The employee is the actor of the audit event `user.activated`.

Knowing an address is never enough. SUSPENDED and DISABLED rows are never
touched. Two logins racing for one invitation: exactly one binds. An existing
verified login joins another business without a new identity, and its other
memberships are unchanged.

## Known limitations

- **No acceptance step.** An invited person who already has a sign-in joins the
  inviting business at their next sign-in. They then choose between businesses.
- **RESEND to a pending login.** A RESEND to a login still waiting for its first
  sign-in replaces that login's unused temporary password. The new one goes to
  the same mailbox.
- **Self-registered owners.** Logins created by owner self-registration are
  never bound by email (SC4a). Such an owner cannot be invited as staff of
  another business by email.
- **MFA.** If MFA is ever enabled on the staff pool, its challenges are not yet
  supported. Sign-in would answer 503 rather than proceed.
