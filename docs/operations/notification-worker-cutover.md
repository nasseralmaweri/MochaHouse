# Notification worker (R1 / S4b): design, operation and cut-over runbook

**Status:** prepared, **not executed**. S4a's migrations have not been applied to any
persistent environment, and nothing here has been run against production.

## 1. What the worker guarantees (and does not)

* `OutboxEvent.status`
  * `PENDING` — unfinished or waiting for a retry (it is *in progress* while
    `leaseExpiresAt` is in the future)
  * `PROCESSED` — handled. For email: the provider **accepted** the message and the
    acceptance is recorded on the delivery first. It does **not** mean the message
    reached the customer's inbox.
  * `FAILED` — dead letter: permanent failure, retries exhausted, or too stale to send.
* **Not exactly-once.** SES has no idempotency key. If a process dies — or the
  database write fails — between SES accepting a message and the worker recording
  it, the next attempt cannot know. It retries **once**, sets
  `NotificationDelivery.possibleDuplicate`, and a *second* unanswered send is
  escalated to the dead letter (`AMBIGUOUS_REPEATED`) rather than repeated.
* The shop order queue never depends on any of this: it reads committed `Order`
  state only. A stopped, failing or dead-lettering worker cannot hide an order.

### One attempt, step by step

1. **Claim** (`OutboxStore.claimNext`): one `UPDATE … FOR UPDATE SKIP LOCKED` picks
   the next due, unleased event of any tenant and takes a 60 s lease. The lease owner
   is a fresh random token and `attemptCount` is bumped, so a claim is identified by
   `(id, tenantId, leaseOwner, attemptCount)`. Every later write is fenced on all four.
2. Work runs inside a worker `TenantContext` built from the event's own `tenantId`.
3. Stale? Expired events are dead-lettered unsent (see §3).
4. Resolve recipient and render. Permanent problems (order or recipient missing,
   nothing configured for the tenant) dead-letter at once; a database error retries.
5. **Persist the delivery intent** (`sendStartedAt`) — conditional on still holding
   the claim *and* having enough lease left to finish a send.
6. **Call the provider** (10 s timeout, no database transaction open).
7. **Record acceptance on the delivery**, then mark the event `PROCESSED` (fenced).
8. Failures: a *definite* refusal (SES answered with an error) is recorded and retried
   with backoff (or dead-lettered if it can never succeed); *no answer* (timeout,
   connection loss, unknown error) is **ambiguous** — see above.

### Failure boundaries

| Where it dies | What happens |
|---|---|
| Before the claim | Nothing; the event is still due. |
| After the claim, before the intent | Lease expires; clean retry, no duplicate. |
| After the intent, before/while calling SES | Lease expires; the intent is unresolved → one flagged retry (`possibleDuplicate`). |
| SES accepted, acceptance not recorded | Same as above (a duplicate is possible and flagged). |
| Acceptance recorded, event not yet `PROCESSED` | Lease expires; the worker sees `SENT`, **does not send again**, and completes the event. |
| Graceful shutdown (SIGTERM) | Stop claiming; attempts in flight finish (≤ send timeout); a claim not yet sending is handed back without using an attempt. |
| Forced kill | Lease expires (≤ 60 s) and the event is recovered. |

## 2. Retry policy

Definite, retryable failures back off exponentially with ±20 % jitter:
30 s, 2 m, 8 m, 32 m, 2.1 h, 6 h (×4 per attempt, capped), at most **7 attempts**
(`OUTBOX_MAX_ATTEMPTS`). Throttling, outages, account/domain problems an operator
can fix and missing SES configuration are retryable; `MessageRejected`,
`InvalidParameterValue` and similar are permanent.

## 3. Staleness (event-specific, no global cut-off)

Defaults in `retry-policy.ts`: `order.status.ready` 3 h, `order.checkout.completed`
12 h, careers/franchising notices 7 days; an unknown event type never goes stale.
`OutboxEvent.expiresAt`, when a producer sets it, overrides the default. A retry that
would land after the expiry is dead-lettered (`EVENT_EXPIRED`) instead of scheduled.

## 4. Configuration (apps/worker)

