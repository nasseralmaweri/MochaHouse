import { Injectable } from '@nestjs/common';
import type { InternalSignInRequest } from '@mocha-house/contracts';
import { isDevInternalAuthEnabled } from '../infrastructure/internal-auth-provider-mode';
import { InternalCognitoAuthProvider } from '../infrastructure/internal-cognito-auth.provider';
import { InternalLocalDevAuthProvider } from '../infrastructure/internal-local-dev-auth.provider';
import type { InternalSignInOutcome } from './internal-sign-in.types';

@Injectable()
export class InternalSignInService {
  constructor(
    private readonly cognitoAuthProvider: InternalCognitoAuthProvider,
    private readonly localDevAuthProvider: InternalLocalDevAuthProvider,
  ) {}

  signIn(request: InternalSignInRequest): Promise<InternalSignInOutcome> {
    const provider = isDevInternalAuthEnabled()
      ? this.localDevAuthProvider
      : this.cognitoAuthProvider;
    return provider.signIn(request);
  }
}
