import { SetMetadata } from '@nestjs/common';
import type { PolicyName } from './rate-limit.config';

export const RATE_LIMIT_POLICY_KEY = 'centerivo:rate-limit-policy';

// Marks a route as protected by a named policy (see rate-limit.config.ts).
// Pair it with RateLimitGuard AFTER any authentication guard, so the verified
// customer identity (when there is one) is available to the policy.
export const RateLimit = (policy: PolicyName) =>
  SetMetadata(RATE_LIMIT_POLICY_KEY, policy);
