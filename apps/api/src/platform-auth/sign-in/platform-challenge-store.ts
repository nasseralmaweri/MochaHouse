import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';

// SC1b — the server-side home of an operator's IN-PROGRESS sign-in (the step
// between "password accepted" and "MFA completed"). The browser only ever
// holds an opaque, random 256-bit handle (in an HttpOnly cookie set by the
// web tier); the Cognito challenge session, the username and any TOTP
// enrolment state stay here.
//
//   - Strict expiry: 180 s, Cognito's own challenge-session lifetime. A
//     longer TTL would only keep a dead session around.
//   - Single use: every step TAKES the record atomically (GETDEL). A step
//     that continues the flow stores a NEW record under a NEW handle, so a
//     replayed or stolen handle is useless once used, and a wrong MFA code
//     ends the attempt (the operator signs in again).
//   - Redis holds only a SHA-256 of the handle as the key, so a Redis dump
//     does not yield usable handles.
//   - Fails closed: if Redis is unavailable the error propagates and the
//     sign-in fails (no session is ever issued without a completed MFA step).

export const PLATFORM_CHALLENGE_TTL_SECONDS = 180;

export type PlatformChallengeKind = 'mfa' | 'mfa-setup';

export interface PlatformChallengeRecord {
  provider: 'cognito' | 'dev';
  kind: PlatformChallengeKind;
  // The sign-in name Cognito expects in ChallengeResponses (USERNAME).
  username: string;
  // Cognito's opaque challenge session; null for the dev provider.
  cognitoSession: string | null;
  // mfa-setup only: whether an authenticator secret has been issued for
  // this attempt (the verification step requires it).
  secretIssued: boolean;
  // mfa-setup only: the issued authenticator secret, kept HERE (server-side)
  // until enrolment completes or the attempt expires — never in a browser
  // cookie. Read by the setup page through a one-shot display call.
  secret?: string | null;
}

const HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

function keyFor(handle: string): string {
  return `platform:signin-challenge:v1:${createHash('sha256')
    .update(handle)
    .digest('hex')}`;
}

export function isChallengeHandle(value: unknown): value is string {
  return typeof value === 'string' && HANDLE_PATTERN.test(value);
}

@Injectable()
export class PlatformChallengeStore {
  constructor(private readonly redis: RedisService) {}

  async create(record: PlatformChallengeRecord): Promise<string> {
    const handle = randomBytes(32).toString('base64url');
    const stored = await this.redis
      .getClient()
      .set(
        keyFor(handle),
        JSON.stringify(record),
        'EX',
        PLATFORM_CHALLENGE_TTL_SECONDS,
        'NX',
      );
    if (stored !== 'OK') {
      throw new Error('Could not store the sign-in challenge.');
    }
    return handle;
  }

  // Reads WITHOUT consuming — only for showing an enrolment secret that has
  // already been issued for this exact attempt (it advances nothing).
  async peek(handle: string): Promise<PlatformChallengeRecord | null> {
    if (!isChallengeHandle(handle)) {
      return null;
    }
    const raw = await this.redis.getClient().get(keyFor(handle));
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw) as PlatformChallengeRecord;
    } catch {
      return null;
    }
  }

  // Atomically removes and returns the record, or null if it is unknown,
  // expired or already used.
  async take(handle: string): Promise<PlatformChallengeRecord | null> {
    if (!isChallengeHandle(handle)) {
      return null;
    }
    const raw = await this.redis.getClient().getdel(keyFor(handle));
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw) as PlatformChallengeRecord;
    } catch {
      return null;
    }
  }
}
