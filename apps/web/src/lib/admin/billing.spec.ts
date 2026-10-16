import type { BusinessBillingSummary } from "@mocha-house/contracts";
import {
  BILLING_MESSAGES,
  billingStateDescription,
  checkoutRefusalMessage,
  checkoutReturn,
  isAllowedCheckoutUrl,
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
  cancelAtPeriodEnd: false,
  paymentMethodOnFile: false,
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
