import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Request } from 'express';
import { RedisService } from '../../redis/redis.service';

// Milestone 7H — a minimal, endpoint-specific throttle for the two PUBLIC
// stored-value endpoints only:
//   POST /api/v1/gift-cards/balance
//   POST /api/v1/gift-cards/purchase
// 20 requests / minute / client IP, counted in Redis with a fixed 60s
// window (INCR + EXPIRE). This is NOT a platform-wide rate-limiting
// framework — it is bound to this guard and these routes.
//
// FAIL-OPEN on any Redis error or outage: a transient Redis problem must
// never block a paid purchase or corrupt financial state. The real
// protection against duplicate financial effects is the purchase flow's
// PaymentAttempt.idempotencyKey + the DB uniqueness constraints, which are
// unaffected by the throttle. A Redis outage only removes the abuse
// dampener, not the correctness guarantees.

const LIMIT = 20;
const WINDOW_SECONDS = 60;

@Injectable()
export class GiftCardPublicThrottleGuard implements CanActivate {
  private readonly logger = new Logger(GiftCardPublicThrottleGuard.name);

  constructor(private readonly redis: RedisService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const ip = clientIp(request);
    const bucket = Math.floor(Date.now() / (WINDOW_SECONDS * 1000));
    const key = `gcpublic:rl:${ip}:${bucket}`;

    let count: number;
    try {
      const client = this.redis.getClient();
      count = await client.incr(key);
      if (count === 1) {
        await client.expire(key, WINDOW_SECONDS + 5);
      }
    } catch (error) {
      // Fail-open — see the class comment.
      this.logger.warn(
        `gift-card public throttle unavailable (Redis error); allowing request: ${
          error instanceof Error ? error.message : 'unknown'
        }`,
      );
      return true;
    }

    if (count > LIMIT) {
      throw new HttpException(
        'Too many requests. Please wait a minute and try again.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}

function clientIp(request: Request): string {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0]!.trim();
  }
  return request.ip ?? request.socket?.remoteAddress ?? 'unknown';
}
