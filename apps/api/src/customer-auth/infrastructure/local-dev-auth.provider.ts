import { Injectable } from '@nestjs/common';
import type { CustomerSignInRequest } from '@mocha-house/contracts';
import { requireEnv } from './require-env';
import { signDevJwt } from './dev-jwt';
import { devPasswordMatches } from './dev-password-hash';
import { LocalDevCustomerDirectory } from './local-dev-customer-directory';
import type {
  CustomerAuthProvider,
  CustomerSignInOutcome,
} from '../application/customer-sign-in.types';

const TOKEN_TTL_SECONDS = 3600;

// DEV-ONLY / TEST SEAM — see auth-provider-mode.ts for how this stays
// fail-closed in production. Deterministic test double for Cognito
// sign-in: no real password check, no external call, so tests and manual
// local QA can sign in as any identifier reproducibly — the auth-boundary
// equivalent of FakePaymentProvider (orders/infrastructure). The subject is
// derived from the identifier so repeated sign-ins as the same identifier
// resolve to the same Mocha House Customer record.
@Injectable()
export class LocalDevAuthProvider implements CustomerAuthProvider {
  constructor(private readonly directory: LocalDevCustomerDirectory) {}

  signIn(request: CustomerSignInRequest): Promise<CustomerSignInOutcome> {
    const secret = requireEnv('AUTH_DEV_JWT_SECRET');
    const identifier = request.identifier.trim().toLowerCase();

    // Mirrors Cognito's UserNotConfirmedException (see
    // cognito-auth.provider.ts's CREDENTIAL_REJECTION_TYPES): an
    // identifier this directory knows about but hasn't verified must not
    // get a session, the same as a wrong password. An identifier the
    // directory has never seen (i.e. never went through /auth/register)
    // is untouched by this check and signs in exactly as before —
    // required so every pre-existing dev sign-in test, which never
    // registers first, keeps working unchanged.
    const pending = this.directory.get(identifier);
    if (pending && !pending.verified) {
      return Promise.resolve({ outcome: 'invalid-credentials' });
    }

    // Password check, but only for an identifier that actually registered
    // through the dev boundary (so a password hash was recorded). An
    // identifier the directory has never seen — every pre-existing dev
    // sign-in test — carries no hash and signs in with any password, as
    // before. This is what makes an old password stop working after
    // /auth/reset-password replaces the stored hash, and the new one start
    // working.
    if (
      pending?.passwordHash &&
      !devPasswordMatches(request.password, pending.passwordHash, secret)
    ) {
      return Promise.resolve({ outcome: 'invalid-credentials' });
    }

    const looksLikeEmail = identifier.includes('@');

    const idToken = signDevJwt(
      {
        sub: `dev:${identifier}`,
        email: looksLikeEmail ? identifier : null,
        name: null,
        // true only when this directory positively confirms it (mirrors
        // Cognito's email_verified claim); an identifier the directory
        // has never seen carries no assertion either way, same as a real
        // token with no such claim — never guessed as true.
        emailVerified: pending?.verified === true ? true : null,
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
