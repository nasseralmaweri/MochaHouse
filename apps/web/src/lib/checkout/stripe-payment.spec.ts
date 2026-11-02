import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Stripe, StripeElements } from "@stripe/stripe-js";
import { checkCheckoutPaymentFromBrowser } from "@/lib/api-client";
import {
  confirmWithStripe,
  createSingleFlight,
  createStripeLoader,
  paymentReturnUrl,
  stripeAppearanceFrom,
  stripeContextOf,
  withoutPaymentReturnParams,
  type CheckoutPayment,
} from "./stripe-payment";

// ESP-04 M3b — the browser's side of a Stripe direct charge, with Stripe.js
// MOCKED (no network, no Stripe account). Covers: Stripe initialised only
// from the server's answer (publishable key, connected account, client
// secret) and never for a live key, another provider, a processing payment
// or anything malformed; one Stripe.js instance per connected account and a
// form per intent (never reused across businesses or checkouts);
// confirmPayment with redirect "if_required" and a same-origin return URL;
// a Stripe "success", a decline, a 3-D Secure redirect or an error all lead
// to the SERVER's check (never treated as paid, never shown as failed when
// uncertain); duplicate presses; the return URL's Stripe parameters removed;
// and the component's own guarantees (lazy Stripe.js, cards only, no
// storage or logging of the client secret).

const PK = `pk_test_${"TESTONLY".repeat(3)}`;
const ACCT = "acct_1M3bTest";
const SECRET = "pi_3M3bTest001_secret_TESTONLY";

const payment = (over: Partial<CheckoutPayment> = {}): CheckoutPayment => ({
  provider: "stripe",
  state: "REQUIRES_CUSTOMER_ACTION",
  clientSecret: SECRET,
  publishableKey: PK,
  connectedAccountId: ACCT,
  amountMinorUnits: 1250,
  currency: "USD",
  ...over,
});

describe("Stripe context from the server's answer", () => {
  it("uses exactly the publishable key, connected account and client secret the server gave", () => {
    expect(stripeContextOf(payment())).toEqual({
      publishableKey: PK,
      connectedAccountId: ACCT,
      clientSecret: SECRET,
      intentId: "pi_3M3bTest001",
      key: `${ACCT}:pi_3M3bTest001`,
    });
    // A refused card waits on the SAME intent: the same form.
    expect(
      stripeContextOf(payment({ state: "REQUIRES_PAYMENT_METHOD" }))?.key,
    ).toBe(`${ACCT}:pi_3M3bTest001`);
  });

  it.each<[string, Partial<CheckoutPayment>]>([
    ["the development fake", { provider: "fake-two-step", publishableKey: null, connectedAccountId: null, clientSecret: null }],
    ["a payment being processed (nothing to pay again)", { state: "PROCESSING", clientSecret: null }],
    ["a live publishable key", { publishableKey: `pk_live_${"X".repeat(24)}` }],
    ["a secret key in place of the publishable key", { publishableKey: `sk_test_${"X".repeat(24)}` }],
    ["no connected account", { connectedAccountId: null }],
    ["a malformed account", { connectedAccountId: "acct-1" }],
    ["no client secret", { clientSecret: null }],
    ["a malformed client secret", { clientSecret: "seti_1_secret_x" }],
  ])("refuses %s", (_label, over) => {
    expect(stripeContextOf(payment(over))).toBeNull();
  });
});

