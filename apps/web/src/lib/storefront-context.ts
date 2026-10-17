import "server-only";
import { createHmac } from "node:crypto";
import {
  STOREFRONT_HOST_HEADER,
  STOREFRONT_HOST_SIGNATURE_HEADER,
  STOREFRONT_HOST_TIMESTAMP_HEADER,
  normalizeStorefrontHost,
  storefrontContextMessage,
} from "@mocha-house/contracts";

// SC4f-1 — telling the API WHICH storefront a request is for.
//
// With STOREFRONT_HOST_ROUTING_ENABLED on (here and on the API), the API
// serves a storefront request only for a hostname it finds published in its
// approved hostname registry, and only when this web server SIGNED that
// hostname (HMAC-SHA256 with STOREFRONT_CONTEXT_SECRET over a versioned,
// timestamped message). The browser never talks to the storefront API
// directly and cannot sign, so it can never pick its business through an API
// header; a mismatched or unknown hostname is refused by the API, never
// served as some default business.
//
// The hostname is the one this request was addressed to:
//   * the Host header, by default;
//   * or, ONLY when the deployment names one, a header set by its own edge
//     proxy (STOREFRONT_FORWARDED_HOST_HEADER, e.g. x-forwarded-host), read
//     STOREFRONT_FORWARDED_HOST_TRUSTED_HOPS (default 1) entries from the end;
//     entries before that are client-controlled and ignored.
// A client that forges either one only reaches another PUBLISHED storefront —
// exactly what typing its address would do — and its cookies, which are
// host-only, still belong to the address the browser actually used.
//
// With routing off (the default) nothing here runs: no header is read or
// sent, and every page renders exactly as before SC4f.
//
// Server-only (it signs with a secret): never import it from client code.

const MIN_SECRET_LENGTH = 32;

interface HeaderSource {
  get(name: string): string | null;
}

export function storefrontHostRoutingEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const flag = env.STOREFRONT_HOST_ROUTING_ENABLED?.trim().toLowerCase() ?? "";
  return flag === "1" || flag === "true";
}

// The storefront hostname this request was addressed to, normalized, or null.
export function requestStorefrontHost(
  source: HeaderSource,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const forwarded =
    env.STOREFRONT_FORWARDED_HOST_HEADER?.trim().toLowerCase() ?? "";
  if (forwarded === "") {
    return normalizeStorefrontHost(source.get("host"));
  }
  const hopsRaw = env.STOREFRONT_FORWARDED_HOST_TRUSTED_HOPS?.trim();
  const hops = hopsRaw === undefined || hopsRaw === "" ? 1 : Number(hopsRaw);
  if (!Number.isInteger(hops) || hops < 1 || hops > 10) return null;
  const entries = (source.get(forwarded) ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  const index = entries.length - hops;
  if (index < 0) return null;
  return normalizeStorefrontHost(entries[index]);
}

export function signStorefrontContext(
  secret: string,
  hostname: string,
  seconds: number,
): string {
  return createHmac("sha256", secret)
    .update(storefrontContextMessage(hostname, seconds))
    .digest("hex");
}

// The signed storefront context for this request, or {} when routing is off.
// With routing on, a missing or short secret is a deployment error and
// throws; an unusable hostname sends no context, which the API refuses.
export function signedStorefrontHeaders(
  source: HeaderSource,
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now(),
): Record<string, string> {
  if (!storefrontHostRoutingEnabled(env)) return {};
  const secret = env.STOREFRONT_CONTEXT_SECRET ?? "";
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      "STOREFRONT_HOST_ROUTING_ENABLED is on but STOREFRONT_CONTEXT_SECRET is missing or shorter than 32 characters.",
    );
  }
  const hostname = requestStorefrontHost(source, env);
  if (hostname === null) return {};
  const seconds = Math.floor(nowMs / 1000);
  return {
    [STOREFRONT_HOST_HEADER]: hostname,
    [STOREFRONT_HOST_TIMESTAMP_HEADER]: String(seconds),
    [STOREFRONT_HOST_SIGNATURE_HEADER]: signStorefrontContext(
      secret,
      hostname,
      seconds,
    ),
  };
}

// fetch() for a storefront API call made by this web server (Server
// Components, Server Actions, route handlers). With routing on it adds the
// signed context of the incoming request and never caches: a response
// belongs to one business. With routing off it is plain fetch() — and does
// not even read the request headers, so rendering is unchanged.
export async function storefrontApiFetch(
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  if (!storefrontHostRoutingEnabled()) {
    return fetch(input, init);
  }
  const { headers: requestHeaders } = await import("next/headers");
  const headers = new Headers(init.headers);
  // Only this function states the storefront: never a caller.
  for (const name of [
    STOREFRONT_HOST_HEADER,
    STOREFRONT_HOST_TIMESTAMP_HEADER,
    STOREFRONT_HOST_SIGNATURE_HEADER,
  ]) {
    headers.delete(name);
  }
  for (const [name, value] of Object.entries(
    signedStorefrontHeaders(await requestHeaders()),
  )) {
    headers.set(name, value);
  }
  return fetch(input, { ...init, headers, cache: "no-store" });
}
