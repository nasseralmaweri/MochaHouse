import { Global, Module } from '@nestjs/common';
import { AuthController } from './api/auth.controller';
import { CustomerSignInService } from './application/customer-sign-in.service';
import { CustomerAuthGuard } from './infrastructure/customer-auth.guard';
import { CognitoTokenVerifier } from './infrastructure/cognito-token-verifier';
import { LocalDevTokenVerifier } from './infrastructure/local-dev-token-verifier';
import { CognitoAuthProvider } from './infrastructure/cognito-auth.provider';
import { LocalDevAuthProvider } from './infrastructure/local-dev-auth.provider';

// The customer-authentication boundary: token verification (CustomerAuthGuard,
// used by other modules to protect routes) and sign-in (AuthController,
// POST /api/v1/auth/sign-in). Both the Cognito and dev/test implementations
// are always wired up; which one actually runs is decided per-request from
// AUTH_PROVIDER/NODE_ENV (see infrastructure/auth-provider-mode.ts) rather
// than at module-construction time, the same fail-closed-every-time
// convention orders/infrastructure/dev-internal.guard.ts already uses.
//
// @Global, like PrismaModule: this is an app-wide cross-cutting boundary
// (any module protecting a route with CustomerAuthGuard needs it), not a
// feature module — mirrors how PrismaModule is the one other @Global module
// in this app.
@Global()
@Module({
  controllers: [AuthController],
  providers: [
    CustomerSignInService,
    CustomerAuthGuard,
    CognitoTokenVerifier,
    LocalDevTokenVerifier,
    CognitoAuthProvider,
    LocalDevAuthProvider,
  ],
  // CustomerAuthGuard's own constructor dependencies (the two verifiers)
  // must be exported too, not just the guard itself — an importing module
  // resolving CustomerAuthGuard via @UseGuards() still needs to be able to
  // resolve *its* dependencies in that scope.
  exports: [CustomerAuthGuard, CognitoTokenVerifier, LocalDevTokenVerifier],
})
export class CustomerAuthModule {}
