import { randomUUID } from "node:crypto";

// Provider-neutral payment boundary. The order domain only ever depends on
// this interface — never on FakePaymentProvider by name — so a real
// processor can be substituted later via dependency injection with no
// change to checkout orchestration or the Order schema. `metadata` is a
// pass-through bag (the same shape any real processor's SDK typically
// accepts for reconciliation) rather than a fake-specific test hook.
//
// A provider must never guess an unknown external outcome: every call
// resolves to exactly one deterministic outcome, decided synchronously.
// (A real, asynchronous provider would extend this contract rather than
// violate this rule — e.g. by adding a PENDING outcome reconciled via
// webhook — not by returning a guessed result.)

export interface ChargeRequest {
  idempotencyKey: string;
  amount: number;
  currency: string;
  metadata?: Record<string, string>;
}

// Outcome vocabulary (ESP-03 PR 2). "declined" and "failed" are DEFINITIVE:
// the provider certifies that no money moved. "pending" means the provider
// accepted the charge but has not finished it (awaiting confirmation).
// "unknown" means the provider cannot say what happened. A provider that
// throws or times out is treated by callers exactly like "unknown" — never
// like "failed" — because the charge may have gone through.
export type ChargeResult =
  | { outcome: "succeeded"; providerReference: string }
  | { outcome: "declined"; reason: string }
  | { outcome: "failed"; reason: string }
  | { outcome: "pending"; reason: string; providerReference?: string }
  | { outcome: "unknown"; reason: string };

export interface PaymentProvider {
  readonly name: string;
  // False when this provider can never take a payment (no processor is
  // configured). Callers check it BEFORE recording anything, so a request
  // that needs an external charge is refused without side effects.
  readonly acceptsPayments: boolean;
  charge(request: ChargeRequest): Promise<ChargeResult>;
}

// Deterministic test double for Milestone 3. There is no real money
// movement and no external network call — every outcome is decided purely
// from the request, so tests and manual QA can reproduce any outcome on
// demand through the real checkout form, not a hidden flag.
//
// Decline trigger: a guest phone number of exactly
// FakePaymentProvider.DECLINE_TEST_PHONE reliably produces a decline,
// regardless of cart contents — the fake-provider equivalent of a real
// gateway's documented "test card" numbers.
export class FakePaymentProvider implements PaymentProvider {
  static readonly DECLINE_TEST_PHONE = "0000000000";

  readonly name = "fake";

  // Never in production, checked on every call (see `charge`).
  get acceptsPayments(): boolean {
    return process.env.NODE_ENV !== "production";
  }

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    // Payment safety — a simulated payment must never count as paid in
    // production, whatever bound this provider there. Checked on every call
    // (never cached), the same floor the development auth providers use.
    if (process.env.NODE_ENV === "production") {
      return { outcome: "failed", reason: "Online payment is not available." };
    }
    if (!Number.isInteger(request.amount) || request.amount <= 0) {
      return { outcome: "failed", reason: "Amount must be greater than zero." };
    }

    if (request.metadata?.guestPhone === FakePaymentProvider.DECLINE_TEST_PHONE) {
      return {
        outcome: "declined",
        reason: "The payment method was declined.",
      };
    }

    return { outcome: "succeeded", providerReference: `fake_${randomUUID()}` };
  }
}

// Payment safety — bound when no payment processor is configured (and the
// only choice in production until a live processor is integrated). It never
// takes a payment: callers see `acceptsPayments === false` and refuse the
// request before recording anything; `charge` fails as a last resort.
export class UnavailablePaymentProvider implements PaymentProvider {
  readonly name = "unavailable";
  readonly acceptsPayments = false;

  async charge(_request: ChargeRequest): Promise<ChargeResult> {
    return { outcome: "failed", reason: "Online payment is not available." };
  }
}

