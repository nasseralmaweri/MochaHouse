import { markedFetch } from "./marked-fetch";
import { REQUEST_MARKER_HEADER } from "./request-origin";

describe("markedFetch", () => {
  const calls: Array<{ input: unknown; init?: RequestInit }> = [];
  const original = global.fetch;
  beforeEach(() => {
    calls.length = 0;
    global.fetch = jest.fn(async (input: unknown, init?: RequestInit) => {
      calls.push({ input, init });
      return new Response("{}");
    }) as unknown as typeof fetch;
  });
  afterAll(() => {
    global.fetch = original;
  });

  const markerOf = (i = 0) =>
    new Headers(calls[i].init?.headers).get(REQUEST_MARKER_HEADER);

  it("adds the marker on state-changing calls to our own /api routes", async () => {
    for (const method of ["POST", "PATCH", "PUT", "DELETE", "post"]) {
      await markedFetch("/api/checkout", { method });
    }
    for (let i = 0; i < 5; i += 1) expect(markerOf(i)).toBe("1");
  });

  it("keeps the caller's own headers and body", async () => {
    await markedFetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const h = new Headers(calls[0].init?.headers);
    expect(h.get("content-type")).toBe("application/json");
    expect(calls[0].init?.body).toBe("{}");
  });

  it("leaves safe methods alone", async () => {
    await markedFetch("/api/gift-cards/options", { cache: "no-store" });
    await markedFetch("/api/x", { method: "GET" });
    expect(calls[0].init?.headers).toBeUndefined();
    expect(markerOf(1)).toBeNull();
  });

  it("never sends the marker to another host or a non-/api URL", async () => {
    await markedFetch("https://evil.example/api/x", { method: "POST" });
    await markedFetch("//evil.example/api/x", { method: "POST" });
    await markedFetch("/elsewhere", { method: "POST" });
    await markedFetch(new URL("https://evil.example/api/x"), { method: "POST" });
    for (let i = 0; i < 4; i += 1) expect(markerOf(i)).toBeNull();
  });
});
