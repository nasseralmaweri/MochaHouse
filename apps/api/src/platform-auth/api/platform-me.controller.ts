import { Controller, Get, Header, Req, UseGuards } from '@nestjs/common';
import type { PlatformMeResponse } from '@mocha-house/contracts';
import { PlatformOperatorsService } from '../application/platform-operators.service';
import { PlatformAuthGuard } from '../infrastructure/platform-auth.guard';
import type { PlatformAuthenticatedRequest } from '../infrastructure/platform-identity';

// SC1a — the platform boundary end to end: a verified platform identity
// that maps to an ACTIVE PlatformOperator. PlatformAuthGuard has already
// refused every other case, so request.platformOperator is present and
// ACTIVE here. The starting point for the SC1b platform Admin shell.
@Controller('api/v1/platform')
export class PlatformMeController {
  constructor(private readonly operators: PlatformOperatorsService) {}

  @UseGuards(PlatformAuthGuard)
  @Header('Cache-Control', 'no-store')
  @Get('me')
  me(
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformMeResponse> {
    return this.operators.verifySession(
      request.platformOperator!,
      request.requestId,
    );
  }
}
