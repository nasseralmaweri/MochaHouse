import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { CustomersModule } from '../customers/customers.module';
import { LoyaltyService } from './application/loyalty.service';
import { LoyaltyAdminService } from './application/loyalty-admin.service';
import { CustomerLoyaltyController } from './api/customer-loyalty.controller';
import { AdminLoyaltyController } from './api/admin-loyalty.controller';

// Mocha Beans foundation (Milestone 7A): the earning path (LoyaltyService,
// used by OrdersModule's checkout), the authenticated customer balance
// read, and the HQ add/deduct surface (LoyaltyAdminService).
//
// InternalAuthGuard / PermissionGuard / AuthorizationService come from the
// @Global InternalAuthModule; CustomerAuthGuard from the @Global
// CustomerAuthModule; PrismaService from the @Global PrismaModule.
// CustomersModule provides CustomersService (identity -> Customer id for
// the customer balance endpoint); AuditModule provides InternalAuditService
// (the sensitive-action audit written alongside every manual adjustment).
@Module({
  imports: [PrismaModule, AuditModule, CustomersModule],
  controllers: [CustomerLoyaltyController, AdminLoyaltyController],
  providers: [LoyaltyService, LoyaltyAdminService],
  // Exported so OrdersModule's CheckoutService can earn Beans inside the
  // order-creation transaction.
  exports: [LoyaltyService],
})
export class LoyaltyModule {}