| Variable | Default | Meaning |
|---|---|---|
| `OUTBOX_WORKER_ENABLED` | `1` | `0`/`false` = boot, check the schema, claim nothing. Only `0`, `1`, `true`, `false` are accepted — anything else refuses to start |
| `OUTBOX_CONCURRENCY` | `2` | independent claim loops (1–10); also the max simultaneous provider calls |
| `OUTBOX_POLL_INTERVAL_MS` | `2000` | idle wait between polls |
| `OUTBOX_LEASE_SECONDS` | `60` | lease length (≥ 2 × (send timeout + 5 s)) |
| `OUTBOX_SEND_TIMEOUT_MS` | `10000` | provider timeout; a timeout is *ambiguous* |
| `OUTBOX_MAX_ATTEMPTS` | `7` | attempts before the dead letter |
| `OUTBOX_BACKOFF_BASE_MS` / `_CAP_MS` | `30000` / `21600000` | first delay / cap |
| `OUTBOX_SHUTDOWN_GRACE_MS` | `20000` | how long shutdown waits for attempts in flight |
| `OUTBOX_HISTORICAL_CUTOFF` | unset | ISO-8601 instant **with a time zone** (`2026-10-20T14:00:00Z`): events **created earlier are never claimed** (left for classification). **Required unless `NODE_ENV` is `development`, `test` or `local`** (an unset or misspelt `NODE_ENV` counts as production) — an instant, or `none` once the backlog is classified. A cut-off in the future is refused. |

A malformed value refuses to start. Held-back events are reported in the per-minute log as `heldByCutoff` and are never counted as "due". The worker also refuses to start if the S4a
columns are missing (it never falls back to the old claim-then-send behaviour).

## 5. Cut-over runbook (do not run without approval)

Ordering matters: **the legacy worker marks any `PENDING` row `PROCESSED` and sends it,
ignoring `nextAttemptAt` and the cut-off, and S4b's leases make that update fail.
There must never be two kinds of worker running, and the legacy worker must be gone
BEFORE history is classified (it would otherwise keep consuming the very rows you
are classifying).**

### Phase 0 — readiness (read-only)

```sql
-- Table sizes: the S4a migration builds indexes / validates constraints on these.
SELECT relname, n_live_tup FROM pg_stat_user_tables
 WHERE relname IN ('OutboxEvent', 'NotificationDelivery');
-- Pending backlog by age, type and tenant.
SELECT "tenantId", "eventType", count(*) AS n, min("createdAt") AS oldest
  FROM "OutboxEvent" WHERE status = 'PENDING' GROUP BY 1, 2 ORDER BY oldest;
```
Stop if the tables are large (the plain `CREATE INDEX` briefly blocks writes). Confirm
a recent backup/snapshot exists. List every running worker instance on every host.

### Phase 1 — apply the S4a migrations (legacy worker still running)

`prisma migrate deploy` applies `20261018090000_notification_reliability_foundation`
and `20261018090100_notification_reliability_validate_checks`. The legacy worker keeps
working (every column is nullable/defaulted). Verify:

```sql
SELECT conname, convalidated FROM pg_constraint
 WHERE conname LIKE 'OutboxEvent\_%\_check' OR conname = 'NotificationDelivery_possibleDuplicate_check';
-- every row must be convalidated = true
```
If a migration fails nothing is changed: follow its header (`prisma migrate resolve
--rolled-back …`, fix, redeploy).

### Phase 2 — stop the legacy worker and prove it is gone

1. Stop **every** legacy worker instance (scale to 0 / stop the service) on every host.
2. Process proof: no legacy worker process remains anywhere.
3. Connection proof (works even when idle): the legacy worker holds database
   connections; confirm none belong to it, using the connection `application_name`
   / user / client address it runs with:
   ```sql
   SELECT pid, usename, application_name, client_addr, state, backend_start
     FROM pg_stat_activity WHERE datname = current_database() ORDER BY backend_start;
   ```
