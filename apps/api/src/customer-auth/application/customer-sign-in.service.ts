import { Injectable } from '@nestjs/common';
import type { CustomerSignInRequest } from '@mocha-house/contracts';
import { isDevCustomerAuthEnabled } from '../infrastructure/auth-provider-mode';
import { CognitoAuthProvider } from '../infrastructure/cognito-auth.provider';
import { LocalDevAuthProvider } from '../infrastructure/local-dev-auth.provider';
import type { CustomerSignInOutcome } from './customer-sign-in.types';

@Injectable()
export class CustomerSignInService {
  constructor(
    private readonly cognitoAuthProvider: CognitoAuthProvider,
    private readonly localDevAuthProvider: LocalDevAuthProvider,
  ) {}

  signIn(request: CustomerSignInRequest): Promise<CustomerSignInOutcome> {
    const provider = isDevCustomerAuthEnabled()
      ? this.localDevAuthProvider
      : this.cognitoAuthProvider;
    return provider.signIn(request);
  }
}
