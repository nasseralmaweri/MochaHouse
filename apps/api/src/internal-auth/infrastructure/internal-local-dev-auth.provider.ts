import { Injectable } from '@nestjs/common';
import type { InternalSignInRequest } from '@mocha-house/contracts';
import { requireInternalEnv } from './require-internal-env';
import { signInternalDevJwt } from './internal-dev-jwt';
import type {
  InternalAuthProvider,
  InternalSignInOutcome,
} from '../application/internal-sign-in.types';

const TOKEN_TTL_SECONDS = 3600;

// DEV-ONLY / TEST SEAM — see internal-auth-provider-mode.ts for how this
// stays fail-closed in production. Deterministic stand-in for the internal
// Cognito pool: it performs NO password check (there is no local internal
// credential store) and mints an internal dev token for any identifier.
//
// This is deliberately not the security boundary. Signing in proves
// nothing about authorization — InternalAuthGuard independently resolves
// the identity to a Mocha House InternalUser and requires status ACTIVE on
// every protected request. The subject is derived from the identifier
// ("internal-dev:<identifier>") so it is stable across sign-ins and matches
// the seeded local ACTIVE internal user.
@Injectable()
export class InternalLocalDevAuthProvider implements InternalAuthProvider {
  signIn(request: InternalSignInRequest): Promise<InternalSignInOutcome> {
    const secret = requireInternalEnv('INTERNAL_AUTH_DEV_JWT_SECRET');
    const identifier = request.identifier.trim().toLowerCase();
    const looksLikeEmail = identifier.includes('@');

    const idToken = signInternalDevJwt(
      {
        sub: `internal-dev:${identifier}`,
        email: looksLikeEmail ? identifier : null,
        name: null,
      },
      secret,
      TOKEN_TTL_SECONDS,
    );

    return Promise.resolve({
      outcome: 'success',
      idToken,
      expiresInSeconds: TOKEN_TTL_SECONDS,
    });
  }
}
