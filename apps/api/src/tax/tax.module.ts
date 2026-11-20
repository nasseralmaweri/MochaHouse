import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { AuditModule } from '../audit/audit.module';
import { AdminTaxController } from './api/admin-tax.controller';
import { TaxSettingsService } from './application/tax-settings.service';

// V1 Sales Tax PR 1 — the business's sales tax settings (configuration
// only). Checkout, order totals, payments, refunds and reports do not use
// it yet.
@Module({
  imports: [PrismaModule, InternalAuthModule, AuditModule],
  controllers: [AdminTaxController],
  providers: [TaxSettingsService],
})
export class TaxModule {}
