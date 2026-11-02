import { NextRequest, NextResponse } from "next/server";
import {
  CHECKOUT_SESSION_INVALID,
  PAYMENT_SIMULATION_NOT_AVAILABLE,
  SIMULATED_PAYMENT_OUTCOMES,
} from "@mocha-house/contracts";
import { rejectUntrustedOrigin } from "@/lib/security/request-origin";
import {
  forwardCheckoutPayment,
  readPaymentRequest,
} from "@/lib/checkout/payment-proxy";

// ESP-04 M2 — DEVELOPMENT ONLY: the payment simulator for the two-step fake
// provider (what a real payment page would do). Never in a production build;
// the API refuses it too unless the fake is configured in a non-production
// environment. It names only an outcome — never an amount, a payment or an
// account — and records nothing: the page then checks the payment, and the
// API reads the outcome back from the provider.
// The same production-like classifier as the API (packages/database
// runtime-environment.ts productionSignal): NODE_ENV or any deployment
// variable naming production, prod, staging or live.
const PRODUCTION_ENV_VARS = [
  "NODE_ENV",
  "CENTERIVO_ENV",
  "APP_ENV",
  "DEPLOYMENT_ENV",
  "ENVIRONMENT",
];
const PRODUCTION_VALUES = new Set(["production", "prod", "staging", "live"]);
function isProductionLike(env: NodeJS.ProcessEnv): boolean {
  return PRODUCTION_ENV_VARS.some((name) => {
    const value = env[name]?.trim().toLowerCase();
    return value !== undefined && PRODUCTION_VALUES.has(value);
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (isProductionLike(process.env)) {
    return NextResponse.json(
      {
        code: PAYMENT_SIMULATION_NOT_AVAILABLE,
        message: "The payment simulator is not available.",
      },
      { status: 404 },
    );
  }
  const untrusted = rejectUntrustedOrigin(request);
  if (untrusted) return untrusted as NextResponse;

  const read = await readPaymentRequest(request);
  if (
    !read ||
    typeof read.body.outcome !== "string" ||
    !(SIMULATED_PAYMENT_OUTCOMES as readonly string[]).includes(
      read.body.outcome,
    )
  ) {
    return NextResponse.json(
      { message: "A location and an outcome are required." },
      { status: 400 },
    );
  }
  if (!read.checkoutToken) {
    return NextResponse.json(
      {
        code: CHECKOUT_SESSION_INVALID,
        message:
          "Your checkout needs to be refreshed. Refresh the page to continue.",
      },
      { status: 409 },
    );
  }
  const forwarded = await forwardCheckoutPayment(
    request,
    "/orders/checkout-sessions/payment/simulate",
    {
      locationId: read.locationId,
      checkoutToken: read.checkoutToken,
      outcome: read.body.outcome,
    },
  );
  if (!forwarded) {
    return NextResponse.json(
      { message: "Could not reach the server." },
      { status: 503 },
    );
  }
  return new NextResponse(
    forwarded.response.status === 204 ? null : forwarded.text,
    {
      status: forwarded.response.status,
      headers: forwarded.headers,
    },
  );
}
