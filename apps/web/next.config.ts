import type { NextConfig } from "next";

// Milestone 8F — next/image needs an explicit allowlist of remote image
// hosts. We derive exactly ONE remote pattern from the configured public
// media host (the same host the API resolves MediaAsset URLs against) —
// never a broad/arbitrary-domain allowance. If the env var is unset
// (local dev with no media configured yet), no remote pattern is added and
// next/image simply isn't used for a remote media URL until it's set.
function mediaImageRemotePatterns(): NonNullable<NextConfig["images"]>["remotePatterns"] {
  const base = process.env.MEDIA_PUBLIC_BASE_URL ?? process.env.NEXT_PUBLIC_MEDIA_PUBLIC_BASE_URL;
  if (!base) {
    return [];
  }
  try {
    const url = new URL(base);
    return [
      {
        protocol: url.protocol.replace(":", "") as "http" | "https",
        hostname: url.hostname,
        port: url.port || undefined,
        pathname: `${url.pathname.replace(/\/$/, "")}/**`,
      },
    ];
  } catch {
    return [];
  }
}

const nextConfig: NextConfig = {
  images: {
    remotePatterns: mediaImageRemotePatterns(),
    // Next's image optimizer refuses to fetch a hostname that resolves to
    // a private/loopback IP (SSRF protection) — which "localhost" always
    // does. The LOCAL/dev-test MediaStorage's default MEDIA_PUBLIC_BASE_URL
    // is this app's own localhost API, so that protection would block
    // every locally-uploaded image in dev. It is safe to relax ONLY
    // outside production, where the real media host is always a genuine
    // external domain (a CDN or bucket), never localhost.
    dangerouslyAllowLocalIP: process.env.NODE_ENV !== "production",
  },
};

export default nextConfig;
