import { NextRequest } from "next/server";
import { config, proxy } from "./proxy";

// ESP-04 M3b — a customer back from a Stripe bank authentication arrives at
// checkout with Stripe's parameters (the payment's client secret among them):
// the proxy removes them with a 303 before any page renders. Everything else
// about checkout, and the admin path forwarding, is unchanged.
describe("proxy", () => {
  const get = (url: string) => proxy(new NextRequest(url));

  it("runs for checkout as well as the admin pages", () => {
    expect(config.matcher).toEqual(["/admin", "/admin/:path*", "/order/checkout"]);
  });

  it("redirects a Stripe return to the same checkout page without Stripe's parameters", () => {
    const res = get(
      "https://brand.example.test/order/checkout?payment=return&payment_intent=pi_1&payment_intent_client_secret=pi_1_secret_x&redirect_status=succeeded&utm=a",
    );
    expect(res.status).toBe(303);
    const location = res.headers.get("location")!;
    expect(new URL(location).origin).toBe("https://brand.example.test");
    expect(new URL(location).pathname).toBe("/order/checkout");
    expect(location).not.toMatch(/secret|payment_intent|redirect_status|payment=/);
    expect(new URL(location).searchParams.get("utm")).toBe("a");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("lets an ordinary checkout request through", () => {
    const res = get("https://brand.example.test/order/checkout");
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("still forwards the admin path (and only that)", () => {
    const res = get("https://brand.example.test/admin/orders");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-request-x-admin-pathname")).toBe(
      "/admin/orders",
    );
  });
});
