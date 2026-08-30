import { Global, Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { AuthController } from './api/auth.controller';
import { CustomerSignInService } from './application/customer-sign-in.service';
import { CustomerRegistrationService } from './application/customer-registration.service';
import { CustomerPasswordRecoveryService } from './application/customer-password-recovery.service';
import { CustomerAuthGuard } from './infrastructure/customer-auth.guard';
import { OptionalCustomerAuthGuard } from './infrastructure/optional-customer-auth.guard';
import { CognitoTokenVerifier } from './infrastructure/cognito-token-verifier';
import { LocalDevTokenVerifier } from './infrastructure/local-dev-token-verifier';
import { CognitoAuthProvider } from './infrastructure/cognito-auth.provider';
import { LocalDevAuthProvider } from './infrastructure/local-dev-auth.provider';
import { CognitoRegistrationProvider } from './infrastructure/cognito-registration.provider';
import { LocalDevRegistrationProvider } from './infrastructure/local-dev-registration.provider';
import { CognitoPasswordRecoveryProvider } from './infrastructure/cognito-password-recovery.provider';
import { LocalDevPasswordRecoveryProvider } from './infrastructure/local-dev-password-recovery.provider';
import { LocalDevCustomerDirectory } from './infrastructure/local-dev-customer-directory';

// The customer-authentication boundary: token verification (CustomerAuthGuard,
// used by other modules to protect routes), sign-in, registration, email
// verification, and password recovery/reset (all under AuthController,
// POST /api/v1/auth/*).
// Both the Cognito and dev/test implementations of every provider are
// always wired up; which one actually runs is decided per-request from
// AUTH_PROVIDER/NODE_ENV (see infrastructure/auth-provider-mode.ts) rather
// than at module-construction time — the same fail-closed-every-time
// convention the internal-auth boundary uses.
//
// LocalDevCustomerDirectory is the one piece of state shared across two
// otherwise-independent dev providers (registration and sign-in) — see its
// own doc comment for why sign-in needs to know what registration knows.
//
// Imports CustomersModule for CustomersService: register/verify need to
// create/look up the Mocha House Customer directly (see AuthController).
// CustomersModule does *not* import this module back — see its own doc
// comment — so this stays a one-directional dependency, not a cycle.
//
// @Global, like PrismaModule: this is an app-wide cross-cutting boundary
// (any module protecting a route with CustomerAuthGuard needs it), not a
// feature module — mirrors how PrismaModule is the one other @Global module
// in this app.
@Global()
@Module({
  imports: [CustomersModule],
  controllers: [AuthController],
  providers: [
    CustomerSignInService,
    CustomerRegistrationService,
    CustomerPasswordRecoveryService,
    CustomerAuthGuard,
    OptionalCustomerAuthGuard,
    CognitoTokenVerifier,
    LocalDevTokenVerifier,
    CognitoAuthProvider,
    LocalDevAuthProvider,
    CognitoRegistrationProvider,
    LocalDevRegistrationProvider,
    CognitoPasswordRecoveryProvider,
    LocalDevPasswordRecoveryProvider,
    LocalDevCustomerDirectory,
  ],
  // Both guards' own constructor dependencies (the two verifiers) must be
  // exported too, not just the guards themselves — an importing module
  // resolving a guard via @UseGuards() still needs to be able to resolve
  // *its* dependencies in that scope.
  exports: [
    CustomerAuthGuard,
    OptionalCustomerAuthGuard,
    CognitoTokenVerifier,
    LocalDevTokenVerifier,
  ],
})
export class CustomerAuthModule {}
