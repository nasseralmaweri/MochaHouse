import { Injectable } from '@nestjs/common';
import type { CustomerResetPasswordRequest } from '@mocha-house/contracts';
import { isDevCustomerAuthEnabled } from '../infrastructure/auth-provider-mode';
import { CognitoPasswordRecoveryProvider } from '../infrastructure/cognito-password-recovery.provider';
import { LocalDevPasswordRecoveryProvider } from '../infrastructure/local-dev-password-recovery.provider';
import type {
  CustomerStartPasswordRecoveryOutcome,
  CustomerConfirmPasswordResetOutcome,
} from './customer-password-recovery.types';

// Picks the live provider per-request from AUTH_PROVIDER/NODE_ENV exactly
// like CustomerRegistrationService and CustomerSignInService — never cached,
// so the dev seam can never leak into production (see auth-provider-mode.ts).
@Injectable()
export class CustomerPasswordRecoveryService {
  constructor(
    private readonly cognitoProvider: CognitoPasswordRecoveryProvider,
    private readonly localDevProvider: LocalDevPasswordRecoveryProvider,
  ) {}

  startPasswordRecovery(
    email: string,
  ): Promise<CustomerStartPasswordRecoveryOutcome> {
    return this.provider().startPasswordRecovery(email);
  }

  confirmPasswordReset(
    request: CustomerResetPasswordRequest,
  ): Promise<CustomerConfirmPasswordResetOutcome> {
    return this.provider().confirmPasswordReset(request);
  }

  private provider() {
    return isDevCustomerAuthEnabled()
      ? this.localDevProvider
      : this.cognitoProvider;
  }
}
