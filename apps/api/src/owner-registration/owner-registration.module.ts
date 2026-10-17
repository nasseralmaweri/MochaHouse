import { Module } from '@nestjs/common';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { InternalCognitoAuthProvider } from '../internal-auth/infrastructure/internal-cognito-auth.provider';
import { OwnerRegistrationController } from './api/owner-registration.controller';
import { OwnerRegistrationService } from './application/owner-registration.service';
import { CognitoOwnerRegistrationProvider } from './infrastructure/cognito-owner-registration.provider';
import { LocalDevOwnerRegistrationProvider } from './infrastructure/local-dev-owner-registration.provider';

// SC4a — business owner self-service registration (off by default). It
// creates a staff-pool login and a platform OwnerRegistration record only;
// it never writes business data. InternalCognitoTokenVerifier comes from the
// @Global InternalAuthModule; PrismaService from the @Global PrismaModule.
@Module({
  imports: [RateLimitModule],
  controllers: [OwnerRegistrationController],
  providers: [
    OwnerRegistrationService,
    CognitoOwnerRegistrationProvider,
    LocalDevOwnerRegistrationProvider,
    InternalCognitoAuthProvider,
  ],
})
export class OwnerRegistrationModule {}
