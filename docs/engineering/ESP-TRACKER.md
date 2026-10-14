# Engineering Stabilization Program (ESP) — Tracker

Last verified: 2026-10-14 against `main` = `fba6fd0ecb6145cadd2317e463549a7ce46eb960`.

This file records **verified evidence only**: merged PRs, merge commits and CI
runs. It carries no percentages. Update it in the same PR that closes a
deliverable, and re-verify the "Last verified" line when you do.

## How to read this

- **Status** is one of `DONE` (merged, post-merge CI green), `IN PROGRESS`,
  `PLANNED`, `NOT DEFINED`.
- **Evidence** names the PR, the merge commit on `main`, and the CI run.
- Items marked **(inferred)** or **(proposed)** are not recorded anywhere else in
  the repository or in the PR history. They are the tracker author's grouping,
  must be confirmed by the program owner, and are not commitments.

## Summary

| ESP | Scope | Status | Evidence |
|---|---|---|---|
| ESP-01 (inferred) | Development seed fails closed and is create-once | DONE | PR #25, `769f83d` |
| ESP-02 | Dev auth, dev secrets and fake payments fail closed outside safe contexts | DONE | PR #26, `b282259` |
| ESP-03 | Payment recovery and safe retries | IN PROGRESS (2 of 8 deliverables merged) | PR #27 `6f1bfb1`, PR #28 `fba6fd0` |
| ESP-04 (proposed) | Production defaults for media, email and web cookies | PLANNED | none yet |
| ESP-05 (proposed) | API startup assertion follow-ups; remove seeded `internal-dev` rows | PLANNED | none yet |
| ESP-06 (proposed) | Workspace hygiene: stale local worktrees and branches | PLANNED | none yet |
| ESP-07 | not defined | NOT DEFINED | no scope recorded |
| ESP-08 | not defined | NOT DEFINED | no scope recorded |

> **Open question for the program owner:** ESP-01 and ESP-04 to ESP-08 have no
> written definition in the repository. ESP-01 is inferred from the seed-safety
> PR that preceded ESP-02. ESP-04 to ESP-06 are drawn from audit items that were
> explicitly deferred. ESP-07 and ESP-08 are left undefined rather than guessed.

---

## ESP-01 (inferred) — Seed safety

- **Scope:** the development seed must refuse to run against anything that is not
  provably disposable or local, and must not overwrite existing data.
- **Defects:** DB2-1, DB2-2 (confirmed by dynamic verification against a
  disposable database).
- **PR / merge:** PR #25 `fix/seed-safety`, merged 2026-10-12 as
  `769f83da48f9b9b62b2384591c604e8f0677aa7d`. No migration.
- **Acceptance criteria met:** seed fails closed outside a disposable/local
  database; re-running does not reset existing rows.
- **Deferred:** removal of seeded `internal-dev` rows from non-development
  databases (see ESP-05).
- **Next action:** none.

## ESP-02 — Development auth startup safety

- **Scope:** the passwordless dev auth providers, the shared dev secret and the
  fake payment provider must not be reachable in production-like environments.
- **Mechanism:** `assertAuthConfigSafe` at startup; `ALLOW_DEV_AUTH=1` is an
  explicit opt-in on top of `NODE_ENV=development` and a loopback database; a
  declared isolated test run is the only other allowed context. Documented in
  `docs/security/ci-and-required-checks.md`.
- **PR / merge:** PR #26 `fix/esp-02-auth-startup-safety`, merged 2026-10-13 as
  `b28225907fd7c6b9f9c544f49b7076f1112672aa`. No migration.
- **Acceptance criteria met:** API refuses to start with dev auth or fake
  payments in a production-like environment; request-time gates stay off outside
  a verified safe context; isolated-test secret gap closed in review.
- **Deferred:** API startup assertion follow-ups (ESP-05).
- **Next action:** none.

---

## ESP-03 — Payment recovery and safe retries

**Problem.** A provider call that throws or times out left a payment `PENDING`
forever with its charge claim never released; a pending provider result was
recorded as `FAILED`; a payment that succeeded but could not be fulfilled had no
durable recovery path.

**Defects (from dynamic verification on a disposable database):**

| ID | Defect | Status |
|---|---|---|
| PAY-1 | Gift-card purchase: provider throw leaves a permanent charge claim | FIXED, PR #28 |
| PAY-2 | Checkout: provider throw leaves attempt `PENDING` forever | FIXED, PR #28 |
| PAY-7 | Provider "pending" recorded as `FAILED` | FIXED, PR #28 |
| PAY-3 | Success then order/card failure, and the flag write also failing, leaves an unflagged orphan payment; fulfilment is not resumable | OPEN |
| PAY-4 | `reconciliationRequired` is a dead end; a customer retry with a new key charges again | OPEN |
| PAY-5 | Fulfilment re-prices from live data, so a price change during the charge fails an already-paid order | OPEN |

### Deliverables