4. Behavioural proof — a legacy worker marks events `PROCESSED` with **no attempt data**.
   Create a harmless test event (non-production, or a no-handler type) and watch it stay
   `PENDING` for several minutes; this count must stay 0:
   ```sql
   SELECT count(*) FROM "OutboxEvent"
    WHERE status = 'PROCESSED' AND "attemptCount" = 0
      AND "processedAt" > timezone('utc', now()) - interval '5 minutes';
   ```
Only continue when both proofs agree. (Producers keep writing events meanwhile; they
simply accumulate as `PENDING`.)

### Phase 3 — classify the existing `PENDING` records (nothing is sent yet)

Choose the **cut-off instant `T`**: the moment from which events should be delivered
by S4b (typically "now", after Phase 2). History must not be emailed by accident:

* Events created **at or after `T`** are delivered normally.
* Events created **before `T`** are never claimed by S4b while
  `OUTBOX_HISTORICAL_CUTOFF >= T`. They stay `PENDING` and visible as `heldByCutoff`.
  Decide each group (count them first, by tenant and type — Phase 0 query):
  * **send them anyway** (recent, genuinely unprocessed): set `OUTBOX_HISTORICAL_CUTOFF`
    *earlier* than the oldest of them, or lower `T` for them; or
  * **do not send** — close them explicitly (auditable, never silent). Run in a
    transaction, scoped to exactly the group you decided, and compare the row count with
    the counts you recorded:
```sql
BEGIN;
UPDATE "OutboxEvent"
   SET status = 'FAILED', "failedAt" = timezone('utc', now()),
       "lastErrorCode" = 'HISTORICAL_NOT_SENT',
       "lastError" = 'Closed at the S4b cut-over: not sent by design.'
 WHERE status = 'PENDING' AND "attemptCount" = 0
   AND "createdAt" < :T          -- and, if needed:  AND "tenantId" = :tenant AND "eventType" = :type
RETURNING id, "tenantId", "eventType", "createdAt";   -- compare with the pre-counts, then COMMIT or ROLLBACK
```
**Do this before enabling S4b, and again before any rollback to the legacy worker**
(§6): the legacy worker ignores the cut-off.

### Phase 4 — start S4b

1. Deploy S4b with `OUTBOX_WORKER_ENABLED=0` and `OUTBOX_HISTORICAL_CUTOFF=<T>`
   (and `NODE_ENV=production`). The worker must boot (schema check passes) and claim nothing.
2. Check the SES configuration (verified sender, production access/limits, region).
   **Do not activate a real provider until this is signed off.**
3. Set `OUTBOX_WORKER_ENABLED=1`. Watch the per-minute summary log
   (`claimed/accepted/retried/ambiguous/dead`, backlog, `heldByCutoff`, oldest due age).
4. Place a real test order and confirm: `PROCESSED`, delivery `SENT`, one email.

### Monitoring queries

```sql
-- Due now / retrying / leased / dead (ignores events held back by the cut-off)
SELECT count(*) FILTER (WHERE status='PENDING' AND "nextAttemptAt" <= timezone('utc',now())
                         AND "createdAt" >= :T
                         AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < timezone('utc',now()))) AS due,
       count(*) FILTER (WHERE status='PENDING' AND "attemptCount" > 0) AS retrying,
       count(*) FILTER (WHERE status='PENDING' AND "leaseExpiresAt" >= timezone('utc',now())) AS leased,
       count(*) FILTER (WHERE status='FAILED') AS dead
  FROM "OutboxEvent";
-- Dead letters with reasons
SELECT "tenantId", "eventType", "lastErrorCode", count(*), max("failedAt")
  FROM "OutboxEvent" WHERE status='FAILED' GROUP BY 1,2,3 ORDER BY max("failedAt") DESC;
-- Possible duplicates and unresolved sends
SELECT id, "tenantId", "templateKey", "possibleDuplicate", "sendStartedAt", "sentAt"
  FROM "NotificationDelivery" WHERE "possibleDuplicate" OR (status='PENDING' AND "sendStartedAt" IS NOT NULL);
```
Alert on: dead letters in the last 24 h, oldest due age > 5 min, any `AMBIGUOUS_REPEATED`,
any `ATTEMPTS_EXCEEDED` (a crashing event), and `heldByCutoff` that does not go to 0 after
Phase 3 classification.

