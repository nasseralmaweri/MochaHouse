import { createHmac } from "node:crypto";
import { isIP } from "node:net";

// R1 / S3a — carrying the visitor's IP from the web server to the API.
//
// The web app's server actions and proxy routes call the API FROM the web
// server, so without help the API sees one client for every proxied visitor
// and cannot rate-limit per IP. This helper attaches the visitor's IP, SIGNED
// with a secret shared with the API (an HMAC-SHA256 over "<seconds>.<ip>"), so
// the API can trust it and a caller cannot invent it.
//
// It forwards NOTHING unless the deployment declares where the trustworthy IP
// comes from. Nothing here assumes a hosting platform:
//
//   CLIENT_IP_FORWARD_SECRET   shared secret (>= 32 chars) — must equal the
//                              API's CLIENT_IP_FORWARD_SECRET
//   CLIENT_IP_HEADER           the request header, set by YOUR edge/proxy, that
//                              holds the client IP (for example x-forwarded-for
//                              or a platform-specific header)
//   CLIENT_IP_TRUSTED_HOPS     how many of YOUR proxies append to that header
//                              (default 1). The client IP is the entry that
//                              many places from the END of a comma-separated
//                              list; entries before it are client-controlled
//                              and ignored.
//
// Server-only (it signs with a secret): never import it from client code.

const MIN_SECRET_LENGTH = 32;

export const CLIENT_IP_HEADER = "x-centerivo-client-ip";
export const CLIENT_IP_TIMESTAMP_HEADER = "x-centerivo-client-ts";
export const CLIENT_IP_SIGNATURE_HEADER = "x-centerivo-client-sig";

export function signClientIp(
  secret: string,
  ip: string,
  timestampSeconds: number,
): string {
  return createHmac("sha256", secret)
    .update(`${timestampSeconds}.${ip}`)
    .digest("hex");
}

// The client IP from a (possibly comma-separated) header value, counting
// `trustedHops` entries from the end, or null if it is not a real address or
// the list is shorter than the proxies you declared (which means the header is
// not what you configured — fail safe, forward nothing).
export function clientIpFromHeaderValue(
  value: string | null | undefined,
  trustedHops: number,
): string | null {
  if (!value) return null;
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (entries.length === 0 || trustedHops < 1) return null;
  const index = entries.length - trustedHops;
  if (index < 0) return null;
  const candidate = entries[index];
  return isIP(candidate) === 0 ? null : candidate;
}

interface HeaderSource {
  get(name: string): string | null;
}

export function signedClientIpHeaders(
  source: HeaderSource,
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now(),
): Record<string, string> {
  const secret = env.CLIENT_IP_FORWARD_SECRET?.trim() ?? "";
  const headerName = env.CLIENT_IP_HEADER?.trim().toLowerCase() ?? "";
  if (secret.length < MIN_SECRET_LENGTH || headerName === "") return {};

  const hopsRaw = env.CLIENT_IP_TRUSTED_HOPS?.trim();
  const hops = hopsRaw === undefined || hopsRaw === "" ? 1 : Number(hopsRaw);
  if (!Number.isInteger(hops) || hops < 1 || hops > 10) return {};

  const ip = clientIpFromHeaderValue(source.get(headerName), hops);
  if (ip === null) return {};

  const seconds = Math.floor(nowMs / 1000);
  return {
    [CLIENT_IP_HEADER]: ip,
    [CLIENT_IP_TIMESTAMP_HEADER]: String(seconds),
    [CLIENT_IP_SIGNATURE_HEADER]: signClientIp(secret, ip, seconds),
  };
}

// For server actions, which have no Request object: reads the incoming
// request's headers from Next.
export async function serverActionClientIpHeaders(): Promise<
  Record<string, string>
> {
  const { headers } = await import("next/headers");
  return signedClientIpHeaders(await headers());
}
