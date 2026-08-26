import { Injectable } from '@nestjs/common';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { requireEnv } from './require-env';
import type { CustomerIdentity } from './customer-identity';

type Verifier = ReturnType<typeof CognitoJwtVerifier.create>;

// Production customer-auth boundary. Verifies a Cognito ID token against
// the user pool's public JWKS (issuer + audience + signature + expiry —
// see aws-jwt-verify), and extracts only the stable subject and a couple
// of basic claims. No AWS credentials are needed for this — JWKS
// verification is a public-key operation — so this never touches AWS
// SigV4 or the AWS SDK.
@Injectable()
export class CognitoTokenVerifier {
  private cached: {
    verifier: Verifier;
    userPoolId: string;
    clientId: string;
  } | null = null;

  async verify(token: string): Promise<CustomerIdentity> {
    const userPoolId = requireEnv('COGNITO_USER_POOL_ID');
    const clientId = requireEnv('COGNITO_CLIENT_ID');

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
      provider: 'cognito',
      subject: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : null,
      name: typeof payload.name === 'string' ? payload.name : null,
    };
  }
}
