import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import type {
  AdjustGiftCardBalanceRequest,
  GiftCardSearchRequest,
  GiftCardStatusChangeRequest,
  IssueGiftCardRequest,
  UpdateGiftCardConfigurationRequest,
} from '@mocha-house/contracts';
import { InternalAuthGuard } from '../../internal-auth/infrastructure/internal-auth.guard';
import { PermissionGuard } from '../../internal-auth/authorization/permission.guard';
import { RequirePermission } from '../../internal-auth/authorization/require-permission.decorator';
import type { InternalAuthenticatedRequest } from '../../internal-auth/infrastructure/internal-identity';
import { GiftCardsAdminService } from '../application/gift-cards-admin.service';
import { GiftCardConfigurationService } from '../application/gift-card-configuration.service';

// HQ Gift Card administration (Milestone 7F). InternalAuthGuard
// (authentication + ACTIVE lifecycle) then PermissionGuard.
//   giftcards.view      — search + detail (read).
//   giftcards.manage    — issue, deactivate/reactivate, manual correction.
//   giftcards.configure — the gift-card purchasing configuration.
// All three are CORPORATE-only in the permission catalog, so a LOCATION
// grant can never satisfy PermissionGuard; every service method also calls
// `assertCorporate`. The controller is thin — all validation lives in the
// services, which never return a raw Prisma model.
@UseGuards(InternalAuthGuard, PermissionGuard)
@Controller('api/v1/admin/gift-cards')
export class AdminGiftCardsController {
  constructor(
    private readonly service: GiftCardsAdminService,
    private readonly configuration: GiftCardConfigurationService,
  ) {}

  // The code (or id) is submitted in the BODY, never the URL — a full
  // gift-card code must not land in a query string, access log or history.
  @RequirePermission('giftcards.view')
  @Post('search')
  search(
    @Body() body: GiftCardSearchRequest,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.service.search(body, request.authorization!);
  }

  // --- Configuration (giftcards.configure) — declared before :giftCardId
  // so "configuration" is never captured as an id. ------------------

  @RequirePermission('giftcards.configure')
  @Get('configuration')
  getConfiguration(@Req() request: InternalAuthenticatedRequest) {
    return this.configuration.getConfiguration(request.authorization!);
  }

  @RequirePermission('giftcards.configure')
  @Put('configuration')
  updateConfiguration(
    @Body() body: UpdateGiftCardConfigurationRequest,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.configuration.updateConfiguration(
      body,
      request.internalUser!.id,
      request.authorization!,
    );
  }

  // --- Gift cards --------------------------------------------------

  @RequirePermission('giftcards.manage')
  @Post()
  issue(
    @Body() body: IssueGiftCardRequest,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.service.issue(
      body,
      request.internalUser!.id,
      request.authorization!,
    );
  }

  @RequirePermission('giftcards.view')
  @Get(':giftCardId')
  detail(
    @Param('giftCardId') giftCardId: string,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.service.getDetail(giftCardId, request.authorization!);
  }

  @RequirePermission('giftcards.manage')
  @Post(':giftCardId/deactivate')
  deactivate(
    @Param('giftCardId') giftCardId: string,
    @Body() body: GiftCardStatusChangeRequest,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.service.deactivate(
      giftCardId,
      body,
      request.internalUser!.id,
      request.authorization!,
    );
  }

  @RequirePermission('giftcards.manage')
  @Post(':giftCardId/reactivate')
  reactivate(
    @Param('giftCardId') giftCardId: string,
    @Body() body: GiftCardStatusChangeRequest,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.service.reactivate(
      giftCardId,
      body,
      request.internalUser!.id,
      request.authorization!,
    );
  }

  // Manual add/deduct. `reason` and `operationKey` are required; the actor
  // is taken from the authenticated request (never the body); the resulting
  // balance can never fall below $0.00 or exceed $2,000.00; a repeated
  // operationKey is idempotent.
  @RequirePermission('giftcards.manage')
  @Post(':giftCardId/corrections')
  correct(
    @Param('giftCardId') giftCardId: string,
    @Body() body: AdjustGiftCardBalanceRequest,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.service.correct(
      giftCardId,
      body,
      request.internalUser!.id,
      request.authorization!,
    );
  }
}
