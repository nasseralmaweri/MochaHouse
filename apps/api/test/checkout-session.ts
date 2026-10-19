import type {
  CheckoutRequest,
  CreateGiftCardPurchaseIntentRequest,
  GiftCardPurchaseIntentResponse,
  OrderConfirmation,
  PurchaseGiftCardRequest,
  PurchaseGiftCardResponse,
} from '@mocha-house/contracts';
import type { TenantContext } from '@mocha-house/database';
import request from 'supertest';
import { hashCheckoutToken } from '../src/orders/application/checkout-session';
import type { CustomerIdentity } from '../src/customer-auth/infrastructure/customer-identity';

// ESP-03 PR 6 — tests only. Since PR 6 a client never sends a payment key: it
// starts a server-owned checkout session and presents that session's token
// on every submission and retry. Many suites were written around a
// client-chosen key; these helpers let them keep a stable per-test label
// (`clientRef`) that maps to ONE checkout session, exactly the way a real
// client keeps one checkout across retries. Nothing here is reachable from
// the API.

const tokens = new Map<string, string>();

interface SessionStarter {
  startSession(
    request: { locationId: string; checkoutToken?: string | null },
    customerIdentity: CustomerIdentity | undefined,
    tenant: TenantContext,
  ): Promise<{ checkoutToken: string }>;
}

interface Checkout extends SessionStarter {
  checkout(
    request: CheckoutRequest,
    customerIdentity: CustomerIdentity | undefined,
    tenant: TenantContext,
  ): Promise<OrderConfirmation>;
}

// A checkout request as these suites build it: everything but the token,
// plus the label of the checkout it belongs to.
export type LabelledCheckoutRequest = Omit<CheckoutRequest, 'checkoutToken'> & {
  clientRef: string;
};

// The token of the checkout labelled `clientRef`, starting its session (for
// the given business, location and customer) on first use.
export async function checkoutTokenFor(
  service: SessionStarter,
  clientRef: string,
  locationId: string,
  customerIdentity: CustomerIdentity | undefined,
  tenant: TenantContext,
): Promise<string> {
  const known = tokens.get(clientRef);
  if (known) return known;
  // Concurrent first submissions of one checkout share ONE session start,
  // exactly as one client page does.
  let starting = startingSessions.get(clientRef);
  if (!starting) {
    starting = service
      .startSession({ locationId }, customerIdentity, tenant)
      .then(({ checkoutToken }) => {
        tokens.set(clientRef, checkoutToken);
        return checkoutToken;
      })
      .finally(() => startingSessions.delete(clientRef));
    startingSessions.set(clientRef, starting);
  }
  return starting;
}
const startingSessions = new Map<string, Promise<string>>();

// Submits (or retries) the checkout labelled `request.clientRef`.
export async function submitCheckout(
  service: Checkout,
  request: LabelledCheckoutRequest,
  customerIdentity: CustomerIdentity | undefined,
  tenant: TenantContext,
): Promise<OrderConfirmation> {
  const { clientRef, ...rest } = request;
  const checkoutToken = await checkoutTokenFor(
    service,
    clientRef,
    rest.locationId,
    customerIdentity,
    tenant,
  );
  return service.checkout({ ...rest, checkoutToken }, customerIdentity, tenant);
}

// A Prisma `where` for the payment attempts of the checkout (or gift-card
// purchase) labelled `clientRef` (newest first when ordered by createdAt
// desc).
export function attemptsOfCheckout(
  clientRef: string,
):
  | { checkoutSession: { tokenHash: string } }
  | { giftCardPurchase: { id: string } }
  | { idempotencyKey: string } {
  // A server-generated payment key (e.g. from a provider double's
  // ChargeRequest) names its attempt directly.
  if (/^(ck|gc)_/.test(clientRef)) return { idempotencyKey: clientRef };
  const purchaseId = giftPurchases.get(clientRef);
  if (purchaseId) return { giftCardPurchase: { id: purchaseId } };
  const token = tokens.get(clientRef);
  if (!token) {
    // Never started: matches nothing.
    return { checkoutSession: { tokenHash: '-' } };
  }
  return { checkoutSession: { tokenHash: hashCheckoutToken(token) } };
}

// --- gift cards ----------------------------------------------------------------
// Since PR 6 step 1 always establishes a NEW purchase (server-generated key)
// and step 2 names it by purchaseId. Suites keep a label per purchase.

const giftPurchases = new Map<string, string>();

interface GiftPurchases {
  createIntent(
    request: CreateGiftCardPurchaseIntentRequest,
    customerIdentity: CustomerIdentity | undefined,
    tenant: TenantContext,
  ): Promise<GiftCardPurchaseIntentResponse>;
  purchase(
    request: PurchaseGiftCardRequest,
    customerIdentity: CustomerIdentity | undefined,
    tenant: TenantContext,
  ): Promise<PurchaseGiftCardResponse>;
}

