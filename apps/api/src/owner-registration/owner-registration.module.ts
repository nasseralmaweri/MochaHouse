import { Module } from '@nestjs/common';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { PlatformTenantsModule } from '../platform-tenants/platform-tenants.module';
import { InternalCognitoAuthProvider } from '../internal-auth/infrastructure/internal-cognito-auth.provider';
import { OwnerRegistrationController } from './api/owner-registration.controller';
import { OwnerOnboardingController } from './api/owner-onboarding.controller';
import { OwnerRegistrationService } from './application/owner-registration.service';
import { OwnerOnboardingService } from './application/owner-onboarding.service';
import { CognitoOwnerRegistrationProvider } from './infrastructure/cognito-owner-registration.provider';
import { LocalDevOwnerRegistrationProvider } from './infrastructure/local-dev-owner-registration.provider';

// SC4a — business owner self-service registration (off by default). It
// creates a staff-pool login and a platform OwnerRegistration record only.
// SC4b — the owner's onboarding: creating their ONE business, through the
// platform's single business writer (TenantProvisioningService). Nothing in
// this module writes business data itself. InternalCognitoTokenVerifier and
// InternalIdentityGuard come from the @Global InternalAuthModule;
// PrismaService from the @Global PrismaModule.
@Module({
  imports: [RateLimitModule, PlatformTenantsModule],
  controllers: [OwnerRegistrationController, OwnerOnboardingController],
  providers: [
    OwnerRegistrationService,
    OwnerOnboardingService,
    CognitoOwnerRegistrationProvider,
    LocalDevOwnerRegistrationProvider,
    InternalCognitoAuthProvider,
  ],
})
export class OwnerRegistrationModule {}
