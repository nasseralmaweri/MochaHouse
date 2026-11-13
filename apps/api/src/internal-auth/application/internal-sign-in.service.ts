import { Injectable } from '@nestjs/common';
import type { InternalSignInRequest } from '@mocha-house/contracts';
import { isDevInternalAuthEnabled } from '../infrastructure/internal-auth-provider-mode';
import { InternalCognitoAuthProvider } from '../infrastructure/internal-cognito-auth.provider';
import { InternalLocalDevAuthProvider } from '../infrastructure/internal-local-dev-auth.provider';
import type {
  InternalAuthProvider,
  InternalNewPasswordOutcome,
  InternalSignInOutcome,
} from './internal-sign-in.types';

@Injectable()
export class InternalSignInService {
  constructor(
    private readonly cognitoAuthProvider: InternalCognitoAuthProvider,
    private readonly localDevAuthProvider: InternalLocalDevAuthProvider,
  ) {}

  private provider(): InternalAuthProvider {
    return isDevInternalAuthEnabled()
      ? this.localDevAuthProvider
      : this.cognitoAuthProvider;
  }

  signIn(request: InternalSignInRequest): Promise<InternalSignInOutcome> {
    return this.provider().signIn(request);
  }

  // V1 launch fix 2 — a first sign-in's own password, straight to the
  // provider (never stored or logged here).
  completeNewPassword(request: {
    identifier: string;
    session: string;
    newPassword: string;
  }): Promise<InternalNewPasswordOutcome> {
    return this.provider().completeNewPassword(request);
  }
}
