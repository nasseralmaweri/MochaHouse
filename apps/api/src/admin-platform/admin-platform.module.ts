import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { OrdersModule } from '../orders/orders.module';
import { AdminPlatformController } from './admin-platform.controller';
import { AdminPlatformStatusService } from './admin-platform-status.service';

// The Admin Platform Status view (Milestone 5G): a small, read-only,
// business-facing report of the platform's high-level posture. It persists
// nothing and configures nothing.
//
// OrdersModule is imported ONLY for the exported PAYMENT_PROVIDER token, so
// the payment-integration posture is read through the same boundary the
// order domain uses — never by depending on FakePaymentProvider directly.
// InternalAuthGuard / PermissionGuard / AuthorizationService come from the
// @Global InternalAuthModule; PrismaService from the @Global PrismaModule.
@Module({
  imports: [PrismaModule, OrdersModule],
  controllers: [AdminPlatformController],
  providers: [AdminPlatformStatusService],
})
export class AdminPlatformModule {}
