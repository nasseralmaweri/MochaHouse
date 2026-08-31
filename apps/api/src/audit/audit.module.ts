import { Module } from '@nestjs/common';
import { InternalAuditService } from './internal-audit.service';

// The access-control audit foundation (Milestone 5E-3). A thin write-only
// service today; later access-management slices (role/scope assignment)
// import this same module to record their events in-transaction. No audit
// read API, no UI, no event bus — storage + write only.
@Module({
  providers: [InternalAuditService],
  exports: [InternalAuditService],
})
export class AuditModule {}
