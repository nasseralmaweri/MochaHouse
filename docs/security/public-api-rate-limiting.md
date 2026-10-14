# Public API rate limiting (R1 / S3a)

Protects the public ordering and sign-in routes from excessive and abusive
requests without getting in the way of normal use. Code: `apps/api/src/rate-limit/`.
Web side: `apps/web/src/lib/client-ip-forwarding.ts`.

## What is protected

| Route | Policy | Scopes (starting limits) |
|---|---|---|
| `POST /orders` (checkout) | `checkout` | signed-in customer 30/min; anonymous per IP 30/min; tenant ceiling 300/min |
| `POST /orders/checkout-quote` | `checkout-quote` | customer 60/min; anonymous per IP 60/min; tenant 600/min |
| `POST /orders/reward-eligibility` | `reward-eligibility` | customer 30/min; tenant 300/min |
| `GET /orders/:orderId` (guest status, polled) | `order-status` | per order 30/min; **failed** lookups per IP 20 per 5 min; tenant 1200/min |
| `POST /auth/sign-in` | `customer-sign-in` | per identifier+IP 10 per 15 min; per IP 60 per 5 min; per identifier 40/hour |
| `POST /internal/auth/sign-in` | `internal-sign-in` | per identifier+IP 5 per 15 min; per IP 30 per 5 min; per identifier 20/hour |
| `POST /auth/register`, `/verification/resend`, `/forgot-password` | `account-recovery` | per identifier+IP 3/hour; per IP 10/hour; per identifier 6/hour |
| `POST /auth/verify`, `/reset-password` | `account-verification` | per identifier+IP 10 per 15 min; per IP 30 per 15 min; per identifier 30/hour |

Every key includes the **tenant** (the server-resolved tenant of the request,
never client input), so one business's traffic never counts against another's.
Existing one-off throttles (gift-card, careers, franchising) are unchanged and
should be migrated to this framework in a follow-up.

`apps/api/src/rate-limit/protected-routes.spec.ts` fails if a route above loses
its policy or its guard, or if a new customer-auth route is added without one.

### Why the scopes look like this

* **Anonymous vs signed-in.** A shop's Wi-Fi puts many real customers behind one
  IP, so a signed-in customer is limited by their own identity, never by the
  address, and anonymous per-IP limits are generous. The tenant ceiling is the
  circuit breaker against a flood.
* **Credential routes use three scopes.** The pair scope (identifier + IP)
  stops guessing from one place without letting an attacker elsewhere burn a
  victim's allowance. The per-IP scope stops one source spraying many accounts.
  The per-identifier ceiling is the IP-independent backstop (many sources, one
  victim) — it is also what caps how many emails or texts anyone can trigger to
  one person.
* **Guest status counts only failures against an address.** A customer polling
  a real order every 15 s (4/min per tab) never accrues failures; guessing
  tokens does, then returns 429 for any order from that address. The order
  scope separately bounds how hard one order can be polled.
* **Responses are uniform.** Every refusal is `429` with
  `{"statusCode":429,"message":"Too many requests. Please wait a moment and try again."}`
  and a numeric `Retry-After`, whichever scope fired and whether or not the
  account or order exists — nothing is learned about enumeration.
* Identifiers are normalised (Unicode NFKC, trimmed, lower-cased) and hashed
  before they reach Redis; raw emails never appear in keys or logs.

Known limit: a per-identifier ceiling can itself be used to deny a customer sign-in
for the rest of its window by someone who knows their email. The identity provider
(Cognito) has its own, tighter lockout, so this adds little; the real fix is a
CAPTCHA/challenge before general launch (not in this PR).

## Where the client IP comes from

The client IP is only ever taken from **a signed header** or **the connection's
peer address**. A raw `X-Forwarded-For` or any other unsigned header is never read.

`RATE_LIMIT_CLIENT_IP_MODE` chooses (default: `forwarded` if
`CLIENT_IP_FORWARD_SECRET` is set, otherwise **`off`**):

| Mode | Meaning | Use when |
|---|---|---|
| `forwarded` | The web tier sends the visitor's IP signed with a shared secret; requests without a valid signature use the peer address | The web app (server actions / proxy routes) calls this API — the normal topology |
| `peer` | The peer address (as Express resolves it from `TRUSTED_PROXY_HOP_COUNT`) *is* the client | Callers reach the API directly or via a known number of proxies |
| `off` | No per-IP limits; tenant, customer, identifier and order limits still apply | The topology has not been declared yet |

`off` is a deliberate, **logged** state (a warning at startup) — it is the safe
choice when the topology is unknown, because a wrong per-IP assumption would
throttle every visitor behind the web server as one client.

### Signed forwarding (`forwarded`)

