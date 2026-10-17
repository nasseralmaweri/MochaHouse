import type { BillingInvoiceView } from "@mocha-house/contracts";
import { isAllowedInvoiceDocumentUrl } from "./billing";
import {
  BILLING_HISTORY_MESSAGES,
  documentRefusalMessage,
  invoiceAdjustmentLine,
  invoiceAmountLines,
  invoicePeriod,
  pageCursor,
  paymentMethodSentence,
} from "./billing-history";

// SC3e-1 — billing history wording: amounts as the provider reports them
// (refunds and credits shown, zero lines left out), safe card text only, an
// API-issued cursor only, and documents only on the provider's own hosts.
const invoice = (over: Partial<BillingInvoiceView> = {}): BillingInvoiceView => ({
  id: "i1",
  number: "ABC-0001",
  status: "paid",
  reason: "RENEWAL",
  currency: "USD",
  totalMinorUnits: 4900,
  amountPaidMinorUnits: 4900,
  amountRemainingMinorUnits: 0,
  refundedOrCreditedMinorUnits: 0,
  creditAppliedMinorUnits: 0,
  periodStart: "2026-10-01T00:00:00.000Z",
  periodEnd: "2026-11-01T00:00:00.000Z",
  issuedAt: "2026-10-01T00:00:00.000Z",
  paidAt: "2026-10-01T00:00:00.000Z",
  adjustments: [],
  ...over,
});

describe("SC3e-1 billing history wording", () => {
  it("shows the total and what was paid; zero lines are left out", () => {
    expect(invoiceAmountLines(invoice())).toEqual([
      { label: "Total", amount: "$49.00" },
      { label: "Paid", amount: "$49.00" },
    ]);
  });

  it("shows credits applied, what is still due, and refunds or credits after payment", () => {
    expect(
      invoiceAmountLines(
        invoice({
          status: "open",
          amountPaidMinorUnits: 0,
          amountRemainingMinorUnits: 4400,
          creditAppliedMinorUnits: 500,
        }),
      ),
    ).toEqual([
      { label: "Total", amount: "$49.00" },
      { label: "Credit applied", amount: "−$5.00" },
      { label: "Still due", amount: "$44.00" },
    ]);
    expect(invoiceAmountLines(invoice({ refundedOrCreditedMinorUnits: 1000 }))).toContainEqual({
      label: "Refunds and credits from our payment provider",
      amount: "$10.00",
    });
    // A cancelled invoice is never "still due".
    expect(
      invoiceAmountLines(invoice({ status: "void", amountRemainingMinorUnits: 4900, amountPaidMinorUnits: 0 })).map(
        (line) => line.label,
      ),
    ).toEqual(["Total"]);
  });

  it("dates the billed period in UTC", () => {
    expect(invoicePeriod(invoice())).toBe("Oct 1, 2026 – Nov 1, 2026");
    expect(invoicePeriod(invoice({ periodStart: null }))).toBeNull();
  });

  it("describes the card with brand, last four and expiry only", () => {
    expect(
      paymentMethodSentence({
        kind: "CARD",
        card: { brand: "visa", last4: "4242", expMonth: 3, expYear: 2030, expired: false },
      }),
    ).toBe("Visa ending in 4242, expires 03/2030");
    expect(
      paymentMethodSentence({
        kind: "CARD",
        card: { brand: "unknown_brand", last4: "0005", expMonth: 1, expYear: 2020, expired: true },
      }),
    ).toBe("Card ending in 0005, expired 01/2020");
    expect(paymentMethodSentence({ kind: "NONE", card: null })).toBe("No payment method on file.");
    expect(paymentMethodSentence({ kind: "OTHER", card: null })).toBe("A payment method is on file.");
  });

  it("passes back only a cursor shaped like the API's", () => {
    expect(pageCursor("eyJ0IjoiMjAyNiJ9")).toBe("eyJ0IjoiMjAyNiJ9");
    expect(pageCursor("../admin")).toBeNull();
    expect(pageCursor("a".repeat(201))).toBeNull();
    expect(pageCursor(["a"])).toBeNull();
    expect(pageCursor(undefined)).toBeNull();
  });

  it("explains a refused document in plain words", () => {
    expect(documentRefusalMessage(409, { code: "BILLING_DOCUMENT_UNAVAILABLE" })).toBe(
      BILLING_HISTORY_MESSAGES.noDocument,
    );
    expect(documentRefusalMessage(404, null)).toBe(BILLING_HISTORY_MESSAGES.notFound);
    expect(documentRefusalMessage(403, null)).toBe(BILLING_HISTORY_MESSAGES.forbidden);
    expect(documentRefusalMessage(503, { message: "provider detail" })).toBe(
      BILLING_HISTORY_MESSAGES.documentUnavailable,
    );
  });
});

