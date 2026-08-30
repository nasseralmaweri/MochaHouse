import type { LocationSummary } from "@mocha-house/contracts";
import {
  CORPORATE_LOCATION_VALUE,
  locationContextValue,
  resolveLocationContext,
} from "./location-context";

const loc = (id: string, name = id): LocationSummary => ({
  id,
  name,
  slug: id,
  isDigitalOrderingEnabled: true,
});

const A = loc("loc-a", "Alpha");
const B = loc("loc-b", "Bravo");

describe("resolveLocationContext", () => {
  it("single authorized location => auto-select it", () => {
    expect(
      resolveLocationContext({
        authorizedLocations: [A],
        isCorporate: false,
        urlLocationId: null,
        cookieLocationId: null,
      }),
    ).toEqual({ kind: "location", location: A });
  });

  it("multi-location non-corporate, no preference => first authorized location", () => {
    expect(
      resolveLocationContext({
        authorizedLocations: [A, B],
        isCorporate: false,
        urlLocationId: null,
        cookieLocationId: null,
      }),
    ).toEqual({ kind: "location", location: A });
  });

  it("corporate, no preference => corporate / all locations", () => {
    expect(
      resolveLocationContext({
        authorizedLocations: [A, B],
        isCorporate: true,
        urlLocationId: null,
        cookieLocationId: null,
      }),
    ).toEqual({ kind: "corporate" });
  });

  it("a valid cookie preference is used", () => {
    expect(
      resolveLocationContext({
        authorizedLocations: [A, B],
        isCorporate: false,
        urlLocationId: null,
        cookieLocationId: "loc-b",
      }),
    ).toEqual({ kind: "location", location: B });
  });

  it("a valid 'corporate' cookie is used for a corporate user", () => {
    expect(
      resolveLocationContext({
        authorizedLocations: [A, B],
        isCorporate: true,
        urlLocationId: null,
        cookieLocationId: CORPORATE_LOCATION_VALUE,
      }),
    ).toEqual({ kind: "corporate" });
  });

  it("a stale / unauthorized cookie is ignored, falling back safely", () => {
    expect(
      resolveLocationContext({
        authorizedLocations: [A, B],
        isCorporate: false,
        urlLocationId: null,
        cookieLocationId: "loc-gone",
      }),
    ).toEqual({ kind: "location", location: A });
  });

  it("a 'corporate' cookie for a NON-corporate user is ignored", () => {
    expect(
      resolveLocationContext({
        authorizedLocations: [A],
        isCorporate: false,
        urlLocationId: null,
        cookieLocationId: CORPORATE_LOCATION_VALUE,
      }),
    ).toEqual({ kind: "location", location: A });
  });

  it("an explicit valid ?location wins over the cookie", () => {
    expect(
      resolveLocationContext({
        authorizedLocations: [A, B],
        isCorporate: false,
        urlLocationId: "loc-b",
        cookieLocationId: "loc-a",
      }),
    ).toEqual({ kind: "location", location: B });
  });

  it("an explicit UNAUTHORIZED ?location produces a forbidden result (no silent switch)", () => {
    expect(
      resolveLocationContext({
        authorizedLocations: [A],
        isCorporate: false,
        urlLocationId: "loc-x",
        cookieLocationId: "loc-a",
      }),
    ).toEqual({ kind: "forbidden", requestedId: "loc-x" });
  });

  it("an explicit ?location=corporate for a non-corporate user is forbidden", () => {
    expect(
      resolveLocationContext({
        authorizedLocations: [A],
        isCorporate: false,
        urlLocationId: CORPORATE_LOCATION_VALUE,
        cookieLocationId: null,
      }),
    ).toEqual({ kind: "forbidden", requestedId: CORPORATE_LOCATION_VALUE });
  });

  it("no authorized locations and not corporate => none", () => {
    expect(
      resolveLocationContext({
        authorizedLocations: [],
        isCorporate: false,
        urlLocationId: null,
        cookieLocationId: null,
      }),
    ).toEqual({ kind: "none" });
  });
});

describe("locationContextValue", () => {
  it("maps each context kind to the <select> value", () => {
    expect(locationContextValue({ kind: "corporate" })).toBe(
      CORPORATE_LOCATION_VALUE,
    );
    expect(
      locationContextValue({ kind: "location", location: A }),
    ).toBe("loc-a");
    expect(
      locationContextValue({ kind: "forbidden", requestedId: "loc-x" }),
    ).toBe("loc-x");
    expect(locationContextValue({ kind: "none" })).toBe("");
  });
});
