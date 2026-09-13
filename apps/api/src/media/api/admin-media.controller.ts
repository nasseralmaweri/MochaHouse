import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { UpdateMediaAssetMetadataRequest } from '@mocha-house/contracts';
import { InternalAuthGuard } from '../../internal-auth/infrastructure/internal-auth.guard';
import { PermissionGuard } from '../../internal-auth/authorization/permission.guard';
import { RequirePermission } from '../../internal-auth/authorization/require-permission.decorator';
import type { InternalAuthenticatedRequest } from '../../internal-auth/infrastructure/internal-identity';
import { MediaAssetsAdminService } from '../application/media-assets-admin.service';

// Admin → Media (Milestone 8F; get-one/search/metadata added in 8I).
// InternalAuthGuard then PermissionGuard.
//   media.view    — browse/search/get-one the library.
//   media.manage  — upload / edit title+altText / deactivate.
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
    @Query('q') q?: string,
  ) {
    return this.service.list({ cursor, q }, request.authorization!);
  }

  @RequirePermission('media.view')
  @Get(':mediaAssetId')
  async getOne(
    @Param('mediaAssetId') mediaAssetId: string,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    const asset = await this.service.getOne(mediaAssetId, request.authorization!);
    return { asset };
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
  @Patch(':mediaAssetId')
  async updateMetadata(
    @Param('mediaAssetId') mediaAssetId: string,
    @Body() body: UpdateMediaAssetMetadataRequest,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    const asset = await this.service.updateMetadata(
      mediaAssetId,
      body,
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
