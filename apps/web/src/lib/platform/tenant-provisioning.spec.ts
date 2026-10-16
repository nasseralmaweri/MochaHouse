import {
  PROVISION_MESSAGES,
  interpretProvision,
  isOperationKey,
  normaliseEmail,
  suggestSlug,
  validateProvision,
  type ProvisionValues,
} from "./tenant-provisioning";

// SC1d — the "Add a business" form: the API's rules checked up front, a
// suggested slug, and every API answer mapped to a message that never shows
// a server detail (only the API's own fixed 400 messages are shown).

const valid: ProvisionValues = {
  name: "Blue Bean Café",
  slug: "blue-bean",
  ownerEmail: " Owner@Example.com ",
  ownerEmailConfirm: "owner@example.COM",
  ownerDisplayName: "",
};

const created = {
  tenant: {
    id: "0192f0a1-2b3c-7d4e-8f50-123456789abc",
    slug: "blue-bean",
    name: "Blue Bean Café",
    status: "ACTIVE",
    createdAt: "2026-10-16T00:00:00.000Z",
  },
  owner: { email: "owner@example.com", displayName: null },
  replayed: false,
};

describe("add a business: validation", () => {
  it("accepts a valid business, comparing the two owner emails case-insensitively", () => {
    expect(validateProvision(valid)).toEqual({});
    expect(normaliseEmail("  A@B.Co ")).toBe("a@b.co");
  });

  it("flags each invalid field", () => {
    expect(
      validateProvision({
        name: "x",
        slug: "Bad Slug",
        ownerEmail: "nope",
        ownerEmailConfirm: "",
        ownerDisplayName: "x".repeat(121),
      }),
    ).toEqual({
      name: expect.any(String),
      slug: expect.any(String),
      ownerEmail: expect.any(String),
      ownerDisplayName: expect.any(String),
    });
    expect(
      validateProvision({ ...valid, ownerEmailConfirm: "other@example.com" }),
    ).toEqual({ ownerEmailConfirm: "The two email addresses do not match." });
  });

  it("suggests a valid slug from the business name", () => {
    expect(suggestSlug("Blue Bean Café & Co.")).toBe("blue-bean-cafe-co");
    expect(suggestSlug("  --Hello   World--  ")).toBe("hello-world");
    expect(suggestSlug("x".repeat(80))).toHaveLength(50);
    expect(suggestSlug(`${"a".repeat(49)} b`)).toBe("a".repeat(49));
  });

  it("only accepts a lowercase UUID as the operation key", () => {
    expect(isOperationKey(created.tenant.id)).toBe(true);
    for (const value of ["", "key", created.tenant.id.toUpperCase(), null, 7]) {
      expect(isOperationKey(value)).toBe(false);
    }
  });
});

describe("add a business: reading the API's answer", () => {
  it("201 and a 200 replay are both a created business", () => {
    expect(interpretProvision(201, created)).toEqual({ kind: "created", result: created });
    const replay = { ...created, replayed: true };
    expect(interpretProvision(200, replay)).toEqual({ kind: "created", result: replay });
    // A success status without a well-formed body is never "created".
    expect(interpretProvision(201, { tenant: {} }).kind).toBe("error");
  });

  it("a taken slug is a slug field error; a reused key asks for a reload", () => {
    expect(interpretProvision(409, { code: "SLUG_TAKEN" })).toEqual({
      kind: "field",
      field: "slug",
      message: PROVISION_MESSAGES.slugTaken,
    });
    expect(interpretProvision(409, { code: "IDEMPOTENCY_KEY_REUSED" })).toEqual({
      kind: "error",
      message: PROVISION_MESSAGES.keyReused,
    });
  });

  it("session, permission, throttling and server failures map to fixed messages", () => {
    expect(interpretProvision(401, {})).toEqual({ kind: "error", message: PROVISION_MESSAGES.sessionEnded });
    expect(interpretProvision(403, {})).toEqual({ kind: "error", message: PROVISION_MESSAGES.denied });
    expect(interpretProvision(429, {})).toEqual({ kind: "error", message: PROVISION_MESSAGES.tooMany });
    for (const status of [500, 502, 503, null]) {
      expect(
        interpretProvision(status, { message: "PrismaClientKnownRequestError: …" }),
      ).toEqual({ kind: "error", message: PROVISION_MESSAGES.unavailable });
    }
  });

  it("a 400 shows the API's own validation message, bounded", () => {
    expect(interpretProvision(400, { message: "That slug is reserved." })).toEqual({
      kind: "error",
      message: "That slug is reserved.",
    });
    expect(interpretProvision(400, null)).toEqual({ kind: "error", message: PROVISION_MESSAGES.invalid });
    const long = interpretProvision(400, { message: "x".repeat(500) });
    expect(long.kind === "error" && long.message.length).toBe(200);
  });
});
