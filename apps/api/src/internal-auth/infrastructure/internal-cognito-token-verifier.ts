import { Injectable } from '@nestjs/common';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { requireInternalEnv } from './require-internal-env';
import type { InternalIdentity } from './internal-identity';

type Verifier = ReturnType<typeof CognitoJwtVerifier.create>;

// Production internal-auth boundary. Verifies a Cognito ID token against
// the DEDICATED INTERNAL user pool's public JWKS (issuer + audience +
// signature + expiry — see aws-jwt-verify), bound to
// INTERNAL_COGNITO_USER_POOL_ID / INTERNAL_COGNITO_CLIENT_ID.
//
// This is a completely separate verifier instance from the customer
// boundary's CognitoTokenVerifier, bound to a different pool and app
// client. A customer ID token has a different issuer and audience and
// therefore fails verification here — that mismatch, not a code check, is
// what guarantees a customer token can never become an InternalIdentity.
//
// No AWS credentials are needed — JWKS verification is a public-key
// operation — so this never touches AWS SigV4 or the AWS SDK. No
// production AWS infrastructure is provisioned by this codebase; the pool
// is expected to exist via console/IaC before this path is used.
@Injectable()
export class InternalCognitoTokenVerifier {
  private cached: {
    verifier: Verifier;
    userPoolId: string;
    clientId: string;
  } | null = null;

  async verify(token: string): Promise<InternalIdentity> {
    const userPoolId = requireInternalEnv('INTERNAL_COGNITO_USER_POOL_ID');
    const clientId = requireInternalEnv('INTERNAL_COGNITO_CLIENT_ID');

    if (
      !this.cached ||
      this.cached.userPoolId !== userPoolId ||
      this.cached.clientId !== clientId
    ) {
      this.cached = {
        userPoolId,
        clientId,
        verifier: CognitoJwtVerifier.create({
          userPoolId,
          tokenUse: 'id',
          clientId,
        }),
      };
    }

    const payload = await this.cached.verifier.verify(token);

    return {
      provider: 'cognito-internal',
      subject: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : null,
      name: typeof payload.name === 'string' ? payload.name : null,
    };
  }
}
