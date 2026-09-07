import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type {
  AdminAdjustMochaBeansRequest,
  CreateLoyaltyRewardRequest,
  UpdateLoyaltyRewardRequest,
  UpdateLoyaltySettingsRequest,
} from '@mocha-house/contracts';
import { InternalAuthGuard } from '../../internal-auth/infrastructure/internal-auth.guard';
import { PermissionGuard } from '../../internal-auth/authorization/permission.guard';
import { RequirePermission } from '../../internal-auth/authorization/require-permission.decorator';
import type { InternalAuthenticatedRequest } from '../../internal-auth/infrastructure/internal-identity';
import { LoyaltyAdminService } from '../application/loyalty-admin.service';
import { LoyaltySettingsService } from '../application/loyalty-settings.service';
import { LoyaltyRewardsService } from '../application/loyalty-rewards.service';

// The HQ loyalty surface. InternalAuthGuard (authentication + ACTIVE
// lifecycle) then PermissionGuard.
//   - Milestone 7A: `loyalty.view` (customer balance + ledger),
//     `loyalty.adjust` (manual add/deduct).
//   - Milestone 7B: `loyalty.configure` (earning-rate settings + Rewards
//     Catalog management).
// All three are CORPORATE-only in the permission catalog, so a LOCATION
// grant can never satisfy PermissionGuard.has(); every service method also
// calls assertCorporate. This controller exposes only loyalty data — it is
// not a customer-management module.
@UseGuards(InternalAuthGuard, PermissionGuard)
@Controller('api/v1/admin/loyalty')
export class AdminLoyaltyController {
  constructor(
    private readonly service: LoyaltyAdminService,
    private readonly settings: LoyaltySettingsService,
    private readonly rewards: LoyaltyRewardsService,
  ) {}

  // --- Milestone 7A: customer Mocha Beans ------------------------

  @RequirePermission('loyalty.view')
  @Get('customers')
  search(
    @Query('query') query: string | undefined,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.service.searchCustomers(query, request.authorization!);
  }

  @RequirePermission('loyalty.view')
  @Get('customers/:customerId')
  detail(
    @Param('customerId') customerId: string,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.service.getCustomerDetail(customerId, request.authorization!);
  }

  // Manual add/deduct. `reason` and `operationKey` are required; the actor
  // is taken from the authenticated request (never the body); the resulting
  // balance can never go below zero; a repeated operationKey is idempotent.
  @RequirePermission('loyalty.adjust')
  @Post('customers/:customerId/adjustments')
  adjust(
    @Param('customerId') customerId: string,
    @Body() body: AdminAdjustMochaBeansRequest,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.service.adjust(
      customerId,
      body,
      request.internalUser!.id,
      request.authorization!,
    );
  }

  // --- Milestone 7B: earning-rate settings ----------------------

  @RequirePermission('loyalty.configure')
  @Get('settings')
  getSettings(@Req() request: InternalAuthenticatedRequest) {
    return this.settings.getSettings(request.authorization!);
  }

  @RequirePermission('loyalty.configure')
  @Put('settings')
  updateSettings(
    @Body() body: UpdateLoyaltySettingsRequest,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.settings.updateEarningRate(
      body?.earningRatePerDollar,
      request.internalUser!.id,
      request.authorization!,
    );
  }

  // --- Milestone 7B: Rewards Catalog ---------------------------

  @RequirePermission('loyalty.configure')
  @Get('rewards')
  listRewards(@Req() request: InternalAuthenticatedRequest) {
    return this.rewards.listAdminRewards(request.authorization!);
  }

  @RequirePermission('loyalty.configure')
  @Get('catalog-options')
  catalogOptions(@Req() request: InternalAuthenticatedRequest) {
    return this.rewards.getCatalogOptions(request.authorization!);
  }

  @RequirePermission('loyalty.configure')
  @Post('rewards')
  createReward(
    @Body() body: CreateLoyaltyRewardRequest,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.rewards.createReward(
      body,
      request.internalUser!.id,
      request.authorization!,
    );
  }

  @RequirePermission('loyalty.configure')
  @Patch('rewards/:rewardId')
  updateReward(
    @Param('rewardId') rewardId: string,
    @Body() body: UpdateLoyaltyRewardRequest,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.rewards.updateReward(
      rewardId,
      body,
      request.internalUser!.id,
      request.authorization!,
    );
  }
}
