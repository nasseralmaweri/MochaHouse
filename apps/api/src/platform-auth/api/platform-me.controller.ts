import {
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { PlatformMeResponse } from '@mocha-house/contracts';
import { PlatformOperatorsService } from '../application/platform-operators.service';
import { PlatformAuthGuard } from '../infrastructure/platform-auth.guard';
import type { PlatformAuthenticatedRequest } from '../infrastructure/platform-identity';

// SC1a — the platform boundary end to end: a verified platform identity
// that maps to an ACTIVE PlatformOperator. PlatformAuthGuard has already
// refused every other case, so request.platformOperator is present and
// ACTIVE here.
@Controller('api/v1/platform')
export class PlatformMeController {
  constructor(private readonly operators: PlatformOperatorsService) {}

  @UseGuards(PlatformAuthGuard)
  @Header('Cache-Control', 'no-store')
  @Get('me')
  me(@Req() request: PlatformAuthenticatedRequest): PlatformMeResponse {
    return this.operators.profile(request.platformOperator!);
  }

  // SC1b — sign-out. Records the end of the session; the web tier then
  // deletes its HttpOnly cookie. (A Cognito ID token cannot be revoked; it
  // simply stops being presented and expires within the hour.)
  @UseGuards(PlatformAuthGuard)
  @HttpCode(204)
  @Post('session/sign-out')
  async signOut(@Req() request: PlatformAuthenticatedRequest): Promise<void> {
    await this.operators.recordSessionEnded(
      request.platformOperator!,
      request.requestId,
    );
  }
}
