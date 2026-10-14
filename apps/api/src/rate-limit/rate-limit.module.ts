import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { RateLimitEnforcer, RateLimitGuard } from './rate-limit.guard';
import { loadRateLimitConfig } from './rate-limit.config';
import { RATE_LIMIT_CONFIG, RateLimitService } from './rate-limit.service';

// Imported by each module whose controllers use @UseGuards(RateLimitGuard), so
// the dependency is explicit (a module that forgets it fails to start instead
// of silently running unprotected).
@Module({
  imports: [RedisModule],
  providers: [
    { provide: RATE_LIMIT_CONFIG, useFactory: () => loadRateLimitConfig() },
    RateLimitService,
    RateLimitEnforcer,
    RateLimitGuard,
  ],
  exports: [
    RATE_LIMIT_CONFIG,
    RateLimitService,
    RateLimitEnforcer,
    RateLimitGuard,
  ],
})
export class RateLimitModule {}
