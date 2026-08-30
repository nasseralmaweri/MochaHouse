import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import type {
  InternalSignInRequest,
  InternalSignInResponse,
} from '@mocha-house/contracts';
import { InternalSignInService } from '../application/internal-sign-in.service';

// The internal-auth namespace, kept separate from the customer
// /api/v1/auth/* controller. Sign-in only mints an internal identity token
// — it performs no InternalUser lifecycle check (that is InternalAuthGuard,
// on every protected request). There is deliberately no internal
// self-registration, verification, or password-recovery flow: internal
// users are provisioned administratively (Milestone 5B).
@Controller('api/v1/internal/auth')
export class InternalAuthController {
  constructor(private readonly signInService: InternalSignInService) {}

  @Post('sign-in')
  async signIn(
    @Body() body: InternalSignInRequest,
  ): Promise<InternalSignInResponse> {
    if (
      typeof body?.identifier !== 'string' ||
      body.identifier.trim().length === 0 ||
      typeof body?.password !== 'string' ||
      body.password.length === 0
    ) {
      throw new BadRequestException('identifier and password are required.');
    }

    const result = await this.signInService.signIn(body);

    if (result.outcome !== 'success') {
      // Same message regardless of why (unknown user vs. wrong password).
      throw new UnauthorizedException('Invalid email or password.');
    }

    return {
      idToken: result.idToken,
      expiresInSeconds: result.expiresInSeconds,
    };
  }
}
