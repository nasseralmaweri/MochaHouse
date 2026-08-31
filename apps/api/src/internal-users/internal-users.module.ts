import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminInternalUsersController } from './api/admin-internal-users.controller';
import { AdminInternalUsersService } from './application/admin-internal-users.service';

// Administration → internal-user access review (Milestone 5E-1). Read-only.
// InternalAuthGuard / PermissionGuard / AuthorizationService come from the
// @Global InternalAuthModule; PrismaService from the @Global PrismaModule.
@Module({
  imports: [PrismaModule],
  controllers: [AdminInternalUsersController],
  providers: [AdminInternalUsersService],
})
export class InternalUsersModule {}
