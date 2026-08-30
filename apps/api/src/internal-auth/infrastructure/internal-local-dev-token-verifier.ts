import { Injectable } from '@nestjs/common';
import { requireInternalEnv } from './require-internal-env';
import { verifyInternalDevJwt } from './internal-dev-jwt';
import type { InternalIdentity } from './internal-identity';

// DEV-ONLY / TEST SEAM — see internal-auth-provider-mode.ts for how this
// stays fail-closed in production. Verifies the locally-signed internal
// token minted by InternalLocalDevAuthProvider so local development and
// automated tests can exercise the full internal-auth boundary (guard ->
// verify -> resolve ACTIVE InternalUser) without a live internal Cognito
// user pool.
//
// Uses INTERNAL_AUTH_DEV_JWT_SECRET (never the customer AUTH_DEV_JWT_SECRET)
// and stamps `provider: 'internal-dev'`. A customer dev token cannot reach
// an InternalIdentity through here: it is signed with a different secret
// and carries no internal marker claim (see internal-dev-jwt.ts).
@Injectable()
export class InternalLocalDevTokenVerifier {
  // Returns a resolved/rejected promise rather than throwing synchronously,
  // so a verification failure surfaces the same way as
  // InternalCognitoTokenVerifier's — InternalAuthGuard awaits both
  // identically, and it can be exercised directly with `.rejects` in tests.
  verify(token: string): Promise<InternalIdentity> {
    try {
      const secret = requireInternalEnv('INTERNAL_AUTH_DEV_JWT_SECRET');
      const claims = verifyInternalDevJwt(token, secret);

      return Promise.resolve({
        provider: 'internal-dev',
        subject: claims.sub,
        email: claims.email,
        name: claims.name,
      });
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error('Invalid internal token.'),
      );
    }
  }
}
