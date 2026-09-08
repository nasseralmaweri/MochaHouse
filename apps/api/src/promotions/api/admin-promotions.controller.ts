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
import type {
  CreatePromotionRequest,
  UpdatePromotionRequest,
} from '@mocha-house/contracts';
import { InternalAuthGuard } from '../../internal-auth/infrastructure/internal-auth.guard';
import { PermissionGuard } from '../../internal-auth/authorization/permission.guard';
import { RequirePermission } from '../../internal-auth/authorization/require-permission.decorator';
import type { InternalAuthenticatedRequest } from '../../internal-auth/infrastructure/internal-identity';
import { PromotionsAdminService } from '../application/promotions-admin.service';

// HQ management of Promotions & Coupons (Milestone 7E). InternalAuthGuard
// (authentication + ACTIVE lifecycle) then PermissionGuard.
// `promotions.configure` is CORPORATE-only in the permission catalog, so a
// LOCATION grant can never satisfy PermissionGuard; every service method
// also calls `assertCorporate`.
@UseGuards(InternalAuthGuard, PermissionGuard)
@Controller('api/v1/admin/promotions')
export class AdminPromotionsController {
  constructor(private readonly service: PromotionsAdminService) {}

  @RequirePermission('promotions.configure')
  @Get()
  list(@Req() request: InternalAuthenticatedRequest) {
    return this.service.listPromotions(request.authorization!);
  }

  @RequirePermission('promotions.configure')
  @Get('options')
  options(@Req() request: InternalAuthenticatedRequest) {
    return this.service.getOptions(request.authorization!);
  }

  @RequirePermission('promotions.configure')
  @Post()
  create(
    @Body() body: CreatePromotionRequest,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.service.createPromotion(
      body,
      request.internalUser!.id,
      request.authorization!,
    );
  }

  @RequirePermission('promotions.configure')
  @Patch(':promotionId')
  update(
    @Param('promotionId') promotionId: string,
    @Body() body: UpdatePromotionRequest,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.service.updatePromotion(
      promotionId,
      body,
      request.internalUser!.id,
      request.authorization!,
    );
  }
}