// --- ESP-04 M2: intent-based payments (provider interface v2) -------------------
//
// A real processor (Stripe PaymentIntents, M3) takes a payment in TWO steps:
// the server creates a payment intent for the exact amount, the customer
// confirms it in the browser (card details, 3-D Secure), and the server then
// learns the outcome from the provider — never from the browser. A provider
// that supports this implements PaymentIntentProvider alongside (or instead
// of) the one-step `charge`. Gift-card purchases keep using `charge` until a
// later milestone.
//
// Outcome vocabulary — what the provider AUTHORITATIVELY reports:
//   succeeded                 the money moved;
//   requires_customer_action  the customer must confirm (first time);
//   requires_payment_method   the customer's attempt was refused and they may
//                             try again ON THE SAME intent — not a failure;
//   processing                the provider is still working it out (money may
//                             move): never retried, never released;
//   canceled                  the intent is cancelled: no charge can occur;
//   failed                    CREATION ONLY: the provider definitively refused
//                             before any intent existed (e.g. a validation or
//                             account refusal), so nothing can ever be charged.
//                             The caller then closes the payment and releases
//                             its holds. An adapter MUST NOT map a timeout, a
//                             network error, a 5xx or any answer after which
//                             an intent might exist to "failed" — those are
//                             "unknown" (held, never released);
//   unknown                   the provider could not say (timeouts, errors):
//                             treated as possibly charged.

// The restaurant account a payment is taken for, resolved by the SERVER from
// the business — never supplied by a client. `connectedAccountId` is the
// restaurant's connected account at the processor (null for providers that
// have none, e.g. the development fake).
export interface PaymentAccountContext {
  tenantId: string;
  connectedAccountId: string | null;
}

export type PaymentIntentResult =
  // The amount and currency the provider actually took: checked against the
  // frozen checkout before anything is recorded as paid.
  | { status: "succeeded"; reference: string; amount: number; currency: string }
  | { status: "requires_customer_action"; reference: string }
  | { status: "requires_payment_method"; reference: string }
  | { status: "processing"; reference: string }
  | { status: "canceled"; reference: string }
  | { status: "failed"; reason: string }
  | { status: "unknown"; reason: string; reference?: string };

export interface CreatePaymentIntentRequest {
  // Our payment attempt's server-generated key: the provider's idempotency
  // key, so a retried creation returns the SAME intent.
  idempotencyKey: string;
  amount: number;
  currency: string;
  account: PaymentAccountContext;
  // Reconciliation only (our ids); never personal data or secrets.
  metadata?: Record<string, string>;
}

export interface PaymentIntentProvider {
  readonly name: string;
  readonly acceptsPayments: boolean;
  createPaymentIntent(
    request: CreatePaymentIntentRequest,
  ): Promise<PaymentIntentResult>;
  // The provider's current, authoritative state of an existing intent.
  retrievePaymentIntent(input: {
    reference: string;
    account: PaymentAccountContext;
  }): Promise<PaymentIntentResult>;
  // What the customer's browser needs to confirm the intent (Stripe: the
  // client secret), fetched fresh whenever it is needed, so a reload or an
  // interrupted response can always resume the SAME intent. Never stored or
  // logged by the caller. Null when the browser needs nothing (the fake).
  clientSecretFor(input: {
    reference: string;
    account: PaymentAccountContext;
  }): Promise<string | null>;
  // Cancels an intent that has not succeeded (ESP-04 M4 uses it). Returns
  // the intent's resulting state.
  cancelPaymentIntent(input: {
    reference: string;
    account: PaymentAccountContext;
  }): Promise<PaymentIntentResult>;
}

export function isPaymentIntentProvider(
  provider: unknown,
): provider is PaymentIntentProvider {
  const p = provider as Partial<PaymentIntentProvider> | null;
  return (
    typeof p === "object" &&
    p !== null &&
    typeof p.createPaymentIntent === "function" &&
    typeof p.retrievePaymentIntent === "function" &&
    typeof p.clientSecretFor === "function" &&
    typeof p.cancelPaymentIntent === "function"
  );
}

// What the development simulator may make a fake intent do next.
export type SimulatedPaymentOutcome =
  "succeed" | "decline" | "process" | "cancel" | "unknown";

type FakeIntentState =
  | "requires_customer_action"
  | "requires_payment_method"
  | "processing"
  | "succeeded"
  | "canceled";

