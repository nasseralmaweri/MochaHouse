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

export type ChargeResult =
  | { outcome: "succeeded"; providerReference: string }
  | { outcome: "declined"; reason: string }
  | { outcome: "failed"; reason: string };

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