| # | Deliverable | Migration | Status | Evidence |
|---|---|---|---|---|
| 1 | 03A design (read-only, four specialist agents) | none | DONE | design review 2026-10-13; no repository artefact |
| 2 | PR 1: database foundation — `PaymentAttempt.paymentState` / `fulfilmentStatus`, `PaymentReconciliationCase` / `Event` (append-only), backfill, rollback script | yes (additive, 2 migrations) | DONE | PR #27, `6f1bfb1`, CI run 38585283311 |
| 3 | PR 2: provider states and safe retries (PAY-1, PAY-2, PAY-7) | none | DONE | PR #28, `fba6fd0`, CI run 38591976541 (all five jobs green) |
| 4 | PR 3: payment hardening (see plan below) | none | PLANNED, plan awaiting approval | — |
| 5 | PR 4: resumable fulfilment (PAY-3) | to be decided | PLANNED | — |
| 6 | PR 5: reconciliation resolver, admin surface and new-key duplicate guard (PAY-4) | none expected | PLANNED | — |
| 7 | PR 6: request fingerprint and server-generated provider key | yes (one nullable column) | PLANNED | — |
| 8 | PR 7: tenant-scoped idempotency uniqueness; snapshot-based fulfilment (PAY-5) | yes | PLANNED | — |

Deliverable 8 is two migration-bearing changes that may be split when planned.
Also open under ESP-03 and not yet placed in a PR: gift-card tender reservation.

### What PR #28 guarantees today (verified)

- `NOT_SENT -> CHARGING` is committed with a conditional `updateMany` before the
  provider is called; the provider always receives the attempt's persisted
  `idempotencyKey`.
- A provider throw, timeout (30 s default) or unrecognised result is `UNKNOWN`,
  never `FAILED`. `pending` is `AWAITING_CONFIRMATION`. Held states are never
  claimed again and replay as a 409 "do not pay again".
- Legacy attempts (`paymentState` NULL) keep their status-driven behaviour and are
  never guessed. A never-claimed legacy gift-card intent can be charged once.
- A key is bound to the original request's Location (checkout) or amount,
  purchaser email and name (gift card).
- Evidence: 29 new integration tests on a disposable database; a mutation check
  (writing `UNKNOWN` as `FAILED`) makes 5 of them fail; two independent read-only
  specialist reviews found no duplicate-charge path.

### Known open risks after PR #28

| ID | Risk | Severity | Fix lands in |
|---|---|---|---|
| R1 | Gift-card `createIntent` can attach to a same-tenant non-gift-card attempt that has the same key (`gift-card-purchase.service.ts`, existing-attempt branch and unique-key race branch). Pre-existing, not introduced by PR #28. Worst case: an orphan purchase, or a stuck checkout attempt charged at the gift-card amount. Still a single charge. | low-medium | PR 3 |
| R2 | A success whose result cannot be written (late success after the timeout, or a database error while settling) leaves the attempt held with no `providerReference` and no reconciliation flag. No double charge, but no trail. (`payment-charge.ts`, `settle`) | medium (operational) | PR 3 |
| R3 | `GiftCardPurchaseService.purchase()` evaluates payment-state branches (declined, reconciliation, held) before enforcing authorisation, so a same-tenant caller who knows the key learns the state. Pre-existing for decline and reconciliation. | low | PR 3 |
| R4 | Nothing resolves a held state. If a reconciler marks an attempt `SUCCEEDED`, neither checkout nor the gift-card purchase would create the order or issue the card. | high (blocks any real provider) | PR 4, PR 5 |
| R5 | A crash between attempt creation and the claim leaves a permanent `NOT_SENT`, or between the claim and the outcome a permanent `CHARGING`. Safe, but stuck. | medium | PR 5 |
| R6 | The idempotency key is client-supplied (checkout: any 8-200 characters; gift card: a UUID), globally unique, and used verbatim as the provider key. Unsafe for an external processor. | high before a real provider | PR 6 |
| R7 | A checkout key reused with a different cart, reward, gift card or buyer replays the original outcome. No duplicate charge or order, but the response does not match the request. | medium | PR 6 |
| R8 | Raw provider reason text is persisted for held outcomes and returned in 402 bodies for declines. Harmless with the fake provider. | medium before a real provider | before real-provider integration |
| R9 | Idempotency keys are unique across tenants, so one tenant can occupy a key another would choose. | low (single-tenant deployment today) | PR 7 |

### Out of scope for ESP-03

A real payment provider integration, refunds, voids and webhooks. R6 and R8 must
be closed before any real provider is connected.

### Acceptance criteria for ESP-03 as a whole

1. No path can call a payment provider twice for one attempt or under a second key.
2. A payment whose outcome is uncertain is held and visible; no customer-visible
   failure is claimed for it.
3. A payment that succeeded is always either fulfilled or visible to an operator
   as needing review, including when the flag write itself fails.
4. A held payment can be resolved by an operator with an audit trail, and
   resolution to `SUCCEEDED` completes fulfilment exactly once.
5. A key cannot be reused for a different request or by a different tenant.
6. All of the above is covered by tests run against a disposable database, and
   the five required CI jobs are green on `main`.

