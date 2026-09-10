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

// Milestone 8C — a minimal, endpoint-specific throttle for the ONE public
// unauthenticated write in Careers:
//   POST /api/v1/careers/jobs/:jobId/applications
// ~5 submissions / minute / client IP, counted in Redis with a fixed 60s
// window (INCR + EXPIRE). Bound to this guard and this route only — NOT a
// platform rate-limiting framework. Mirrors GiftCardPublicThrottleGuard.
//
// FAIL-OPEN on any Redis error or outage: a transient Redis problem must
// never block a genuine applicant. Client IP is `request.ip` (Express
// derives it from the `trust proxy` hop count in main.ts — a raw
// X-Forwarded-For is never trusted).

const LIMIT = 5;
const WINDOW_SECONDS = 60;

@Injectable()
export class CareersPublicThrottleGuard implements CanActivate {
  private readonly logger = new Logger(CareersPublicThrottleGuard.name);

  constructor(private readonly redis: RedisService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const ip = request.ip ?? request.socket?.remoteAddress ?? 'unknown';
    const bucket = Math.floor(Date.now() / (WINDOW_SECONDS * 1000));
    const key = `careers:rl:${ip}:${bucket}`;

    let count: number;
    try {
      const client = this.redis.getClient();
      count = await client.incr(key);
      if (count === 1) {
        await client.expire(key, WINDOW_SECONDS + 5);
      }
    } catch (error) {
      this.logger.warn(
        `careers public throttle unavailable (Redis error); allowing request: ${
          error instanceof Error ? error.message : 'unknown'
        }`,
      );
      return true;
    }

    if (count > LIMIT) {
      throw new HttpException(
        'Too many application submissions. Please wait a minute and try again.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
