import type { BusinessBillingSummary } from "@mocha-house/contracts";
import {
  BILLING_MESSAGES,
  billingNotice,
  billingStateDescription,
  PAYMENT_SETUP_EXPIRED_MESSAGE,
  paymentSetupNotice,
  isWindDownPath,
  WIND_DOWN_NAV_KEYS,
  windDownMessage,
  checkoutRefusalMessage,
  checkoutReturn,
  initialSetupDisclosure,
  INITIAL_SETUP_PENDING_MESSAGE,
  SELECTION_UNAVAILABLE_MESSAGE,
  isAllowedCheckoutUrl,
  isAllowedRecoveryUrl,
  portalReturn,
} from "./billing";
import { adminNavItems, groupAdminNavItems } from "./nav";

// SC3b — the business's own billing screen: only the provider's hosted
// Checkout is ever redirected to, refusals never show server details, and
// the owner always understands the state (nothing charged unless agreed).
const summary = (over: Partial<BusinessBillingSummary> = {}): BusinessBillingSummary => ({
  state: "AWAITING_SETUP",
  planName: "Growth",
  price: { amountMinorUnits: 4900, currency: "USD", interval: "MONTH" },
  trialEndsAt: null,
  currentPeriodEnd: null,
  graceEndsAt: null,
  recoveryEndsAt: null,
  graceExceptionEndsAt: null,
  enforced: false,
  premiumPaused: false,
  suspendedForBilling: false,
  cancelAtPeriodEnd: false,
  paymentMethodOnFile: false,
  initialSetupPending: false,
  paymentSetup: { required: true, since: "2026-10-01T00:00:00.000Z", deadline: null, expired: false },
  ...over,
});

describe("admin billing", () => {
  it("redirects only to the provider's hosted Checkout (the fake page only outside production)", () => {
    expect(isAllowedCheckoutUrl("https://checkout.stripe.com/c/pay/cs_test_1")).toBe(true);
    expect(isAllowedCheckoutUrl("https://checkout.fake.test/fake_cs_1", { NODE_ENV: "test" })).toBe(true);
    for (const bad of [
      "https://checkout.fake.test/x",
      "http://checkout.stripe.com/c/pay/x",
      "https://checkout.stripe.com.evil.test/x",
      "https://user:pass@checkout.stripe.com/x",
      "javascript:alert(1)",
      "/admin",
      42,
      null,
    ]) {
      expect(isAllowedCheckoutUrl(bad, { NODE_ENV: "production" })).toBe(false);
    }
  });

  it("maps every refusal to a plain message (never a server detail)", () => {
    expect(checkoutRefusalMessage(409, { code: "BILLING_CHECKOUT_PROCESSING", message: "internal" })).toBe(
      BILLING_MESSAGES.processing,
    );
    expect(checkoutRefusalMessage(409, { code: "BILLING_ALREADY_SET_UP" })).toBe(BILLING_MESSAGES.alreadySetUp);
    expect(checkoutRefusalMessage(409, { code: "BILLING_TRIAL_PENDING_ELSEWHERE" })).toBe(
      BILLING_MESSAGES.trialPendingElsewhere,
    );
    expect(checkoutRefusalMessage(403, null)).toBe(BILLING_MESSAGES.forbidden);
    expect(checkoutRefusalMessage(429, null)).toBe(BILLING_MESSAGES.tooMany);
    expect(checkoutRefusalMessage(401, null)).toBe(BILLING_MESSAGES.sessionEnded);
    expect(checkoutRefusalMessage(503, { message: "stripe said something" })).toBe(BILLING_MESSAGES.unavailable);
    expect(checkoutRefusalMessage(null, null)).toBe(BILLING_MESSAGES.unavailable);
  });

  it("explains each state, including that a cardless trial is never charged", () => {
    expect(billingStateDescription(summary({ state: "TRIALING" }))).toMatch(/Nothing is charged/);
    expect(billingStateDescription(summary({ state: "TRIALING", paymentMethodOnFile: true }))).toMatch(/charged when it ends/);
    expect(billingStateDescription(summary({ state: "TRIAL_EXPIRED" }))).toMatch(/Nothing was charged/);
    expect(billingStateDescription(summary({ state: "COMPLIMENTARY", price: null }))).toMatch(/nothing to pay/);
  });

  it("reads only known Checkout return markers", () => {
    expect(checkoutReturn("success")).toBe("success");
    expect(checkoutReturn("cancelled")).toBe("cancelled");
    expect(checkoutReturn("<script>")).toBeNull();
    expect(checkoutReturn(undefined)).toBeNull();
  });

  it("shows Billing in the admin navigation only with billing.view, next to Administration", () => {
    const withBilling = adminNavItems({ "billing.view": { corporate: true, locationIds: [] } } as never);
    expect(withBilling.map((item) => item.key)).toContain("billing");
    const footer = groupAdminNavItems(withBilling).find((group) => group.tier === "footer");
    expect(footer?.items.map((item) => item.key)).toEqual(["billing"]);
    expect(adminNavItems({}).map((item) => item.key)).not.toContain("billing");
  });
});

