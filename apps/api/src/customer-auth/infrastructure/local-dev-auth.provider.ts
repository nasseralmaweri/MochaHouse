import { Injectable } from '@nestjs/common';
import type { CustomerSignInRequest } from '@mocha-house/contracts';
import { requireEnv } from './require-env';
import { signDevJwt } from './dev-jwt';
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
  signIn(request: CustomerSignInRequest): Promise<CustomerSignInOutcome> {
    const secret = requireEnv('AUTH_DEV_JWT_SECRET');
    const identifier = request.identifier.trim().toLowerCase();
    const looksLikeEmail = identifier.includes('@');

    const idToken = signDevJwt(
      {
        sub: `dev:${identifier}`,
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