Web → API request headers: `x-centerivo-client-ip`, `x-centerivo-client-ts`
(seconds), `x-centerivo-client-sig` = hex HMAC-SHA256 of `"<ts>.<ip>"` with the
shared secret. The API accepts it only if the signature verifies in constant
time and the timestamp is within ±60 s. A captured header can therefore choose
an IP bucket for at most a minute and only by someone who can already see
traffic between the web tier and the API.

Web side environment (all required, otherwise **nothing** is forwarded):

| Variable | Meaning |
|---|---|
| `CLIENT_IP_FORWARD_SECRET` | Same value as the API's; at least 32 characters |
| `CLIENT_IP_HEADER` | The request header **your own edge/proxy sets** with the client IP (for example `x-forwarded-for`, or a platform-specific header) |
| `CLIENT_IP_TRUSTED_HOPS` | How many of your proxies append to that header (default `1`). The client IP is the entry that many places from the **end** of a comma-separated list; earlier entries are client-controlled and ignored |

If the list is shorter than the hops you declared, the value is not an IP, or
anything else is wrong, nothing is forwarded (fail safe).

**This PR does not choose a hosting topology.** Which header and how many hops
depend on where the web app is deployed; set them once that is decided. Until
then run with `off` (or only the tenant/identifier protections).

## Configuration (API)

| Variable | Default | Meaning |
|---|---|---|
| `RATE_LIMIT_ENABLED` | `1` | `0` disables limiting — **refused at startup in production-like environments** |
| `RATE_LIMIT_CLIENT_IP_MODE` | see above | `forwarded`, `peer` or `off` |
| `CLIENT_IP_FORWARD_SECRET` | unset | Enables `forwarded`; ≥ 32 characters |
| `RATE_LIMIT_REDIS_TIMEOUT_MS` | `300` | A Redis call slower than this counts as a failure |
| `RATE_LIMIT_KEY_PEPPER` | unset | Optional secret mixed into identifier hashes |
| `RATE_LIMIT_<POLICY>_<SCOPE>_LIMIT` | table above | Per-scope limit, for example `RATE_LIMIT_CHECKOUT_IP_LIMIT=60` |
| `RATE_LIMIT_<POLICY>_<SCOPE>_WINDOW_SECONDS` | table above | Per-scope window |

Policy and scope names are upper-cased with `-` → `_`:
`CHECKOUT`, `CHECKOUT_QUOTE`, `REWARD_ELIGIBILITY`, `ORDER_STATUS`,
`CUSTOMER_SIGN_IN`, `INTERNAL_SIGN_IN`, `ACCOUNT_RECOVERY`,
`ACCOUNT_VERIFICATION`; scopes `SUBJECT`, `IP`, `TENANT`, `ORDER`, `FAILURES`,
`IDENTIFIER_IP`, `IDENTIFIER`. A malformed value refuses to start rather than
falling back to something looser. Set `TRUSTED_PROXY_HOP_COUNT` (existing) for
`peer` mode.

All limits are **starting values**. Tune from measurements: the API logs a
one-line summary of refusals by `policy/scope` at most once a minute, and
`RateLimitService.status().denials` exposes the same counters (counts only — no
addresses, identifiers or order ids).

## Redis failure behaviour

Counters are atomic (one Lua script does `INCR` + `EXPIRE`, so concurrent
requests cannot interleave and a key never lacks an expiry).

If Redis is not connected, errors, returns something unexpected, or does not
answer within `RATE_LIMIT_REDIS_TIMEOUT_MS`, the **same limit** is enforced by a
bounded in-process counter. Protection continues rather than switching off; the
trade-off is that the limit is then per API instance (so effectively multiplied
by the instance count). The degraded state is logged (one warning a minute) and
visible in `status()`; recovery is logged. No request waits on Redis longer than
the timeout. A request is never blocked *because* Redis is down.

## What the web app does on a 429

* Sign-in actions show "Too many attempts. Please wait a few minutes and try
  again." (not "Invalid email or password.").
* Checkout shows "Too many requests right now…" and keeps the same idempotency
  key, so retrying can never double-order. The proxy routes pass `Retry-After`
  through.
* Guest tracking and staff-queue polling treat 429 like any failed poll: the last
  good data stays on screen and polling backs off.

## Launch dependencies and remaining risks

* **Topology:** per-IP limits are inactive until the web tier's client-IP header
  and hop count (or `peer` mode) are configured. Decide this with the hosting.
* **Per-instance counters during a Redis outage.**
* **Targeted lockout** of one customer's sign-in (see above): needs a challenge.
* **Not yet covered:** gift-card, careers and franchising routes (existing
  one-off throttles); admin API polling; the media upload route.
* Staff polling (10 s) and customer polling (15 s) are intentionally far under
  every limit; re-check if those intervals change.
