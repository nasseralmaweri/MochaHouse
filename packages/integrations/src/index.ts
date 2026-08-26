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

  async charge(request: ChargeRequest): Promise<ChargeResult> {
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
