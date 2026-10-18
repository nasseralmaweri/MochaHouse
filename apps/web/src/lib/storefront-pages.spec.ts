// SC4f-3b — restaurant-specific storefront pages: the profile the pages are
// built from, the wording helpers, the loyalty points name, and the cart's
// binding to the storefront's own business.

jest.mock("server-only", () => ({}));
const notFoundMock = jest.fn(() => {
  throw new Error("NOT_FOUND");
});
jest.mock("next/navigation", () => ({ notFound: () => notFoundMock() }));
jest.mock("next/headers", () => ({ headers: async () => new Headers() }));
jest.mock("next/server", () => ({ connection: async () => undefined }));

import {
  StorefrontUnavailableError,
  UNAVAILABLE_PROFILE,
  getStorefrontProfile,
  named,
  pageTitle,
  requireStorefrontProfile,
} from "./storefront-profile";
import { pointsCount, pointsLabelOrDefault, singularPoints } from "./loyalty-label";
import { CartLocationNotHereError, getLocationMenuFromBrowser } from "./api-client";

const fetchMock = jest.fn();
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const PROFILE = {
  businessName: "Bravo Cafe",
  orderingAvailable: true,
  loyaltyPointsLabel: "Stars",
  presentation: "standard" as const,
};

beforeEach(() => {
  process.env.API_URL = "http://api.test/api/v1";
  delete process.env.STOREFRONT_HOST_ROUTING_ENABLED;
  delete process.env.STOREFRONT_CONTEXT_SECRET;
  fetchMock.mockReset();
  notFoundMock.mockClear();
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe("storefront profile", () => {
  // getStorefrontProfile is React-cached per request; outside a request the
  // cache is per call, so each test sees its own answer.
  it("reads the resolved business's profile from the API", async () => {
    fetchMock.mockResolvedValueOnce(json(200, PROFILE));
    expect(await getStorefrontProfile()).toEqual({ state: "ok", profile: PROFILE });
    expect(fetchMock.mock.calls[0][0]).toBe("http://api.test/api/v1/storefront/profile");
  });

  it("turns an unknown or unpublished storefront into a 404 page", async () => {
    fetchMock.mockResolvedValueOnce(json(404, { code: "STOREFRONT_NOT_FOUND" }));
    await expect(requireStorefrontProfile()).rejects.toThrow("NOT_FOUND");
  });

  it("with routing off, an outage keeps the single business's legacy look, naming no one and offering no ordering", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("down"));
    expect(await requireStorefrontProfile()).toEqual(UNAVAILABLE_PROFILE);
    fetchMock.mockResolvedValueOnce(json(500, {}));
    expect(await requireStorefrontProfile()).toEqual(UNAVAILABLE_PROFILE);
    expect(UNAVAILABLE_PROFILE).toMatchObject({
      businessName: "",
      orderingAvailable: false,
      presentation: "legacy",
    });
  });

  it("with routing on, an outage guesses no presentation: the page fails to the error page", async () => {
    process.env.STOREFRONT_HOST_ROUTING_ENABLED = "1";
    process.env.STOREFRONT_CONTEXT_SECRET = "x".repeat(32);
    fetchMock.mockResolvedValueOnce(json(503, {}));
    await expect(requireStorefrontProfile()).rejects.toBeInstanceOf(StorefrontUnavailableError);
    // An unrelated 404 is an outage too, never a 404 page or a guess.
    fetchMock.mockResolvedValueOnce(json(404, { message: "Not Found" }));
    await expect(requireStorefrontProfile()).rejects.toBeInstanceOf(StorefrontUnavailableError);
    expect(notFoundMock).not.toHaveBeenCalled();
  });
});

describe("wording helpers", () => {
  it("names the business, or falls back to neutral wording", () => {
    expect(named(PROFILE, "Join {name} to track your orders.", "Create an account.")).toBe(
      "Join Bravo Cafe to track your orders.",
    );
    expect(named(UNAVAILABLE_PROFILE, "Join {name}.", "Create an account.")).toBe("Create an account.");
    expect(pageTitle(PROFILE, "Careers")).toBe("Careers · Bravo Cafe");
    expect(pageTitle(UNAVAILABLE_PROFILE, "Careers")).toBe("Careers");
    expect(pageTitle(PROFILE)).toBe("Bravo Cafe");
  });

  it("never shows Mocha House wording for another business", () => {
    const text = named(PROFILE, "Select a {name} location to start your order.", "Select a location.");
    expect(text).not.toMatch(/Mocha/);
  });
});

describe("loyalty points name", () => {
  it("uses the business's own plural name, with a singular for one unit", () => {
    expect(pointsLabelOrDefault(null)).toBe("Points");
    expect(pointsLabelOrDefault("  ")).toBe("Points");
    expect(pointsLabelOrDefault("Mocha Beans")).toBe("Mocha Beans");
    expect(singularPoints("Mocha Beans")).toBe("Mocha Bean");
    expect(singularPoints("Points")).toBe("Point");
    expect(singularPoints("Bonus")).toBe("Bonus");
    expect(singularPoints("Gold")).toBe("Gold");
    expect(singularPoints("Kudos")).toBe("Kudos");
    expect(singularPoints("Coins")).toBe("Coin");
    expect(pointsCount(1, "Stars")).toBe("1 Star");
    expect(pointsCount(1200, "Stars")).toBe("1,200 Stars");
  });
});

describe("cart binding", () => {
  it("reports a saved cart whose location is not this storefront's", async () => {
    fetchMock.mockResolvedValueOnce(json(404, { code: "LOCATION_NOT_IN_STOREFRONT" }));
    await expect(getLocationMenuFromBrowser("loc-from-elsewhere")).rejects.toBeInstanceOf(
      CartLocationNotHereError,
    );
  });

  it("keeps the cart on any other failure, including a 404 without that code", async () => {
    const others = [
      json(404, { message: "Not Found" }),
      json(404, { code: "STOREFRONT_NOT_FOUND" }),
      new Response("<html>404</html>", { status: 404 }),
      json(503, {}),
    ];
    for (const response of others) {
      fetchMock.mockResolvedValueOnce(response);
      await expect(getLocationMenuFromBrowser("loc")).rejects.not.toBeInstanceOf(
        CartLocationNotHereError,
      );
    }
  });
});