describe("Stripe.js instances", () => {
  const fakeStripe = (account: string) =>
    ({ account }) as unknown as Stripe;

  it("initialises Stripe.js with the connected account, once per account", async () => {
    const load = jest.fn((_key: string, options: { stripeAccount: string }) =>
      Promise.resolve(fakeStripe(options.stripeAccount)),
    );
    const stripeFor = createStripeLoader(load);
    const a = stripeContextOf(payment())!;
    const b = stripeContextOf(
      payment({
        connectedAccountId: "acct_1OtherBusiness",
        clientSecret: "pi_3Other001_secret_TESTONLY",
      }),
    )!;

    const first = await stripeFor(a);
    expect(await stripeFor(a)).toBe(first);
    const other = await stripeFor(b);
    expect(other).not.toBe(first);
    expect(load.mock.calls).toEqual([
      [PK, { stripeAccount: ACCT }],
      [PK, { stripeAccount: "acct_1OtherBusiness" }],
    ]);
    // Different businesses and intents never share a payment form.
    expect(a.key).not.toBe(b.key);
  });

  it("does not keep a failed load", async () => {
    const load = jest
      .fn()
      .mockRejectedValueOnce(new Error("blocked"))
      .mockResolvedValueOnce(fakeStripe(ACCT));
    const stripeFor = createStripeLoader(load);
    const context = stripeContextOf(payment())!;
    expect(await stripeFor(context)).toBeNull();
    expect(await stripeFor(context)).not.toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("confirming with Stripe (mocked)", () => {
  const elements = {} as StripeElements;
  const RETURN = paymentReturnUrl({ origin: "https://shop.example.test" });
  const stripeAnswering = (answer: unknown) => {
    const confirmPayment = jest.fn(() =>
      answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer),
    );
    return { stripe: { confirmPayment } as unknown as Pick<Stripe, "confirmPayment">, confirmPayment };
  };

  it("confirms on THIS page (redirect only if the bank needs it) with a same-origin return URL", async () => {
    const { stripe, confirmPayment } = stripeAnswering({
      paymentIntent: { status: "succeeded" },
    });
    await confirmWithStripe(stripe, elements, RETURN);
    expect(confirmPayment).toHaveBeenCalledWith({
      elements,
      confirmParams: { return_url: "https://shop.example.test/order/checkout?payment=return" },
      redirect: "if_required",
    });
  });

  it("a Stripe 'succeeded' is NOT proof of payment: the server is asked", async () => {
    const { stripe } = stripeAnswering({ paymentIntent: { status: "succeeded" } });
    expect(await confirmWithStripe(stripe, elements, RETURN)).toEqual({
      kind: "check",
      message: null,
    });
  });

  it("a declined card shows Stripe's message and still asks the server (retry on the same intent)", async () => {
    const { stripe } = stripeAnswering({
      error: { type: "card_error", message: "Your card was declined." },
    });
    expect(await confirmWithStripe(stripe, elements, RETURN)).toEqual({
      kind: "check",
      message: "Your card was declined.",
    });
  });

  it("an incomplete card form sends nothing and asks the customer to fix it", async () => {
    const { stripe } = stripeAnswering({
      error: { type: "validation_error", message: "Your card number is incomplete." },
    });
    expect(await confirmWithStripe(stripe, elements, RETURN)).toEqual({
      kind: "fix-form",
      message: "Your card number is incomplete.",
    });
  });

  it.each([
    ["an API error", { error: { type: "api_error", message: "Something went wrong" } }],
    ["a failed authentication", { error: { type: "invalid_request_error", code: "payment_intent_authentication_failure", message: "x" } }],
    ["a lost connection", new Error("network")],
  ])("%s is never shown as failed: the server is asked", async (_label, answer) => {
    const { stripe } = stripeAnswering(answer);
    expect(await confirmWithStripe(stripe, elements, RETURN)).toEqual({
      kind: "check",
      message: null,
    });
  });

  it("the check after confirming sends only the location (never an amount, account or intent)", async () => {
    const original = global.fetch;
    const fetchMock = jest.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ orderId: "o1" }), { status: 200 })),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    try {
      const result = await checkCheckoutPaymentFromBrowser("loc-1");
      expect(result.outcome).toBe("success");
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("/api/checkout/payment");
      expect(JSON.parse(init.body as string)).toEqual({ locationId: "loc-1" });
    } finally {
      global.fetch = original;
    }
  });
});

describe("one Pay at a time", () => {
  it("ignores presses while a confirmation and its check are in flight", async () => {
    const flight = createSingleFlight();
    let release!: () => void;
    const task = jest.fn(
      () => new Promise<string>((resolve) => (release = () => resolve("done"))),
    );
    const first = flight.run(task);
    expect(flight.running).toBe(true);
    expect(await flight.run(task)).toBeUndefined();
    expect(await flight.run(task)).toBeUndefined();
    release();
    expect(await first).toBe("done");
    expect(task).toHaveBeenCalledTimes(1);
    // Free again once the server answered (a failure releases it too).
    await expect(
      flight.run(() => Promise.reject(new Error("x"))),
    ).rejects.toThrow("x");
    expect(flight.running).toBe(false);
  });
});

