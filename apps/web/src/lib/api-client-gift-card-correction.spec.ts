import { correctGiftCardBalanceFromBrowser } from "./api-client";

// SC0.5d — the browser call behind the HQ gift-card correction form. A 409
// must surface the API's stable code (so the form can tell a spent key from
// any other conflict), and every failure is ONE request, never a retry: a
// lost response may already have been applied, so only the operator decides
// whether to submit again (with the same key).
describe("correctGiftCardBalanceFromBrowser", () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  const body = {
    deltaMinorUnits: 750,
    reason: "One-off",
    operationKey: "key-current-0001",
  };

  const respond = (status: number, payload: unknown, json = true) =>
    ({
      status,
      ok: status >= 200 && status < 300,
      json: json
        ? async () => payload
        : async () => {
            throw new SyntaxError("not json");
          },
    }) as unknown as Response;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("sends the operator's request, with its key, to the admin proxy once", async () => {
    fetchMock.mockResolvedValue(respond(201, { giftCard: {}, transactions: [] }));
    await correctGiftCardBalanceFromBrowser("gc-1", body);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/internal/admin/gift-cards/gc-1/corrections");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it("a key conflict carries the stable code and the server's message", async () => {
    fetchMock.mockResolvedValue(
      respond(409, {
        statusCode: 409,
        error: "Conflict",
        code: "GIFT_CARD_OPERATION_KEY_CONFLICT",
        message: "That operation key has already been used.",
      }),
    );
    expect(await correctGiftCardBalanceFromBrowser("gc-1", body)).toEqual({
      outcome: "conflict",
      code: "GIFT_CARD_OPERATION_KEY_CONFLICT",
      message: "That operation key has already been used.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a 409 without a code (or with a non-string code) is a plain conflict, as before", async () => {
    fetchMock.mockResolvedValueOnce(
      respond(409, { statusCode: 409, message: "Below $0.00." }),
    );
    expect(await correctGiftCardBalanceFromBrowser("gc-1", body)).toEqual({
      outcome: "conflict",
      message: "Below $0.00.",
    });
    fetchMock.mockResolvedValueOnce(
      respond(409, { message: "Odd.", code: 42 }),
    );
    expect(await correctGiftCardBalanceFromBrowser("gc-1", body)).toEqual({
      outcome: "conflict",
      message: "Odd.",
    });
    fetchMock.mockResolvedValueOnce(respond(409, null, false));
    expect(await correctGiftCardBalanceFromBrowser("gc-1", body)).toEqual({
      outcome: "conflict",
      message: "That isn't possible right now.",
    });
  });

  it.each([
    ["a network failure", () => Promise.reject(new TypeError("Failed to fetch"))],
    [
      "an aborted / timed-out request",
      () =>
        Promise.reject(
          Object.assign(new Error("The operation timed out."), {
            name: "TimeoutError",
          }),
        ),
    ],
  ])("%s is an error after exactly one request (no retry)", async (_l, fail) => {
    fetchMock.mockImplementation(fail);
    expect(await correctGiftCardBalanceFromBrowser("gc-1", body)).toEqual({
      outcome: "error",
      message: "Could not reach the server.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a 2xx whose body cannot be read is an error (outcome unknown), not a thrown rejection", async () => {
    fetchMock.mockResolvedValue(respond(201, null, false));
    expect(await correctGiftCardBalanceFromBrowser("gc-1", body)).toEqual({
      outcome: "error",
      message:
        "The server's answer could not be read. Check the gift card before trying again.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([500, 502, 504])(
    "a %i (outcome unknown) is an error after exactly one request (no retry)",
    async (status) => {
      fetchMock.mockResolvedValue(respond(status, null, false));
      const result = await correctGiftCardBalanceFromBrowser("gc-1", body);
      expect(result).toEqual({
        outcome: "error",
        message: `Something went wrong (${status}).`,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );
});
