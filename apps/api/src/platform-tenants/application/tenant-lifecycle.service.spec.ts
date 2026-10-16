import { UnauthorizedException } from '@nestjs/common';
import { assertRecentSignIn } from './tenant-lifecycle.service';

// SC1e (L3) — a lifecycle change needs a sign-in within the last 15 minutes.
describe('recent sign-in check', () => {
  const now = Date.UTC(2026, 9, 16, 12, 0, 0);
  const identity = (secondsAgo: number | null) => ({
    provider: 'platform-dev' as const,
    subject: 'platform-dev:op',
    authenticatedAt: secondsAgo === null ? null : now / 1000 - secondsAgo,
  });

  it('passes for a sign-in up to 15 minutes ago', () => {
    // (-30: a little clock skew is tolerated.)
    for (const seconds of [-30, 0, 60, 15 * 60]) {
      expect(() => assertRecentSignIn(identity(seconds), now)).not.toThrow();
    }
  });

  it('refuses an older sign-in, an unknown sign-in time and a missing identity', () => {
    for (const value of [
      identity(15 * 60 + 1),
      identity(3600),
      identity(null),
      identity(-120), // in the future, beyond clock skew
      undefined,
    ]) {
      expect(() => assertRecentSignIn(value, now)).toThrow(
        UnauthorizedException,
      );
    }
    try {
      assertRecentSignIn(identity(null), now);
    } catch (error) {
      expect((error as UnauthorizedException).getResponse()).toMatchObject({
        code: 'REAUTHENTICATION_REQUIRED',
      });
    }
  });
});