### Re-driving a dead letter (manual, deliberate)

Events whose `createdAt` is **before `OUTBOX_HISTORICAL_CUTOFF` are never re-claimed**; lower
the cut-off or leave them. Before re-driving, check the SES sending log for **every**
dead letter that came from an *ambiguous* attempt — `AMBIGUOUS_REPEATED`, and also
`RETRIES_EXHAUSTED`/`ATTEMPTS_EXCEEDED` whose last error was `SEND_TIMEOUT` or
`SEND_OUTCOME_UNKNOWN` — the message may already have been sent. If it was NOT sent
(or the failures were definite refusals such as throttling):

```sql
BEGIN;
UPDATE "OutboxEvent" SET status='PENDING', "failedAt"=NULL, "attemptCount"=0,
       "nextAttemptAt"=timezone('utc',now()), "lastError"=NULL, "lastErrorCode"=NULL
 WHERE id = :eventId AND status='FAILED';
-- A definite failure must not look like an unresolved send on the next attempt.
UPDATE "NotificationDelivery"
   SET status='PENDING', "failureReason"=NULL, "sendStartedAt"=NULL, "possibleDuplicate"=FALSE
 WHERE "outboxEventId" = :eventId AND status='FAILED';
COMMIT;
```
(If you *do* keep `sendStartedAt`, the next attempt is treated as ambiguous and flagged
`possibleDuplicate`.) An event past its staleness window is dead-lettered again.

## 6. Rollback

1. **Pause (preferred, no data risk):** set `OUTBOX_WORKER_ENABLED=0`. Events stay
   `PENDING`/`FAILED`; nothing is lost; resume by re-enabling.
2. **Back to the legacy worker** (only if S4b must be abandoned). The legacy worker
   sends **every `PENDING` event at once**, ignores the cut-off and backoff, and marks
   any event that already has a delivery row `PROCESSED` **without sending**. So:
   1. Stop all S4b workers (set `OUTBOX_WORKER_ENABLED=0`, then stop), and wait 60 s
      or clear leases:
      `UPDATE "OutboxEvent" SET "leaseOwner"=NULL,"leaseExpiresAt"=NULL WHERE status='PENDING';`
   2. **Close or park everything the legacy worker must not touch**, exactly as in
      Phase 3 — in particular all events created before the cut-off (still `PENDING`)
      and any retrying event (`attemptCount > 0`):
      ```sql
      SELECT status, count(*) FILTER (WHERE "createdAt" < :T) AS before_cutoff,
             count(*) FILTER (WHERE "attemptCount" > 0) AS retrying, count(*) AS total
        FROM "OutboxEvent" WHERE status='PENDING' GROUP BY 1;
      ```
   3. Understand what remains: a `PENDING` event that already has a delivery row (it
      reached the send step and was being retried) will be marked `PROCESSED` by the
      legacy worker **and never sent**. Decide per event: send it by hand, or accept.
   4. Start the legacy worker. `FAILED` events are never retried by it.
3. **Schema:** leave the S4a columns in place (additive). The S4a rollback SQL refuses
   to run once reliability data exists, by design.

## 7. Remaining risks

* A duplicate email is still possible in the ambiguous window; it is flagged, visible
  and bounded to one. Two consecutive unanswered sends (timeouts / resets) dead-letter
  the event rather than repeat it, which can happen within minutes of a flaky network;
  only failures where nothing could have been sent (SES error response, connection
  refused, DNS failure, credential problems) are retried for the full ~9 h schedule.
* A long SES outage dead-letters notifications after the retry schedule (earlier for
  stale event types); they need a deliberate re-drive and may be too stale to send.
* Throughput is about `OUTBOX_CONCURRENCY / send time`; one tenant flooding events
  delays others (ordering is by due time, not per tenant).
* Per-event-type ageing is a code table; producers can request a custom window only
  through `expiresAt`.
* The provider SDK may mis-report some failures; an unrecognised error is treated as
  ambiguous (the safe side).
* SES account setup (verified identities, production access, bounce/complaint
  handling) is separate work and a launch prerequisite.