describe("SC3e-1 invoice document links", () => {
  const prod = { NODE_ENV: "production" };
  it("allows only the provider's own invoice page and PDF hosts", () => {
    expect(isAllowedInvoiceDocumentUrl("https://invoice.stripe.com/i/acct_1/test_1", "invoice", prod)).toBe(true);
    expect(isAllowedInvoiceDocumentUrl("https://pay.stripe.com/invoice/acct_1/test_1/pdf", "pdf", prod)).toBe(true);
    // The wrong kind, path, host, scheme, port or credentials: refused.
    expect(isAllowedInvoiceDocumentUrl("https://pay.stripe.com/invoice/acct_1/test_1/pdf", "invoice", prod)).toBe(
      false,
    );
    expect(isAllowedInvoiceDocumentUrl("https://pay.stripe.com/elsewhere/x", "pdf", prod)).toBe(false);
    expect(isAllowedInvoiceDocumentUrl("https://pay.stripe.com.evil.test/invoice/x", "pdf", prod)).toBe(false);
    expect(isAllowedInvoiceDocumentUrl("http://pay.stripe.com/invoice/x", "pdf", prod)).toBe(false);
    expect(isAllowedInvoiceDocumentUrl("https://pay.stripe.com:8443/invoice/x", "pdf", prod)).toBe(false);
    expect(isAllowedInvoiceDocumentUrl("https://user:pw@pay.stripe.com/invoice/x", "pdf", prod)).toBe(false);
    expect(isAllowedInvoiceDocumentUrl("javascript:alert(1)", "pdf", prod)).toBe(false);
    expect(isAllowedInvoiceDocumentUrl(null, "pdf", prod)).toBe(false);
  });

  it("allows the fake provider's hosts only outside production", () => {
    expect(isAllowedInvoiceDocumentUrl("https://pay.fake.test/invoice/in_1/pdf", "pdf", { NODE_ENV: "test" })).toBe(
      true,
    );
    expect(isAllowedInvoiceDocumentUrl("https://pay.fake.test/invoice/in_1/pdf", "pdf", prod)).toBe(false);
  });
});

// SC3e-3 — the business sees its refunds and credits read-only: what, how
// much, and whether complete (never who requested or approved).
describe("SC3e-3 invoice refunds and credits (business view)", () => {
  it("describes a completed refund and a pending credit", () => {
    expect(
      invoiceAdjustmentLine({
        kind: "REFUND",
        status: "COMPLETED",
        currency: "USD",
        totalMinorUnits: 4900,
        at: "2026-10-05T12:00:00.000Z",
      }),
    ).toBe("Refund of $49.00 to your payment method · completed Oct 5, 2026");
    expect(
      invoiceAdjustmentLine({
        kind: "CREDIT",
        status: "PENDING",
        currency: "USD",
        totalMinorUnits: 1250,
        at: "2026-10-05T12:00:00.000Z",
      }),
    ).toBe("Credit of $12.50 toward future invoices · in progress");
  });
});
