import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { InternalAuthGuard } from '../../internal-auth/infrastructure/internal-auth.guard';
import { PermissionGuard } from '../../internal-auth/authorization/permission.guard';
import { RequirePermission } from '../../internal-auth/authorization/require-permission.decorator';
import type { InternalAuthenticatedRequest } from '../../internal-auth/infrastructure/internal-identity';
import { MediaAssetsAdminService } from '../application/media-assets-admin.service';

// Admin → Media (Milestone 8F). InternalAuthGuard then PermissionGuard.
//   media.view    — browse the library.
//   media.manage  — upload / deactivate.
// Both CORPORATE-only; every service method also calls assertCorporate.
// Upload is a bounded multipart request through this API (memory storage —
// files are small, images only); the object is written to MediaStorage
// BEFORE the MediaAsset row is created.
@UseGuards(InternalAuthGuard, PermissionGuard)
@Controller('api/v1/admin/media')
export class AdminMediaController {
  constructor(private readonly service: MediaAssetsAdminService) {}

  @RequirePermission('media.view')
  @Get()
  list(
    @Req() request: InternalAuthenticatedRequest,
    @Query('cursor') cursor?: string,
  ) {
    return this.service.list({ cursor }, request.authorization!);
  }

  @RequirePermission('media.manage')
  @Post()
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    const asset = await this.service.upload(
      file,
      request.internalUser!.id,
      request.authorization!,
    );
    return { asset };
  }

  @RequirePermission('media.manage')
  @Post(':mediaAssetId/deactivate')
  async deactivate(
    @Param('mediaAssetId') mediaAssetId: string,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    const asset = await this.service.deactivate(
      mediaAssetId,
      request.internalUser!.id,
      request.authorization!,
    );
    return { asset };
  }
}
