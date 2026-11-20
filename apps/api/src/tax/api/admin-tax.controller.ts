import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import type {
  AdminLocationTaxResponse,
  AdminTaxCategory,
  AdminTaxClass,
  AdminTaxProduct,
  AdminTaxSettingsResponse,
  ConfirmLocationTaxDraftRequest,
  SaveLocationTaxDraftRequest,
  SaveTaxClassRequest,
  SetCategoryTaxClassRequest,
  SetProductTaxClassRequest,
} from '@mocha-house/contracts';
import type { TenantContext } from '@mocha-house/database';
import { CurrentTenantContext } from '../../tenancy/current-tenant-context.decorator';
import { InternalAuthGuard } from '../../internal-auth/infrastructure/internal-auth.guard';
import { PermissionGuard } from '../../internal-auth/authorization/permission.guard';
import { RequirePermission } from '../../internal-auth/authorization/require-permission.decorator';
import type { InternalAuthenticatedRequest } from '../../internal-auth/infrastructure/internal-identity';
import { TaxSettingsService } from '../application/tax-settings.service';

// V1 Sales Tax PR 1 — Admin > Sales tax. The business's authorized
// administrator only: tax.manage (guard + corporate scope, re-checked here)
// AND the business's built-in administrator role (service, from the
// database). Store Managers are refused. The business always comes from the
// request's tenant context, never from the body or the path.
@UseGuards(InternalAuthGuard, PermissionGuard)
@Controller('api/v1/admin/tax')
export class AdminTaxController {
  constructor(private readonly tax: TaxSettingsService) {}

  @RequirePermission('tax.manage')
  @Header('Cache-Control', 'no-store')
  @Get('settings')
  async settings(
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ): Promise<AdminTaxSettingsResponse> {
    await this.administrator(request, tenant);
    return this.tax.settings(tenant.tenantId);
  }

  @RequirePermission('tax.manage')
  @Post('classes')
  async createClass(
    @Body() body: SaveTaxClassRequest,
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ): Promise<AdminTaxClass> {
    await this.administrator(request, tenant);
    return this.tax.createClass(
      tenant.tenantId,
      request.internalUser!.id,
      body?.name,
    );
  }

  @RequirePermission('tax.manage')
  @Patch('classes/:taxClassId')
  async renameClass(
    @Param('taxClassId') taxClassId: string,
    @Body() body: SaveTaxClassRequest,
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ): Promise<AdminTaxClass> {
    await this.administrator(request, tenant);
    return this.tax.renameClass(
      tenant.tenantId,
      request.internalUser!.id,
      taxClassId,
      body?.name,
    );
  }

  @RequirePermission('tax.manage')
  @Put('categories/:categoryId')
  async classifyCategory(
    @Param('categoryId') categoryId: string,
    @Body() body: SetCategoryTaxClassRequest,
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ): Promise<AdminTaxCategory> {
    await this.administrator(request, tenant);
    return this.tax.classifyCategory(
      tenant.tenantId,
      request.internalUser!.id,
      categoryId,
      body?.taxClassId,
    );
  }

  @RequirePermission('tax.manage')
  @Put('products/:productId')
  async setProductClass(
    @Param('productId') productId: string,
    @Body() body: SetProductTaxClassRequest,
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ): Promise<AdminTaxProduct> {
    await this.administrator(request, tenant);
    return this.tax.setProductClass(
      tenant.tenantId,
      request.internalUser!.id,
      productId,
      body?.taxClassId === undefined ? undefined : body.taxClassId,
    );
  }

  @RequirePermission('tax.manage')
  @Header('Cache-Control', 'no-store')
  @Get('locations/:locationId')
  async location(
    @Param('locationId') locationId: string,
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ): Promise<AdminLocationTaxResponse> {
    await this.administrator(request, tenant);
    return this.tax.location(tenant.tenantId, locationId);
  }

  @RequirePermission('tax.manage')
  @Put('locations/:locationId/draft')
  async saveDraft(
    @Param('locationId') locationId: string,
    @Body() body: SaveLocationTaxDraftRequest,
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ): Promise<AdminLocationTaxResponse> {
    await this.administrator(request, tenant);
    return this.tax.saveDraft(
      tenant.tenantId,
      request.internalUser!.id,
      locationId,
      body?.components,
    );
  }

  @RequirePermission('tax.manage')
  @Delete('locations/:locationId/draft')
  async discardDraft(
    @Param('locationId') locationId: string,
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ): Promise<AdminLocationTaxResponse> {
    await this.administrator(request, tenant);
    return this.tax.discardDraft(
      tenant.tenantId,
      request.internalUser!.id,
      locationId,
    );
  }

  @RequirePermission('tax.manage')
  @HttpCode(200)
  @Post('locations/:locationId/draft/confirm')
  async confirmDraft(
    @Param('locationId') locationId: string,
    @Body() body: ConfirmLocationTaxDraftRequest,
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ): Promise<AdminLocationTaxResponse> {
    await this.administrator(request, tenant);
    return this.tax.confirmDraft(
      tenant.tenantId,
      request.internalUser!.id,
      locationId,
      body,
    );
  }

  private async administrator(
    request: InternalAuthenticatedRequest,
    tenant: TenantContext,
  ): Promise<void> {
    request.authorization!.assertCorporate('tax.manage');
    await this.tax.assertAuthorizedAdministrator(
      tenant.tenantId,
      request.internalUser!.id,
    );
  }
}
