import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { UpdateCmsPageContentRequest } from '@mocha-house/contracts';
import { InternalAuthGuard } from '../../internal-auth/infrastructure/internal-auth.guard';
import { PermissionGuard } from '../../internal-auth/authorization/permission.guard';
import { RequirePermission } from '../../internal-auth/authorization/require-permission.decorator';
import type { InternalAuthenticatedRequest } from '../../internal-auth/infrastructure/internal-identity';
import { CmsPagesAdminService } from '../application/cms-pages-admin.service';

// Admin → Content (Milestone 8E). InternalAuthGuard then PermissionGuard.
//   cms.view    — list / detail (read, including draft content).
//   cms.manage  — save draft / publish.
// Both CORPORATE-only; every service method also calls assertCorporate.
// GET never writes to the database — a missing page is synthesized from
// the registry default.
@UseGuards(InternalAuthGuard, PermissionGuard)
@Controller('api/v1/admin/content')
export class AdminCmsController {
  constructor(private readonly service: CmsPagesAdminService) {}

  @RequirePermission('cms.view')
  @Get()
  list(@Req() request: InternalAuthenticatedRequest) {
    return this.service.list(request.authorization!);
  }

  @RequirePermission('cms.view')
  @Get(':pageKey')
  detail(
    @Param('pageKey') pageKey: string,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.service.getDetail(pageKey, request.authorization!);
  }

  @RequirePermission('cms.manage')
  @Patch(':pageKey')
  saveDraft(
    @Param('pageKey') pageKey: string,
    @Body() body: UpdateCmsPageContentRequest,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.service.saveDraft(
      pageKey,
      body?.content,
      request.internalUser!.id,
      request.authorization!,
    );
  }

  @RequirePermission('cms.manage')
  @Post(':pageKey/publish')
  publish(
    @Param('pageKey') pageKey: string,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.service.publish(
      pageKey,
      request.internalUser!.id,
      request.authorization!,
    );
  }
}
