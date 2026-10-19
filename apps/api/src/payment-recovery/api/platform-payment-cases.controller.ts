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
  PlatformPaymentCaseDetail,
  PlatformPaymentCaseListResponse,
  PlatformPaymentCaseRecoverResponse,
} from '@mocha-house/contracts';
import { PlatformAuthGuard } from '../../platform-auth/infrastructure/platform-auth.guard';
import { RequirePlatformPermission } from '../../platform-auth/authorization/platform-permission.guard';
import type { PlatformAuthenticatedRequest } from '../../platform-auth/infrastructure/platform-identity';
import { assertRecentSignIn } from '../../platform-tenants/application/tenant-lifecycle.service';
import { RateLimit } from '../../rate-limit/rate-limit.decorator';
import { RateLimitGuard } from '../../rate-limit/rate-limit.guard';
import {
  parseNoteRequest,
  parsePaymentCaseQuery,
  parseRecoverRequest,
  PaymentCaseInputError,
} from '../application/payment-case-query';
import { PlatformPaymentCasesService } from '../application/platform-payment-cases.service';

// ESP-03 PR 5 — restaurant payment reconciliation support in the Platform
// Console. Every route: an ACTIVE platform operator (PlatformAuthGuard,
// re-read on every request). Reading needs a GRANTED
// payments.reconciliation.view; a recovery request or a note needs
// payments.reconciliation.manage and a recent sign-in (both re-read on every
// request; a refusal is audited). Business staff and customers never reach
// these routes, and no TenantContext is established for them.
@UseGuards(PlatformAuthGuard)
@Controller('api/v1/platform/payment-cases')
export class PlatformPaymentCasesController {
  constructor(private readonly cases: PlatformPaymentCasesService) {}

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-onboarding-report')
  @Header('Cache-Control', 'no-store')
  @RequirePlatformPermission('payments.reconciliation.view')
  @Get()
  list(
    @Query() query: Record<string, unknown>,
  ): Promise<PlatformPaymentCaseListResponse> {
    return this.cases.list(parsed(() => parsePaymentCaseQuery(query)));
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-onboarding-report')
  @Header('Cache-Control', 'no-store')
  @RequirePlatformPermission('payments.reconciliation.view')
  @Get(':caseId')
  detail(@Param('caseId') caseId: string): Promise<PlatformPaymentCaseDetail> {
    return this.cases.detail(caseId);
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @RequirePlatformPermission('payments.reconciliation.manage')
  @Post(':caseId/recover')
  recover(
    @Param('caseId') caseId: string,
    @Body() body: unknown,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformPaymentCaseRecoverResponse> {
    assertRecentSignIn(request.platformIdentity);
    const { reason } = parsed(() => parseRecoverRequest(body));
    return this.cases.recover(
      caseId,
      reason,
      request.platformOperator!,
      request.requestId,
    );
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @RequirePlatformPermission('payments.reconciliation.manage')
  @Post(':caseId/notes')
  addNote(
    @Param('caseId') caseId: string,
    @Body() body: unknown,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformPaymentCaseDetail> {
    assertRecentSignIn(request.platformIdentity);
    const note = parsed(() => parseNoteRequest(body));
    return this.cases.addNote(
      caseId,
      note.body,
      request.platformOperator!,
      request.requestId,
    );
  }
}

function parsed<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof PaymentCaseInputError) {
      throw new BadRequestException(error.message);
    }
    throw error;
  }
}