**Status against these criteria:** 1 is met for checkout and gift-card purchase
(PR #28). 2 is partly met (held and replay-safe; not yet operator-visible, R2).
3 to 5 are not met.

### Next action

Approve or amend the PR 3 plan below. No payment implementation starts before then.

---

## Proposed next PR — ESP-03 PR 3: payment hardening

**Why this one.** It is the smallest change that closes the three risks found in
the PR #28 reviews (R1, R2, R3) without a migration, and it makes held payments
visible — which PR 4 and PR 5 both depend on. It touches only code PR #28 already
changed, so it can be reviewed in a single sitting.

**Scope**

1. **Cross-flow attachment guard (R1).** In gift-card `createIntent`, for the
   existing-attempt path and the unique-key race path, accept a key only when the
   attempt has no Location, its amount equals the requested amount, and its state
   is `NOT_SENT` or legacy NULL. Otherwise return the existing generic 409.
2. **Authorisation before payment state (R3).** In gift-card `purchase()`, enforce
   the caller's authorisation before any branch that reveals state (declined,
   failed, reconciliation, held), while keeping the "no purchase for this key"
   response identical for unauthorised and unknown keys.
3. **Make held payments visible and keep the trail (R2).**
   - When `chargeAttempt` settles to `UNKNOWN` or `AWAITING_CONFIRMATION`, open a
     `PaymentReconciliationCase` (reason code from the outcome) with a SYSTEM
     `OPENED` event, in the same conditional write path, idempotent on
     `(tenantId, paymentAttemptId)`.
   - Persist `providerReference` whenever the provider returned one, including on
     a pending result.
   - If the settle write loses its compare-and-set or throws after the provider
     returned `succeeded`, record the provider reference and open a case rather
     than discarding it.
4. **Customer-safe reasons.** Return a fixed message set instead of raw provider
   `reason` text in 402 bodies; keep the raw text only in internal fields. (This
   brings forward the safe half of R8 because it touches the same lines.)

**Not in scope:** a resolver or admin screen (PR 5), resumable fulfilment (PR 4),
fingerprinting and a separate provider key (PR 6), any schema change, any real
provider.

**Migration needs:** none. The reconciliation tables and `paymentState` already
exist from PR #27.

**Dependencies:** PR #27 and PR #28 only (both merged).

**Acceptance criteria**

- A gift-card intent with a key that belongs to a checkout attempt, an attempt
  with a different amount, or an attempt not in `NOT_SENT` / NULL is refused with
  the generic 409, and nothing is created or changed. Covered for both the direct
  and the race path.
- `purchase()` returns the same response for an unauthorised caller whether the
  attempt is pending, declined, held or reconciled.
- Each of: provider throw, timeout, pending result, and a lost settle write leaves
  exactly one open case with one `OPENED` event, and replaying the request never
  creates a second case.
- `providerReference` is stored for a pending result and for a lost settle write.
- A 402 body never contains provider-supplied text; a fake provider whose reason
  contains an identifiable marker proves it.
- All existing payment, checkout and gift-card specs still pass; the five required
  CI jobs are green; the lint-changed gate shows no new findings.
- No migration, no change outside the payment and gift-card paths.

**Risks to watch:** case creation must not make the charge path slower or able to
fail the request after money may have moved — a failure to open a case is logged
and the attempt stays held; the sweeper that would find such rows is PR 5.

**Sequence after PR 3:** PR 4 (resumable fulfilment, PAY-3), PR 5 (resolver, admin,
duplicate guard, PAY-4), PR 6 (fingerprint and provider key; first migration since
PR #27), PR 7 (tenant-scoped uniqueness, snapshots).

---

## ESP-04 (proposed) — Production defaults for media, email and web cookies

- **Scope:** safe-by-default configuration for media storage, outbound email and
  web session cookies, so a misconfigured production deployment fails closed
  rather than running with a development default.
- **Defects:** none confirmed; deferred from the engineering audit.
- **PRs:** none. **Status:** PLANNED. **Next action:** needs a written scope.

## ESP-05 (proposed) — Startup assertions and seeded dev rows

- **Scope:** API startup assertion follow-ups left over from ESP-02; remove seeded
  `internal-dev` rows from any non-development database.
- **PRs:** none. **Status:** PLANNED. **Next action:** needs a written scope.

## ESP-06 (proposed) — Workspace hygiene

- **Scope:** retire stale local worktrees and branches. Candidates recorded
  earlier: `centerivo-pr-22-security-917ac4`, `C:\w22b`,
  `fix/checkout-request-validation`. Removal was deferred once because a live
  session was attached; each removal needs a fresh safety check.
- **PRs:** none (local housekeeping, not a code change). **Status:** PLANNED.

## ESP-07, ESP-08 — not defined

No scope is recorded for either. Do not infer one from this document.

---

## Verification log

| Date (UTC) | What | Result |
|---|---|---|
| 2026-10-14 | `main` = `fba6fd0`; CI run 38591976541: Typecheck/lint/build, API tests, Worker tests, Web tests, Tenant isolation and route inventory | all five `success`; tenant isolation completed 15:53:08 |
| 2026-10-14 | Open PRs on the repository | none |
| 2026-10-14 | PR #28 independent review (two read-only specialist agents, findings re-checked against the code) | no merge blocker; risks R1-R3 recorded above |