describe("SC3c-1 billing enforcement (web)", () => {
  it("an expired trial says premium is off and until when the business stays open — and never that anything was charged", () => {
    const inWindow = summary({
      state: "TRIAL_EXPIRED",
      recoveryEndsAt: "2026-11-03T12:00:00.000Z",
      enforced: true,
      premiumPaused: true,
    });
    expect(billingStateDescription(inWindow)).toMatch(/Nothing was charged/);
    expect(billingStateDescription(inWindow)).toMatch(/Premium features are off/);
    expect(billingStateDescription(inWindow)).toMatch(/November 3, 2026 at 12:00 PM UTC/);
    expect(billingNotice(inWindow)).toMatch(/premium features are off/);
    const after = summary({
      state: "TRIAL_EXPIRED",
      enforced: true,
      premiumPaused: true,
      suspendedForBilling: true,
    });
    expect(billingStateDescription(after)).toMatch(/paused until payment is set up/);
    expect(billingNotice(after)).toBeNull();
    // Enforcement off (or a trial that expired before it): no claim that
    // anything is off or paused.
    const off = summary({ state: "TRIAL_EXPIRED", recoveryEndsAt: "2026-11-03T12:00:00.000Z" });
    expect(billingStateDescription(off)).toBe("Your free trial ended without a payment method. Nothing was charged.");
    expect(billingNotice(off)).toBeNull();
  });

  it("a failed payment in grace gets a notice with its date; good standing gets none", () => {
    expect(
      billingNotice(summary({ state: "PAST_DUE", graceEndsAt: "2026-11-10T12:00:00.000Z", enforced: true })),
    ).toMatch(/keeps working until November 10, 2026 at 12:00 PM UTC/);
    expect(billingNotice(summary({ state: "PAST_DUE", graceEndsAt: "2026-11-10T12:00:00.000Z" }))).toBeNull();
    for (const state of ["ACTIVE", "TRIALING", "COMPLIMENTARY", "AWAITING_SETUP"] as const) {
      expect(billingNotice(summary({ state }))).toBeNull();
    }
  });

  it("the wind-down message only offers what this person can reach", () => {
    expect(windDownMessage({ orders: true, billing: true })).toMatch(/complete orders .* and see and settle your billing/);
    expect(windDownMessage({ orders: true, billing: false })).not.toMatch(/settle your billing/);
    expect(windDownMessage({ orders: false, billing: true })).not.toMatch(/orders/);
    expect(windDownMessage({ orders: false, billing: false })).toMatch(/Ask a business owner or manager/);
  });

  it("the wind-down shows only orders and billing", () => {
    expect([...WIND_DOWN_NAV_KEYS].sort()).toEqual(["billing", "orders"]);
    for (const path of ["/admin/orders", "/admin/orders/abc", "/admin/billing", "/admin/billing/"]) {
      expect(isWindDownPath(path)).toBe(true);
    }
    for (const path of ["/admin", "/admin/gift-cards", "/admin/ordersx", "/admin/billingx", "/admin/administration"]) {
      expect(isWindDownPath(path)).toBe(false);
    }
  });
});

describe("SC3c-2 billing recovery (web)", () => {
  it("redirects only to the provider's own invoice and portal pages", () => {
    expect(isAllowedRecoveryUrl("https://invoice.stripe.com/i/acct_1/test_1", "invoice")).toBe(true);
    expect(isAllowedRecoveryUrl("https://billing.stripe.com/p/session/test_1", "portal")).toBe(true);
    for (const [bad, kind] of [
      ["https://billing.stripe.com/p/session/test_1", "invoice"],
      ["https://invoice.stripe.com/i/acct_1/test_1", "portal"],
      ["http://invoice.stripe.com/i/1", "invoice"],
      ["https://user:pw@invoice.stripe.com/i/1", "invoice"],
      ["https://invoice.stripe.com.evil.example/i/1", "invoice"],
      ["https://evil.example/pay", "invoice"],
      ["javascript:alert(1)", "portal"],
      [null, "portal"],
    ] as const) {
      expect(isAllowedRecoveryUrl(bad, kind)).toBe(false);
    }
    // The fake provider's pages: never in production.
    expect(isAllowedRecoveryUrl("https://invoice.fake.test/i/1", "invoice", { NODE_ENV: "test" })).toBe(true);
    expect(isAllowedRecoveryUrl("https://invoice.fake.test/i/1", "invoice", { NODE_ENV: "production" })).toBe(false);
  });

  it("recovery refusals are plain messages", () => {
    expect(checkoutRefusalMessage(409, { code: "BILLING_NOTHING_TO_PAY" })).toBe(BILLING_MESSAGES.nothingToPay);
    expect(checkoutRefusalMessage(409, { code: "BILLING_SUBSCRIPTION_NOT_ENDED" })).toBe(
      BILLING_MESSAGES.subscriptionNotEnded,
    );
    expect(portalReturn("returned")).toBe(true);
    expect(portalReturn("x")).toBe(false);
  });
});

