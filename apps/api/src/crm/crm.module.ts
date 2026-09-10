import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { CustomersModule } from '../customers/customers.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { OrdersModule } from '../orders/orders.module';
import { GiftCardsModule } from '../gift-cards/gift-cards.module';
import { AdminCustomersController } from './api/admin-customers.controller';
import { CrmCustomersService } from './application/crm-customers.service';
import { CustomerNotesService } from './application/customer-notes.service';

// Milestone 8A — HQ CRM foundation. Admin → Customers: a browsable customer
// directory and an aggregated customer detail, plus append-only internal
// CRM notes. It is NOT a customer system: the ONLY table it owns is
// CustomerNote. Every other field is projected live from an existing domain
// read service (imported below), so nothing authoritative is duplicated.
//
// InternalAuthGuard / PermissionGuard / AuthorizationService come from the
// @Global InternalAuthModule; PrismaService from the @Global PrismaModule;
// InternalAuditService from AuditModule (the note + its audit event commit
// in one transaction). The four domain modules are imported for their
// exported, customerId-scoped, read-only services only.
@Module({
  imports: [
    PrismaModule,
    AuditModule,
    CustomersModule,
    LoyaltyModule,
    OrdersModule,
    GiftCardsModule,
  ],
  controllers: [AdminCustomersController],
  providers: [CrmCustomersService, CustomerNotesService],
})
export class CrmModule {}