export async function createGiftIntent(
  service: GiftPurchases,
  request: CreateGiftCardPurchaseIntentRequest & { clientRef: string },
  customerIdentity: CustomerIdentity | undefined,
  tenant: TenantContext,
): Promise<GiftCardPurchaseIntentResponse> {
  const { clientRef, ...rest } = request;
  const intent = await service.createIntent(rest, customerIdentity, tenant);
  giftPurchases.set(clientRef, intent.purchaseId);
  return intent;
}

export function giftPurchaseIdFor(clientRef: string): string {
  return giftPurchases.get(clientRef) ?? '00000000-0000-7000-8000-000000000000';
}

export function purchaseGiftCard(
  service: GiftPurchases,
  request: { clientRef: string; recoveryCredential?: string | null },
  customerIdentity: CustomerIdentity | undefined,
  tenant: TenantContext,
): Promise<PurchaseGiftCardResponse> {
  return service.purchase(
    {
      purchaseId: giftPurchaseIdFor(request.clientRef),
      recoveryCredential: request.recoveryCredential,
    },
    customerIdentity,
    tenant,
  );
}

// A Prisma `where` for every payment attempt of every checkout this suite
// started (for cleanup).
export function checkoutAttemptsOfThisSuite(): {
  OR: [
    { checkoutSession: { tokenHash: { in: string[] } } },
    { giftCardPurchase: { id: { in: string[] } } },
  ];
} {
  return {
    OR: [
      {
        checkoutSession: {
          tokenHash: { in: [...tokens.values()].map(hashCheckoutToken) },
        },
      },
      { giftCardPurchase: { id: { in: [...giftPurchases.values()] } } },
    ],
  };
}

// A Prisma `where` for every checkout session this suite started.
export function checkoutSessionsOfThisSuite(): { tokenHash: { in: string[] } } {
  return { tokenHash: { in: [...tokens.values()].map(hashCheckoutToken) } };
}

export function knownCheckoutToken(clientRef: string): string | undefined {
  return tokens.get(clientRef);
}

// HTTP suites: the token of the checkout labelled `clientRef`, started
// through POST /api/v1/orders/checkout-sessions on first use.
export async function httpCheckoutToken(
  clientRef: string,
  start: () => Promise<{ status: number; body: unknown }>,
): Promise<string> {
  const known = tokens.get(clientRef);
  if (known) return known;
  const response = await start();
  const token = (response.body as { checkoutToken?: unknown } | null)
    ?.checkoutToken;
  if (response.status !== 200 || typeof token !== 'string') {
    throw new Error(
      `Starting the checkout session failed (${response.status}): ${JSON.stringify(response.body)}`,
    );
  }
  tokens.set(clientRef, token);
  return token;
}

// HTTP suites: turns a checkout body as these suites build it (a label in
// `clientRef` or the old `idempotencyKey` field) into what a client sends
// since PR 6: the checkout-session token instead of any key. The session is
// started (once per label) through POST /api/v1/orders/checkout-sessions
// with the same Authorization / headers. A body whose session cannot be
// started (an invalid location, a refused customer) is sent without a token,
// so the checkout route answers for the body itself.
export async function httpCheckoutBody(
  server: Parameters<typeof request>[0],
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  const { idempotencyKey, clientRef, ...rest } = body as Record<
    string,
    unknown
  >;
  const label =
    typeof clientRef === 'string'
      ? clientRef
      : typeof idempotencyKey === 'string'
        ? idempotencyKey
        : null;
  // A wrongly-typed key is passed through so the route refuses it as sent.
  if (idempotencyKey !== undefined && typeof idempotencyKey !== 'string') {
    return { ...rest, idempotencyKey };
  }
  if (typeof rest.locationId !== 'string') return rest;
  let token = label ? tokens.get(label) : undefined;
  if (!token) {
    const res = await request(server)
      .post('/api/v1/orders/checkout-sessions')
      .set(headers)
      .send({ locationId: rest.locationId });
    const started = (res.body as { checkoutToken?: unknown } | null)
      ?.checkoutToken;
    if (res.status !== 200 || typeof started !== 'string') return rest;
    token = started;
    if (label) tokens.set(label, token);
  }
  return { ...rest, checkoutToken: token };
}

// A pending response that can still be asserted like a supertest chain
// (`await post(...).expect(201)`), for suites whose request builders became
// async when they started checkout sessions.
export function withStatusExpectation<T extends { status: number }>(
  pending: Promise<T>,
): Promise<T> & { expect(status: number): Promise<T> } {
  return Object.assign(pending, {
    async expect(status: number): Promise<T> {
      const response = await pending;
      if (response.status !== status) {
        throw new Error(
          `Expected ${status}, got ${response.status}: ${JSON.stringify((response as { body?: unknown }).body)}`,
        );
      }
      return response;
    },
  });
}