// SC3c-3 — an operator's temporary grace exception, told plainly: still
// unpaid, temporary, until when.
describe("SC3c-3 grace exception wording", () => {
  it("states temporary access while unpaid, never that it is paid", () => {
    const exception = summary({
      state: "UNPAID",
      enforced: true,
      graceExceptionEndsAt: "2026-11-05T12:00:00Z",
    });
    expect(billingStateDescription(exception)).toMatch(/unpaid\. You have temporary access until/);
    expect(billingNotice(exception)).toMatch(/still unpaid.*temporary access until/);
    expect(billingStateDescription(summary({ state: "UNPAID" }))).toMatch(/outstanding invoices need paying/);
    expect(billingNotice(summary({ state: "UNPAID", enforced: true }))).toBeNull();
    // Already paused for billing: no temporary-access claim.
    expect(
      billingNotice({ ...exception, suspendedForBilling: true }),
    ).toBeNull();
  });
});

// SC3e-4 — payment setup: a deadline only when enforcement applies one; after
// it, plain recovery guidance.
describe("payment setup notices", () => {
  it("shows no deadline while none applies, the deadline when set, and recovery guidance after it", () => {
    expect(paymentSetupNotice(summary())).toBeNull();
    expect(billingNotice(summary())).toBeNull();
    // Never a deadline while enforcement doesn't apply it.
    expect(
      paymentSetupNotice(summary({ paymentSetup: { required: true, since: null, deadline: "2026-11-01T12:00:00.000Z", expired: false } })),
    ).toBeNull();
    const due = summary({ enforced: true, paymentSetup: { required: true, since: null, deadline: "2026-11-01T12:00:00.000Z", expired: false } });
    expect(paymentSetupNotice(due)).toMatch(/^Set up payment by November 1, 2026 at 12:00 PM UTC./);
    expect(billingNotice(due)).toBe(paymentSetupNotice(due));
    const expired = summary({
      state: "PAST_DUE",
      suspendedForBilling: true,
      paymentSetup: { required: false, since: null, deadline: null, expired: true },
    });
    expect(billingNotice(expired)).toBe(PAYMENT_SETUP_EXPIRED_MESSAGE);
    expect(PAYMENT_SETUP_EXPIRED_MESSAGE).toMatch(/restored as soon as your payment is confirmed/);
  });
});

// SC4c — the first payment setup: what is charged, and when.
describe("first payment setup disclosure", () => {
  const monthly = { amountMinorUnits: 4900, currency: "USD", interval: "MONTH" as const };

  it("states the trial length, that a card is required, and when the price is charged", () => {
    const text = initialSetupDisclosure({ days: 14, requiresPaymentMethod: true }, monthly);
    expect(text).toMatch(/14-day free trial starts when you finish payment setup/);
    expect(text).toMatch(/A card is required/);
    expect(text).toMatch(/\$49\.00 per month is charged automatically until you cancel/);
  });

  it("states a no-card trial and an immediate charge without a trial", () => {
    expect(initialSetupDisclosure({ days: 7, requiresPaymentMethod: false }, monthly)).toMatch(
      /No card is needed to start/,
    );
    expect(
      initialSetupDisclosure(null, { amountMinorUnits: 49000, currency: "USD", interval: "YEAR" }),
    ).toMatch(/\$490\.00 per year is charged right away and then automatically each year/);
  });

  it("explains a selection that is no longer offered and the pending state", () => {
    expect(checkoutRefusalMessage(409, { code: "BILLING_SELECTION_UNAVAILABLE" })).toBe(
      SELECTION_UNAVAILABLE_MESSAGE,
    );
    expect(INITIAL_SETUP_PENDING_MESSAGE).toMatch(/nothing is charged/);
  });
});
