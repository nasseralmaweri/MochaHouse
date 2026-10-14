import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import {
  AuthConfigurationError,
  assertAuthConfigSafe,
} from './config/auth-startup-guard';
import {
  RateLimitConfigurationError,
  assertRateLimitConfigSafe,
} from './rate-limit/rate-limit.config';

async function bootstrap() {
  // ESP-02 — fail closed BEFORE anything is created or listening: no dev
  // authentication, dev secret or simulated payment outside a verified safe
  // development context. See config/auth-startup-guard.ts.
  assertAuthConfigSafe();
  // R1 / S3a — a malformed rate-limit setting, or rate limiting switched off
  // in a production-like environment, refuses to start (see
  // docs/security/public-api-rate-limiting.md).
  assertRateLimitConfigSafe();

  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Trusted reverse-proxy hop count for client-IP derivation (used by
  // GiftCardPublicThrottleGuard). Express `trust proxy`:
  //   0 (default)  → trust nobody: req.ip is the direct socket peer and any
  //                  client-sent X-Forwarded-For is ignored (spoof-proof).
  //   n            → trust the n hops closest to this server, so req.ip is
  //                  the real client when the API sits behind exactly n
  //                  proxies (e.g. 1 for a single load balancer).
  // We never set `true` (which would trust an arbitrary proxy chain).
  const trustedHops = Number.parseInt(
    process.env.TRUSTED_PROXY_HOP_COUNT ?? '',
    10,
  );
  app.set(
    'trust proxy',
    Number.isInteger(trustedHops) && trustedHops > 0 ? trustedHops : 0,
  );

  // The web app's cart page revalidates directly from the browser (it
  // reads localStorage, which only exists client-side), so this public,
  // unauthenticated read API must allow that cross-origin request.
  app.enableCors({
    origin: process.env.CORS_ORIGIN?.split(',') ?? 'http://localhost:3000',
  });

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap().catch((error: unknown) => {
  // A refused configuration prints its (secret-free) reasons and exits
  // non-zero; any other startup failure keeps its stack.
  console.error(
    error instanceof AuthConfigurationError ||
      error instanceof RateLimitConfigurationError
      ? error.message
      : error,
  );
  process.exit(1);
});
