import {
  MAX_TRACKED_ORDERS,
  isValidAccessToken,
  isValidOrderId,
  parseGuestSession,
  serializeGuestSession,
  tokenForOrder,
  withGuestOrder,
} from "./guest-session";
import { cookieName } from "./cookies";

const TOKEN = "abcdefghijklmnopqrstuvwx";

describe("shape validation", () => {
  it.each(["a", "0198-abc_DEF", "x".repeat(64)])("accepts order id %p", (id) => {
    expect(isValidOrderId(id)).toBe(true);
  });
  it.each(["", "../x", "a/b", "a b", "x".repeat(65), "a;b", 5, null, undefined])(
    "rejects order id %p",
    (id) => {
      expect(isValidOrderId(id)).toBe(false);
    },
  );
  it.each([TOKEN, "A_-".repeat(10), "x".repeat(128)])("accepts token %p", (t) => {
    expect(isValidAccessToken(t)).toBe(true);
  });
  it.each(["short", "x".repeat(129), "has space in it......", "semi;colon;;;;;;;;;;", "", null, 12])(
    "rejects token %p",
    (t) => {
      expect(isValidAccessToken(t)).toBe(false);
    },
  );
});

describe("cookie value", () => {
  it("round-trips and looks up by order id only", () => {
    const orders = withGuestOrder([], "o1", TOKEN);
    const parsed = parseGuestSession(serializeGuestSession(orders));
    expect(tokenForOrder(parsed, "o1")).toBe(TOKEN);
    expect(tokenForOrder(parsed, "o2")).toBeNull();
    expect(tokenForOrder(parsed, "../o1")).toBeNull();
  });

  it("is newest-first, de-duplicated and capped", () => {
    let orders = withGuestOrder([], "o0", TOKEN);
    for (let i = 1; i <= MAX_TRACKED_ORDERS + 2; i += 1) {
      orders = withGuestOrder(orders, `o${i}`, TOKEN + i);
    }
    expect(orders).toHaveLength(MAX_TRACKED_ORDERS);
    expect(orders[0][0]).toBe(`o${MAX_TRACKED_ORDERS + 2}`);
    expect(tokenForOrder(orders, "o0")).toBeNull(); // oldest dropped
    const refreshed = withGuestOrder(orders, orders[2][0], "new" + TOKEN);
    expect(refreshed[0][0]).toBe(orders[2][0]);
    expect(refreshed).toHaveLength(MAX_TRACKED_ORDERS);
  });

  it("ignores garbage, wrong shapes, invalid entries and over-long lists", () => {
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    expect(parseGuestSession(undefined)).toEqual([]);
    expect(parseGuestSession("")).toEqual([]);
    expect(parseGuestSession("%%%")).toEqual([]);
    expect(parseGuestSession(enc({ o1: TOKEN }))).toEqual([]);
    expect(parseGuestSession(enc([["../x", TOKEN], ["o1", "short"], ["o2"], "x", null]))).toEqual([]);
    expect(parseGuestSession(enc([["o1", TOKEN], ["o1", TOKEN + "z"]]))).toEqual([["o1", TOKEN]]);
    const many = Array.from({ length: 30 }, (_, i) => [`o${i}`, TOKEN]);
    expect(parseGuestSession(enc(many))).toHaveLength(MAX_TRACKED_ORDERS);
  });

  it("refuses to store an invalid id or token", () => {
    expect(withGuestOrder([], "../x", TOKEN)).toEqual([]);
    expect(withGuestOrder([], "o1", "short")).toEqual([]);
  });
});

describe("cookie name", () => {
  it("is __Host- prefixed in production only", () => {
    const env = (NODE_ENV: string) => ({ NODE_ENV }) as unknown as NodeJS.ProcessEnv;
    expect(cookieName("mh_guest_orders", env("production"))).toBe("__Host-mh_guest_orders");
    expect(cookieName("mh_guest_orders", env("development"))).toBe("mh_guest_orders");
  });
});
