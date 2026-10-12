# Security 4A — staff identity, platform data and business branding

Status: proposed. Follows the tenant-isolation certification audit (findings
H2, M1 and M2). No schema change and no migration.

## 1. Staff identity: verified email only

**Before.** An `InternalUser` row with no `externalSubject` (unbound) was
matched, and then bound to the signing-in login, by the token's `email`
claim alone. The internal Cognito verifier never read `email_verified`, so a
login that merely *claimed* an address could enter (and permanently bind)
a staff record in a business it was never invited to — provided such an
unbound ACTIVE row existed and the identity pool allowed an unverified or
changeable email.

**Now (enforced in code).**

- `InternalIdentity.emailVerified` — set from Cognito's `email_verified`
  (`true` or `"true"`); the dev token carries an optional `email_verified`
  claim. Absent means unverified (fails closed).
- `InternalTenantMembershipService.findMemberships` matches unbound rows by
  email only when `emailVerified === true`, so an unverified login neither
  sees nor can select such a business.
- `InternalUsersService.findUnboundByEmail` returns nothing unless the email
  is verified; the guard then answers the generic 403.
- Binding is compare-and-set (`updateMany where externalSubject IS NULL`):
  two logins racing for one unbound row can never overwrite each other; the
  loser is "not-found". An already-bound row is never re-bound — a second
  login with the same email but a different subject is refused.

**Still required outside the code.** The internal Cognito pool must not
allow self-sign-up, and must require verification before an email change
takes effect (Cognito "keep original attribute value active when an update
is pending"). These are pool settings, not code.

## 2. Proposed design: single-use staff invitation tokens (not built)

Email matching should eventually be replaced, not just gated.

1. **Create.** An admin with `users.manage_roles` invites `{ email, roleIds,
   scope }` in the active business. The server creates an `InternalUser`
   (INVITED, unbound) and an `InternalInvitation` row: `tenantId`,
   `internalUserId`, `tokenHash` (SHA-256 of a 256-bit random token),
   `expiresAt` (e.g. 72 h), `consumedAt`, `createdByInternalUserId`.
   The raw token is only ever in the emailed link, never stored or logged.
2. **Accept.** The invitee signs in (any verified identity), then submits the
   token. In one transaction: look up by `tokenHash`, require same tenant,
   not expired, not consumed, row still INVITED and unbound; set
   `externalSubject` (compare-and-set as above), `status = ACTIVE`,
   `consumedAt = now()`. Any failure is one generic error.
3. **Rules.** Single use; revocable (delete/expire); re-issuing invalidates
   earlier tokens for the same user; rate-limited; audited (issued, accepted,
   revoked) without the token. Email becomes contact information only — it
   never decides identity. Optionally require the verified email to match
   the invited one as a second factor.
4. **Then remove** email-based binding from `resolveForAuthentication` and
   `findMemberships` entirely.

This needs a new table (schema change), so it is out of scope for 4A.

## 3. Platform status

`GET /api/v1/admin/platform/status` now counts only the active business's
locations (`AdminPlatformStatusService.getStatus`). The remaining fields
(environment, auth and payment modes) describe the deployment's
configuration and contain no business's data. No platform-operator role was
introduced.

## 4. Business branding

Every tenant-facing string that named Mocha House now uses the business's
own `Tenant.name` (`tenancy/business-name.ts`; the worker reads it from the
outbox event's tenant). Mocha House's `Tenant.name` is "Mocha House", so its
wording is unchanged.

| Where | Change |
|---|---|
| Order emails (`apps/worker/.../templates.ts`) | Subject and body use the ordering business's name |
| Email sender | Display name `"Business Name" <configured address>` per business; address unchanged |
| Franchise consent error (`franchise-inquiries-public.service.ts`) | Names the business receiving the inquiry |
| CMS default content (`cms-page-registry.ts`) | `{{businessName}}` token filled per business; an untouched default can no longer publish another business's name |
| Report definitions (operations checklists, customer growth) | Name the report's own business |

### Requires approval (not changed in meaning, but flagged)

- **Franchise consent wording.** The sentence is unchanged; only the named
  party becomes the business receiving the inquiry. Legal should confirm
  that this wording is acceptable for each business before that business
  accepts inquiries.
- **Web storefront consent label** (`apps/web/src/app/franchising/inquiry/InquiryForm.tsx`)
  still says "Mocha House". The web app is one deployment per business and
  is Mocha House–branded throughout; per-deployment storefront branding is
  a separate piece of work and the label needs the same legal review.
- **Default franchising copy** makes business claims ("we're exploring
  franchising", "our brand, recipes, and operating know-how"). It is a
  draft default, but each business should review it before publishing.
- **Sender address.** Every business still sends from the deployment's
  configured address; only the display name differs. Per-business sending
  domains need SES identity setup per business.