// Deterministic two-step stand-in for a processor — development and tests
// ONLY (refused in production, staging or live by the provider-mode check,
// and inert in production here too). No money moves and nothing leaves the
// process. Intents start as requires_customer_action; the development
// simulator (or a test) decides what the "customer" did. Creation is
// idempotent by key, exactly like a real processor.
export class FakeTwoStepPaymentProvider
  implements PaymentIntentProvider, PaymentProvider
{
  readonly name = "fake-two-step";
  // Gift-card purchases keep the one-step charge until ESP-04 M6: the same
  // deterministic behaviour as FakePaymentProvider.
  private readonly oneStep = new FakePaymentProvider();

  private readonly intents = new Map<
    string,
    {
      status: FakeIntentState;
      tenantId: string;
      unknownOnce: boolean;
      amount: number;
      currency: string;
    }
  >();
  private readonly byKey = new Map<string, string>();
  // Tests: make the next call misbehave like an unreachable provider.
  failNext: "create" | "retrieve" | null = null;
  createCalls = 0;
  // Tests: report a succeeded intent as having taken this amount instead.
  misreportSucceededAmount: number | null = null;

  get acceptsPayments(): boolean {
    return process.env.NODE_ENV !== "production";
  }

  async createPaymentIntent(
    request: CreatePaymentIntentRequest,
  ): Promise<PaymentIntentResult> {
    this.createCalls += 1;
    if (process.env.NODE_ENV === "production") {
      return { status: "failed", reason: "Online payment is not available." };
    }
    if (this.failNext === "create") {
      this.failNext = null;
      throw new Error("simulated provider outage");
    }
    if (!Number.isInteger(request.amount) || request.amount <= 0) {
      return { status: "failed", reason: "Amount must be greater than zero." };
    }
    const existing = this.byKey.get(request.idempotencyKey);
    if (existing) return this.state(existing);
    const reference = `fakepi_${randomUUID()}`;
    this.byKey.set(request.idempotencyKey, reference);
    this.intents.set(reference, {
      status: "requires_customer_action",
      tenantId: request.account.tenantId,
      unknownOnce: false,
      amount: request.amount,
      currency: request.currency,
    });
    return { status: "requires_customer_action", reference };
  }

  async retrievePaymentIntent(input: {
    reference: string;
    account: PaymentAccountContext;
  }): Promise<PaymentIntentResult> {
    if (this.failNext === "retrieve") {
      this.failNext = null;
      throw new Error("simulated provider outage");
    }
    const intent = this.intents.get(input.reference);
    if (!intent || intent.tenantId !== input.account.tenantId) {
      return {
        status: "unknown",
        reason: "No such payment intent for this account.",
      };
    }
    if (intent.unknownOnce) {
      intent.unknownOnce = false;
      return { status: "unknown", reason: "Simulated unknown outcome." };
    }
    return this.state(input.reference);
  }

  charge(request: ChargeRequest): Promise<ChargeResult> {
    return this.oneStep.charge(request);
  }

  async clientSecretFor(): Promise<string | null> {
    return null;
  }

  async cancelPaymentIntent(input: {
    reference: string;
    account: PaymentAccountContext;
  }): Promise<PaymentIntentResult> {
    const intent = this.intents.get(input.reference);
    if (!intent || intent.tenantId !== input.account.tenantId) {
      return {
        status: "unknown",
        reason: "No such payment intent for this account.",
      };
    }
    if (intent.status !== "succeeded" && intent.status !== "processing") {
      intent.status = "canceled";
    }
    return this.state(input.reference);
  }

  // The development simulator: what the customer's confirmation did. A
  // succeeded or cancelled intent never changes, exactly as at a real
  // processor. False when the intent is unknown, another business's, or
  // already final.
  simulate(
    reference: string,
    tenantId: string,
    outcome: SimulatedPaymentOutcome,
  ): boolean {
    const intent = this.intents.get(reference);
    if (!intent || intent.tenantId !== tenantId) return false;
    if (intent.status === "succeeded" || intent.status === "canceled") {
      return false;
    }
    if (outcome === "unknown") {
      intent.unknownOnce = true;
      return true;
    }
    intent.status =
      outcome === "succeed"
        ? "succeeded"
        : outcome === "decline"
          ? "requires_payment_method"
          : outcome === "process"
            ? "processing"
            : "canceled";
    return true;
  }

  private state(reference: string): PaymentIntentResult {
    const intent = this.intents.get(reference)!;
    if (intent.status === "succeeded") {
      return {
        status: "succeeded",
        reference,
        amount: this.misreportSucceededAmount ?? intent.amount,
        currency: intent.currency,
      };
    }
    return { status: intent.status, reference };
  }
}
