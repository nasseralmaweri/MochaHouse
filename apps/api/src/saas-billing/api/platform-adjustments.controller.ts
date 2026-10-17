import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type {
  PlatformAdjustableInvoice,
  PlatformAdjustmentListResponse,
  PlatformAdjustmentPreview,
  PlatformAdjustmentView,
} from '@mocha-house/contracts';
import { PlatformAuthGuard } from '../../platform-auth/infrastructure/platform-auth.guard';
import { RequirePlatformPermission } from '../../platform-auth/authorization/platform-permission.guard';
import type { PlatformAuthenticatedRequest } from '../../platform-auth/infrastructure/platform-identity';
import { RateLimit } from '../../rate-limit/rate-limit.decorator';
import { RateLimitGuard } from '../../rate-limit/rate-limit.guard';
import { assertRecentSignIn } from '../../platform-tenants/application/tenant-lifecycle.service';
import {
  BillingAdjustmentsService,
  parseAdjustmentInput,
  parseNote,
} from '../application/billing-adjustments.service';

// SC3e-3 — refunds and credits on a business's CENTERIVO invoices (owner
// decisions D1–D3). Requests need billing.adjustments.request, decisions and
// resolving billing.adjustments.approve (both re-read on every request);
// every change a recent sign-in, rate limited and audited. Reads are open to
// any operator (as the invoice history is).
@UseGuards(PlatformAuthGuard)
@Controller('api/v1/platform')
export class PlatformAdjustmentsController {
  constructor(private readonly adjustments: BillingAdjustmentsService) {}

  @Header('Cache-Control', 'no-store')
  @Get('billing/adjustments')
  list(
    @Query('status') status: unknown,
  ): Promise<PlatformAdjustmentListResponse> {
    if (status !== undefined && status !== 'OPEN' && status !== 'ALL') {
      throw new BadRequestException('status must be OPEN or ALL.');
    }
    return this.adjustments.list({ status: status === 'ALL' ? 'ALL' : 'OPEN' });
  }

  @Header('Cache-Control', 'no-store')
  @Get('billing/adjustments/:adjustmentId')
  detail(
    @Param('adjustmentId') adjustmentId: string,
  ): Promise<PlatformAdjustmentView> {
    return this.adjustments.detail(adjustmentId);
  }

  @Header('Cache-Control', 'no-store')
  @Get('tenants/:tenantId/billing/adjustments')
  listForTenant(
    @Param('tenantId') tenantId: string,
  ): Promise<PlatformAdjustmentListResponse> {
    return this.adjustments.list({ tenantId });
  }

  // The invoice as Stripe holds it now (read live; nothing changed).
  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @RequirePlatformPermission('billing.adjustments.request')
  @Get('tenants/:tenantId/billing/invoices/:invoiceId/adjustable')
  adjustable(
    @Param('tenantId') tenantId: string,
    @Param('invoiceId') invoiceId: string,
  ): Promise<PlatformAdjustableInvoice> {
    return this.adjustments.adjustableInvoice(tenantId, invoiceId);
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @RequirePlatformPermission('billing.adjustments.request')
  @Post('tenants/:tenantId/billing/invoices/:invoiceId/adjustments/preview')
  preview(
    @Param('tenantId') tenantId: string,
    @Param('invoiceId') invoiceId: string,
    @Body() body: unknown,
  ): Promise<PlatformAdjustmentPreview> {
    return this.adjustments.preview(
      tenantId,
      invoiceId,
      parseAdjustmentInput(body, false),
    );
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @HttpCode(201)
  @RequirePlatformPermission('billing.adjustments.request')
  @Post('tenants/:tenantId/billing/invoices/:invoiceId/adjustments')
  request(
    @Param('tenantId') tenantId: string,
    @Param('invoiceId') invoiceId: string,
    @Body() body: unknown,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformAdjustmentView> {
    assertRecentSignIn(request.platformIdentity);
    const input = parseAdjustmentInput(body, true);
    return this.adjustments.request(
      tenantId,
      invoiceId,
      { ...input, reason: input.reason! },
      request.platformOperator!,
      request.requestId,
    );
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @RequirePlatformPermission('billing.adjustments.approve')
  @Post('billing/adjustments/:adjustmentId/approve')
  approve(
    @Param('adjustmentId') adjustmentId: string,
    @Body() body: unknown,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformAdjustmentView> {
    assertRecentSignIn(request.platformIdentity);
    return this.adjustments.decide(
      adjustmentId,
      'APPROVED',
      parseNote(body),
      request.platformOperator!,
      request.requestId,
    );
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @RequirePlatformPermission('billing.adjustments.approve')
  @Post('billing/adjustments/:adjustmentId/reject')
  reject(
    @Param('adjustmentId') adjustmentId: string,
    @Body() body: unknown,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformAdjustmentView> {
    assertRecentSignIn(request.platformIdentity);
    return this.adjustments.decide(
      adjustmentId,
      'REJECTED',
      parseNote(body),
      request.platformOperator!,
      request.requestId,
    );
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @RequirePlatformPermission('billing.adjustments.request')
  @Post('billing/adjustments/:adjustmentId/cancel')
  cancel(
    @Param('adjustmentId') adjustmentId: string,
    @Body() body: unknown,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformAdjustmentView> {
    assertRecentSignIn(request.platformIdentity);
    return this.adjustments.cancel(
      adjustmentId,
      parseNote(body),
      request.platformOperator!,
      request.requestId,
    );
  }

  // A reviewed adjustment Stripe holds no credit note for: closed as not
  // issued (only after Stripe is read again).
  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @RequirePlatformPermission('billing.adjustments.approve')
  @Post('billing/adjustments/:adjustmentId/resolve-not-issued')
  resolveNotIssued(
    @Param('adjustmentId') adjustmentId: string,
    @Body() body: unknown,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformAdjustmentView> {
    assertRecentSignIn(request.platformIdentity);
    return this.adjustments.resolveNotIssued(
      adjustmentId,
      parseNote(body),
      request.platformOperator!,
      request.requestId,
    );
  }
}
