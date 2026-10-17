import { Module } from '@nestjs/common';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { PlatformAuthController } from './api/platform-auth.controller';
import { PlatformMeController } from './api/platform-me.controller';
import { PlatformOperatorsService } from './application/platform-operators.service';
import { PlatformSignInService } from './application/platform-sign-in.service';
import { PlatformAuthGuard } from './infrastructure/platform-auth.guard';
import { PlatformPermissionGuard } from './authorization/platform-permission.guard';
import {
  PlatformCognitoTokenVerifier,
  PlatformLocalDevTokenVerifier,
} from './infrastructure/platform-token-verifiers';
import { PlatformChallengeStore } from './sign-in/platform-challenge-store';
import { PlatformCognitoSignInProvider } from './sign-in/platform-cognito-sign-in.provider';
import { PlatformDevSignInProvider } from './sign-in/platform-dev-sign-in.provider';

// SC1a — the CENTERIVO platform-operator boundary (/api/v1/platform/*).
// Deliberately NOT @Global and importing nothing from the customer or
// tenant-staff auth modules: platform routes use PlatformAuthGuard, and that
// guard is exported for future platform modules only. PrismaService and
// RedisService come from their @Global modules.
//
// SC1b — plus operator sign-in with mandatory TOTP MFA
// (/api/v1/platform/auth/*), its server-side challenge store, and sign-out.
@Module({
  imports: [RateLimitModule],
  controllers: [PlatformMeController, PlatformAuthController],
  providers: [
    PlatformOperatorsService,
    PlatformAuthGuard,
    PlatformPermissionGuard,
    PlatformCognitoTokenVerifier,
    PlatformLocalDevTokenVerifier,
    PlatformSignInService,
    PlatformChallengeStore,
    PlatformCognitoSignInProvider,
    PlatformDevSignInProvider,
  ],
  // SC1c — the guard is instantiated in each platform module that uses it,
  // so its own dependencies are exported with it.
  exports: [
    PlatformAuthGuard,
    PlatformPermissionGuard,
    PlatformOperatorsService,
    PlatformCognitoTokenVerifier,
    PlatformLocalDevTokenVerifier,
  ],
})
export class PlatformAuthModule {}