describe("returning from a bank authentication", () => {
  it("removes Stripe's parameters (the client secret among them), keeping everything else", () => {
    expect(
      withoutPaymentReturnParams(
        "https://shop.example.test/order/checkout?payment=return&payment_intent=pi_1&payment_intent_client_secret=pi_1_secret_x&redirect_status=succeeded&utm=a#top",
      ),
    ).toBe("/order/checkout?utm=a#top");
    expect(
      withoutPaymentReturnParams(
        "https://shop.example.test/order/checkout?payment_intent_client_secret=pi_1_secret_x",
      ),
    ).toBe("/order/checkout");
  });

  it("leaves a URL without them alone", () => {
    expect(
      withoutPaymentReturnParams("https://shop.example.test/order/checkout?utm=a"),
    ).toBeNull();
    expect(withoutPaymentReturnParams("not a url")).toBeNull();
  });

  it("the return URL is always this origin's checkout page", () => {
    expect(paymentReturnUrl({ origin: "https://brand.example.test" })).toBe(
      "https://brand.example.test/order/checkout?payment=return",
    );
  });
});

describe("the storefront's look", () => {
  it("passes the theme tokens to the Payment Element, skipping missing or odd values", () => {
    const tokens: Record<string, string> = {
      "--accent": " #7a3e1d ",
      "--surface-card": "#fffdf9",
      "--text-primary": "",
      "--status-error": "x".repeat(200),
    };
    expect(stripeAppearanceFrom((t) => tokens[t] ?? "")).toEqual({
      theme: "stripe",
      variables: { colorPrimary: "#7a3e1d", colorBackground: "#fffdf9" },
    });
  });
});

describe("the payment panel component (source guarantees)", () => {
  const source = readFileSync(
    join(__dirname, "../../components/checkout/StripePaymentPanel.tsx"),
    "utf8",
  );
  const page = readFileSync(
    join(__dirname, "../../app/order/checkout/page.tsx"),
    "utf8",
  );

  it("loads Stripe.js lazily (only when the panel is shown), from Stripe's own loader", () => {
    expect(source).toMatch(/from "@stripe\/stripe-js\/pure"/);
    expect(source).not.toMatch(/from "@stripe\/stripe-js";/);
  });

  it("offers cards only: no wallets", () => {
    expect(source).toMatch(/applePay: "never"/);
    expect(source).toMatch(/googlePay: "never"/);
  });

  it("keys the form by account and intent, and never stores or logs the client secret", () => {
    expect(source).toMatch(/key=\{context\.key\}/);
    for (const text of [source, page]) {
      expect(text).not.toMatch(/localStorage|sessionStorage|console\./);
    }
  });

  it("places no order from Stripe's answer: the page's server check decides", () => {
    expect(source).toMatch(/await onCheck\(\)/);
    expect(source).not.toMatch(/router\.push|confirmation/);
    // A check started before Stripe confirmed is waited for, then a fresh
    // one is made: what is shown is always the server's answer after it.
    expect(page).toMatch(/onCheck=\{checkPaymentAfterConfirm\}/);
    expect(page).toMatch(
      /async function checkPaymentAfterConfirm\(\) \{\s+while \(checkInFlightRef\.current\)/,
    );
  });

  it("pauses the page's other payment actions while a card payment is being confirmed", () => {
    expect(page).toMatch(/onPayingChange=\{setCardPaying\}/);
    expect(page.match(/disabled=\{paymentBusy \|\| cardPaying\}/g)).toHaveLength(2);
    // ...and never leaves them paused if the form goes away mid-payment.
    expect(source).toMatch(/useEffect\(\(\) => \(\) => onPayingChange\(false\)/);
  });

  it("tells screen readers what the Pay button waits for and when the payment is processing", () => {
    expect(source).toMatch(/aria-describedby="card-payment-hint"/);
    expect(source).toMatch(/id="card-payment-hint"\s+role="status"/);
  });
});
