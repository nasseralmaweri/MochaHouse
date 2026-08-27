import { Injectable } from '@nestjs/common';
import type {
  CustomerRegisterRequest,
  CustomerVerifyRequest,
} from '@mocha-house/contracts';
import { isDevCustomerAuthEnabled } from '../infrastructure/auth-provider-mode';
import { CognitoRegistrationProvider } from '../infrastructure/cognito-registration.provider';
import { LocalDevRegistrationProvider } from '../infrastructure/local-dev-registration.provider';
import type {
  CustomerRegistrationOutcome,
  CustomerVerificationOutcome,
  CustomerResendOutcome,
} from './customer-registration.types';

@Injectable()
export class CustomerRegistrationService {
  constructor(
    private readonly cognitoProvider: CognitoRegistrationProvider,
    private readonly localDevProvider: LocalDevRegistrationProvider,
  ) {}

  register(
    request: CustomerRegisterRequest,
  ): Promise<CustomerRegistrationOutcome> {
    return this.provider().register(request);
  }

  verify(request: CustomerVerifyRequest): Promise<CustomerVerificationOutcome> {
    return this.provider().verify(request);
  }

  resendVerification(email: string): Promise<CustomerResendOutcome> {
    return this.provider().resendVerification(email);
  }

  private provider() {
    return isDevCustomerAuthEnabled()
      ? this.localDevProvider
      : this.cognitoProvider;
  }
}
