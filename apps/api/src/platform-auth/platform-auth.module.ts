import { Module } from '@nestjs/common';
import { PlatformMeController } from './api/platform-me.controller';
import { PlatformOperatorsService } from './application/platform-operators.service';
import { PlatformAuthGuard } from './infrastructure/platform-auth.guard';
import {
  PlatformCognitoTokenVerifier,
  PlatformLocalDevTokenVerifier,
} from './infrastructure/platform-token-verifiers';

// SC1a — the CENTERIVO platform-operator boundary (/api/v1/platform/*).
// Deliberately NOT @Global and importing nothing from the customer or
// tenant-staff auth modules: platform routes use PlatformAuthGuard, and that
// guard is exported for future platform modules only. PrismaService comes
// from the @Global PrismaModule.
@Module({
  controllers: [PlatformMeController],
  providers: [
    PlatformOperatorsService,
    PlatformAuthGuard,
    PlatformCognitoTokenVerifier,
    PlatformLocalDevTokenVerifier,
  ],
  exports: [PlatformAuthGuard, PlatformOperatorsService],
})
export class PlatformAuthModule {}
