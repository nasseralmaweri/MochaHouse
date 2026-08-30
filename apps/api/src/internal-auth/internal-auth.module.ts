import { Global, Module } from '@nestjs/common';
import { InternalAuthController } from './api/internal-auth.controller';
import { InternalMeController } from './api/internal-me.controller';
import { InternalSignInService } from './application/internal-sign-in.service';
import { InternalUsersService } from './application/internal-users.service';
import { InternalAuthGuard } from './infrastructure/internal-auth.guard';
import { InternalCognitoTokenVerifier } from './infrastructure/internal-cognito-token-verifier';
import { InternalLocalDevTokenVerifier } from './infrastructure/internal-local-dev-token-verifier';
import { InternalCognitoAuthProvider } from './infrastructure/internal-cognito-auth.provider';
import { InternalLocalDevAuthProvider } from './infrastructure/internal-local-dev-auth.provider';
import { AuthorizationService } from './authorization/authorization.service';
import { PermissionGuard } from './authorization/permission.guard';

// The internal-authentication boundary: internal sign-in (InternalAuthController,
// POST /api/v1/internal/auth/sign-in), the authenticated internal identity
// probe (InternalMeController, GET /api/v1/internal/me), and — the reason
// this is @Global — InternalAuthGuard, which every module protecting an
// /api/v1/admin/* or /api/v1/internal/* route applies via @UseGuards().
//
// Completely independent of CustomerAuthModule: it imports nothing from it,
// shares no provider, and its identity/guard/cookie names are all distinct.
// Both the Cognito and dev/test implementations of the token verifier and
// the sign-in provider are always wired; which one runs is decided
// per-request from INTERNAL_AUTH_PROVIDER/NODE_ENV (see
// infrastructure/internal-auth-provider-mode.ts), fail-closed every time.
//
// PrismaService comes from the @Global PrismaModule (used by
// InternalUsersService to resolve and lifecycle-check the InternalUser).
//
// @Global, like PrismaModule and CustomerAuthModule: an app-wide
// cross-cutting boundary, not a feature module.
@Global()
@Module({
  controllers: [InternalAuthController, InternalMeController],
  providers: [
    InternalSignInService,
    InternalUsersService,
    InternalAuthGuard,
    InternalCognitoTokenVerifier,
    InternalLocalDevTokenVerifier,
    InternalCognitoAuthProvider,
    InternalLocalDevAuthProvider,
    // Milestone 5B — authorization layer, applied after InternalAuthGuard.
    AuthorizationService,
    PermissionGuard,
  ],
  // The guard's own constructor dependencies (the two verifiers and
  // InternalUsersService) must be exported too — an importing module
  // resolving InternalAuthGuard via @UseGuards() still needs to resolve
  // its dependencies in that scope. Mirrors CustomerAuthModule's exports.
  exports: [
    InternalAuthGuard,
    InternalCognitoTokenVerifier,
    InternalLocalDevTokenVerifier,
    InternalUsersService,
    AuthorizationService,
    PermissionGuard,
  ],
})
export class InternalAuthModule {}
