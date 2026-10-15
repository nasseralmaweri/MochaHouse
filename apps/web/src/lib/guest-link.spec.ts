import {
  buildShareUrl,
  extractLinkCredential,
  hasCredentialParams,
} from "./guest-link";

const TOKEN = "abcdefghijklmnopqrstuvwx";

describe("extractLinkCredential", () => {
  it("reads a shared #t= fragment link", () => {
    expect(extractLinkCredential("", `#t=${TOKEN}`)).toBe(TOKEN);
  });
  it("reads a legacy ?token= link", () => {
    expect(extractLinkCredential(`?token=${TOKEN}`, "")).toBe(TOKEN);
  });
  it("prefers the fragment, ignores other params", () => {
    expect(extractLinkCredential(`?token=other_token_value_xx`, `#t=${TOKEN}`)).toBe(TOKEN);
    expect(extractLinkCredential("?utm=1", "#section")).toBeNull();
  });
  it("returns null for a malformed credential", () => {
    expect(extractLinkCredential("?token=short", "")).toBeNull();
    expect(extractLinkCredential("", "#t=a b")).toBeNull();
    expect(extractLinkCredential("?token=", "#t=")).toBeNull();
  });
});

describe("hasCredentialParams", () => {
  it("flags any credential parameter so it is cleaned from history, valid or not", () => {
    expect(hasCredentialParams("?token=x", "")).toBe(true);
    expect(hasCredentialParams("", "#t=x")).toBe(true);
    expect(hasCredentialParams("?a=1", "#top")).toBe(false);
  });
});

describe("buildShareUrl", () => {
  it("puts the credential in the fragment, never the query", () => {
    const url = buildShareUrl("https://shop.example", "o 1", TOKEN);
    expect(url).toBe(`https://shop.example/order/confirmation/o%201#t=${TOKEN}`);
    expect(new URL(url).search).toBe("");
    expect(new URL(url).hash).toBe(`#t=${TOKEN}`);
  });
});
