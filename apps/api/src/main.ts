import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap() {
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
void bootstrap();
