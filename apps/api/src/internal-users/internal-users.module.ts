import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { AdminInternalUsersController } from './api/admin-internal-users.controller';
import { AdminInternalUsersService } from './application/admin-internal-users.service';
import { AdminInternalRolesController } from './api/admin-internal-roles.controller';
import { AdminInternalRolesService } from './application/admin-internal-roles.service';

// The Administration area (Milestone 5E): internal-user access review
// (5E-1), access-level / role review (5E-2), and internal-user status
// management (5E-3). InternalAuthGuard / PermissionGuard /
// AuthorizationService come from the @Global InternalAuthModule;
// PrismaService from the @Global PrismaModule; InternalAuditService from
// AuditModule.
@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [AdminInternalUsersController, AdminInternalRolesController],
  providers: [AdminInternalUsersService, AdminInternalRolesService],
})
export class InternalUsersModule {}
