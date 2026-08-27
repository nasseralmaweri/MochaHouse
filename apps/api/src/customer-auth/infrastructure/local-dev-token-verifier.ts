import { Injectable } from '@nestjs/common';
import { requireEnv } from './require-env';
import { verifyDevJwt } from './dev-jwt';
import type { CustomerIdentity } from './customer-identity';

// DEV-ONLY / TEST SEAM — see auth-provider-mode.ts for how this stays
// fail-closed in production. Verifies the locally-signed token minted by
// LocalDevAuthProvider so local development and automated tests can
// exercise the full customer-auth boundary (guard -> verify -> resolve
// Customer) without live AWS Cognito.
@Injectable()
export class LocalDevTokenVerifier {
  verify(token: string): Promise<CustomerIdentity> {
    const secret = requireEnv('AUTH_DEV_JWT_SECRET');
    const payload = verifyDevJwt(token, secret);

    return Promise.resolve({
      provider: 'dev',
      subject: payload.sub,
      email: payload.email,
      name: payload.name,
      emailVerified: payload.emailVerified ?? null,
    });
  }
}
