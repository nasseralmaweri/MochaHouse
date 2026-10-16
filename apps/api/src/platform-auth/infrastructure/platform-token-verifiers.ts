import { Injectable } from '@nestjs/common';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import {
  PlatformAuthNotConfiguredError,
  platformCognitoConfig,
  requirePlatformEnv,
} from './platform-config';
import { verifyPlatformDevJwt } from './platform-dev-jwt';
import {
  PLATFORM_COGNITO_PROVIDER,
  PLATFORM_DEV_PROVIDER,
  type PlatformIdentity,
} from './platform-identity';

type Verifier = ReturnType<typeof CognitoJwtVerifier.create>;

// Production platform boundary. Verifies a Cognito ID token against the
// DEDICATED platform user pool's public JWKS — issuer (the pool), audience
// (the platform app client), token_use = id, signature and expiry (see
// aws-jwt-verify). A customer or tenant-staff ID token has a different
// issuer and audience and fails here; that mismatch is what keeps the
// populations apart.
//
// MFA: Cognito ID tokens do not state whether MFA was used. Platform-operator
// MFA is therefore enforced by the platform pool's configuration (MFA
// REQUIRED, TOTP) — see docs/security/platform-operator-auth.md. This
// verifier cannot detect a pool whose MFA setting was weakened.
//
// No AWS credentials: JWKS verification is a public-key operation.
@Injectable()
export class PlatformCognitoTokenVerifier {
  private cached: {
    verifier: Verifier;
    userPoolId: string;
    clientId: string;
  } | null = null;

  async verify(token: string): Promise<PlatformIdentity> {
    const { userPoolId, clientId } = platformCognitoConfig();
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
    const signedInAt =
      typeof payload.auth_time === 'number' ? payload.auth_time : payload.iat;
    return {
      provider: PLATFORM_COGNITO_PROVIDER,
      subject: payload.sub,
      authenticatedAt: typeof signedInAt === 'number' ? signedInAt : null,
    };
  }
}

// DEV-ONLY / TEST SEAM — see platform-auth-provider-mode.ts. Uses
// PLATFORM_AUTH_DEV_JWT_SECRET only, and stamps provider "platform-dev", so a
// dev-provisioned operator can never match a Cognito identity.
@Injectable()
export class PlatformLocalDevTokenVerifier {
  verify(token: string): Promise<PlatformIdentity> {
    try {
      const secret = requirePlatformEnv('PLATFORM_AUTH_DEV_JWT_SECRET');
      // Checked on every request, not only at API startup (which Jest and CI
      // never run): the customer dev codec carries no marker, so a shared
      // secret is the one way another boundary's dev token could line up.
      if (
        secret === process.env.AUTH_DEV_JWT_SECRET ||
        secret === process.env.INTERNAL_AUTH_DEV_JWT_SECRET
      ) {
        throw new PlatformAuthNotConfiguredError(
          'PLATFORM_AUTH_DEV_JWT_SECRET must differ from the other dev secrets.',
        );
      }
      const { sub, iat } = verifyPlatformDevJwt(token, secret);
      return Promise.resolve({
        provider: PLATFORM_DEV_PROVIDER,
        subject: sub,
        authenticatedAt: iat,
      });
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error('Invalid platform token.'),
      );
    }
  }
}
