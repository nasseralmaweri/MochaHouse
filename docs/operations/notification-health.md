# Notification health (R1 / S4c)

A read-only view of whether a business's notifications are being sent, retried or
given up on. It does not send, re-send or re-drive anything.

## How to see it

* **Admin UI:** Admin → *Notifications* (`/admin/notifications`), shown to
  administrators who hold `notifications.routing.view` (CORPORATE-only; the same
  administrators who see where notifications are routed). Reload the page to refresh.
* **API:** `GET /api/v1/admin/notifications/health` (same permission, scoped to the
  active business — never a client-supplied tenant).
* **Worker logs:** the notification worker (S4b) writes a one-line summary every
  minute while there is activity or a backlog (`claimed/accepted/retried/ambiguous/dead`,
  backlog, oldest due age) and an error line per dead letter. Neither contains
  recipient addresses, tokens or message text. Per-tenant detail is only available
  through the API/UI above and the runbook SQL.

## What it shows

Every *pending* notification is in exactly one bucket:

| Bucket | Meaning |
|---|---|
| Waiting | Due now (within 5 minutes), about to be picked up |
| Being sent | Leased by a worker right now |
| Waiting to retry | Scheduled for a later attempt (a delay after a failed attempt, or a future first attempt) |
| Not being processed | Due for **more than 5 minutes** and still not picked up |

plus *Gave up* (dead-lettered: permanent failure, retries exhausted, expired, crash
loop; 24 h and 7 days), *Accepted* (the email provider accepted it — **not** proof of
inbox delivery; 24 h and 7 days), *possible duplicates* (an earlier send got no answer
and was retried once), the oldest pending / retrying / overdue ages, the main reason
codes, and up to 25 notifications worth looking at (dead letters first, then the
longest overdue). Events an operator **closed on purpose** at a cut-over
(`HISTORICAL_NOT_SENT`) are counted separately and never alert.

## What needs attention (and what does not)

An **ordinary retry is not a problem**: a failed attempt followed by a retry is what
the worker is for, and it does not change the status. These do:

| Signal | Severity | Likely meaning |
|---|---|---|
| Any gave-up notification in the last 24 h | Act now | A notification will not be tried again (see the reasons) |
| Gave-up notifications only earlier this week | Review | Unreviewed earlier failures |
| Not being processed, overdue < 30 min | Review | Worker stopped, held back, or behind |
| Not being processed, overdue ≥ 30 min | Act now | Worker down / stuck |
| 3+ failed attempts and still retrying | Review | Provider or configuration problem |
| Possible duplicates | Information | Retried once after an unanswered send |

Overall status: *Working normally* / *Needs a look* / *Needs attention now* (the
worst of the above; information never changes it).

## Blind spots (known)

* **No worker heartbeat.** "Worker stopped" is inferred from due notifications that
  are not being picked up. A stopped worker with an empty queue looks healthy until
  the next notification is created.
* **Held-back history looks like a stopped worker.** Events held by
  `OUTBOX_HISTORICAL_CUTOFF` stay pending and count as *Not being processed* until an
  operator classifies them (cut-over runbook, Phase 3).
* **Not inbox delivery.** The provider's acceptance is the last thing the system can
  see; bounces and complaints are not tracked yet.
* **Per business only.** A platform-wide view across businesses does not exist.
* **No alerting.** Someone has to look (or a monitor has to read the API / logs).
* **No actions.** Re-send and re-drive are deliberately not here; use the cut-over
  runbook's re-drive section.
