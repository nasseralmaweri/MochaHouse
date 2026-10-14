import {
  REQUEST_MARKER_HEADER,
  checkRequestOrigin,
  parseAllowedOrigins,
  rejectUntrustedOrigin,
} from "./request-origin";

const OWN = "https://shop.example";

const headers = (values: Record<string, string>) => ({
  get: (name: string) => values[name.toLowerCase()] ?? null,
});

const mutation = (values: Record<string, string>, extra = {}) =>
  checkRequestOrigin({
    method: "POST",
    headers: headers({ [REQUEST_MARKER_HEADER]: "1", ...values }),
    ownOrigin: OWN,
    ...extra,
  });

describe("checkRequestOrigin", () => {
  it("accepts a same-origin browser fetch", () => {
    expect(
      mutation({ "sec-fetch-site": "same-origin", origin: OWN }),
    ).toEqual({ ok: true });
  });

  it("accepts Fetch Metadata alone, and Origin alone (older browsers)", () => {
    expect(mutation({ "sec-fetch-site": "same-origin" }).ok).toBe(true);
    expect(mutation({ origin: OWN }).ok).toBe(true);
  });

  it("accepts a user-initiated request (Sec-Fetch-Site: none)", () => {
    expect(mutation({ "sec-fetch-site": "none" }).ok).toBe(true);
  });

  it.each(["cross-site", "same-site", "Cross-Site", "bogus", ""])(
    "refuses Sec-Fetch-Site %p",
    (site) => {
      expect(mutation({ "sec-fetch-site": site, origin: OWN })).toEqual({
        ok: false,
        reason: "fetch-site",
      });
    },
  );

  it("refuses a sibling subdomain or other port even though it is same-site", () => {
    expect(
      mutation({ "sec-fetch-site": "same-site", origin: "https://evil.shop.example" }).ok,
    ).toBe(false);
    expect(mutation({ origin: "https://shop.example:8443" }).ok).toBe(false);
    expect(mutation({ origin: "http://shop.example" }).ok).toBe(false);
  });

  it.each([
    "https://evil.example",
    "null",
    "https://shop.example.evil.example",
    "https://evilshop.example",
    "",
  ])("refuses a forged or foreign Origin %p", (origin) => {
    expect(mutation({ origin }).ok).toBe(false);
  });

  it("refuses when a forged Origin accompanies a same-origin looking fetch site", () => {
    expect(
      mutation({ "sec-fetch-site": "same-origin", origin: "https://evil.example" }),
    ).toEqual({ ok: false, reason: "origin-mismatch" });
  });

  it("refuses a request carrying neither browser header", () => {
    expect(mutation({})).toEqual({ ok: false, reason: "no-browser-headers" });
  });

  it("refuses without the custom marker header, or with the wrong value", () => {
    const base = { "sec-fetch-site": "same-origin", origin: OWN };
    expect(
      checkRequestOrigin({ method: "POST", headers: headers(base), ownOrigin: OWN }),
    ).toEqual({ ok: false, reason: "missing-marker" });
    expect(
      checkRequestOrigin({
        method: "DELETE",
        headers: headers({ ...base, [REQUEST_MARKER_HEADER]: "0" }),
        ownOrigin: OWN,
      }).ok,
    ).toBe(false);
  });

  it("covers every state-changing method, case-insensitively", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "post", "Patch"]) {
      expect(
        checkRequestOrigin({
          method,
          headers: headers({ "sec-fetch-site": "cross-site" }),
          ownOrigin: OWN,
        }).ok,
      ).toBe(false);
    }
  });

  it("does not gate safe methods", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(
        checkRequestOrigin({
          method,
          headers: headers({ "sec-fetch-site": "cross-site" }),
          ownOrigin: OWN,
        }).ok,
      ).toBe(true);
    }
  });

  it("honours an explicitly allowed extra origin, and only that one", () => {
    const allowed = ["https://front.example"];
    expect(
      mutation({ origin: "https://front.example" }, { allowedOrigins: allowed }).ok,
    ).toBe(true);
    expect(
      mutation({ origin: "https://other.example" }, { allowedOrigins: allowed }).ok,
    ).toBe(false);
    // An allowed Origin does not rescue a cross-site Fetch Metadata value.
    expect(
      mutation(
        { origin: "https://front.example", "sec-fetch-site": "cross-site" },
        { allowedOrigins: allowed },
      ).ok,
    ).toBe(false);
  });

  it("is per-request-host: another tenant's own origin works without configuration", () => {
    expect(
      checkRequestOrigin({
        method: "POST",
        headers: headers({
          [REQUEST_MARKER_HEADER]: "1",
          origin: "https://tenant-b.example",
          "sec-fetch-site": "same-origin",
        }),
        ownOrigin: "https://tenant-b.example",
      }).ok,
    ).toBe(true);
  });
});

describe("parseAllowedOrigins", () => {
  it("normalises, ignores malformed and non-http entries", () => {
    expect(
      parseAllowedOrigins(
        " https://a.example/path , http://b.example:3000, not a url, javascript:alert(1), ,ftp://x.example",
      ),
    ).toEqual(["https://a.example", "http://b.example:3000"]);
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins("")).toEqual([]);
  });
});

describe("rejectUntrustedOrigin", () => {
  const request = (method: string, values: Record<string, string>) => ({
    method,
    headers: headers(values),
    nextUrl: { origin: OWN },
  });

  it("returns a generic 403 that does not name the failed check", async () => {
    const response = rejectUntrustedOrigin(
      request("POST", { "sec-fetch-site": "cross-site", [REQUEST_MARKER_HEADER]: "1" }),
      [],
    );
    expect(response?.status).toBe(403);
    expect(await response?.json()).toEqual({ message: "Request not allowed." });
    expect(response?.headers.get("cache-control")).toBe("no-store");
  });

  it("returns null to continue on a trusted request", () => {
    expect(
      rejectUntrustedOrigin(
        request("POST", {
          "sec-fetch-site": "same-origin",
          [REQUEST_MARKER_HEADER]: "1",
        }),
        [],
      ),
    ).toBeNull();
  });
});
