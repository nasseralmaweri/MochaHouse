import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type {
  InternalNewPasswordRequest,
  InternalSignInChallengeResponse,
  InternalSignInRequest,
  InternalSignInResponse,
} from '@mocha-house/contracts';
import { RateLimit } from '../../rate-limit/rate-limit.decorator';
import { RateLimitGuard } from '../../rate-limit/rate-limit.guard';
import { InternalSignInService } from '../application/internal-sign-in.service';

// Bounds on what is passed to the identity provider (it applies its own
// password policy; these only refuse absurd input before any call).
const SESSION_MAX_LENGTH = 4096;
const PASSWORD_MAX_LENGTH = 256;

// The internal-auth namespace, kept separate from the customer
// /api/v1/auth/* controller. Sign-in only mints an internal identity token
// — it performs no InternalUser lifecycle check (that is InternalAuthGuard,
// on every protected request). There is deliberately no internal
// self-registration or password-recovery flow here: internal users are
// added by an administrator (V1 launch fix 2: Administration → Users), whose
// invitation the identity provider sends; their first sign-in sets their
// own password (new-password below).
@Controller('api/v1/internal/auth')
export class InternalAuthController {
  constructor(private readonly signInService: InternalSignInService) {}

  @UseGuards(RateLimitGuard)
  @RateLimit('internal-sign-in')
  @Post('sign-in')
  async signIn(
    @Body() body: InternalSignInRequest,
  ): Promise<InternalSignInResponse | InternalSignInChallengeResponse> {
    if (
      typeof body?.identifier !== 'string' ||
      body.identifier.trim().length === 0 ||
      typeof body?.password !== 'string' ||
      body.password.length === 0
    ) {
      throw new BadRequestException('identifier and password are required.');
    }

    const result = await this.signInService.signIn(body);

    if (result.outcome === 'new-password-required') {
      // The temporary password was right; the person now chooses their own.
      return { challenge: 'NEW_PASSWORD_REQUIRED', session: result.session };
    }
    if (result.outcome !== 'success') {
      // Same message regardless of why (unknown user vs. wrong password).
      throw new UnauthorizedException('Invalid email or password.');
    }

    return {
      idToken: result.idToken,
      expiresInSeconds: result.expiresInSeconds,
    };
  }

  // V1 launch fix 2 — answer the first-sign-in challenge with the person's
  // own new password (straight to the identity provider; never stored or
  // logged). Same rate limit as sign-in, keyed by the same identifier.
  @UseGuards(RateLimitGuard)
  @RateLimit('internal-sign-in')
  @HttpCode(200)
  @Post('new-password')
  async newPassword(
    @Body() body: InternalNewPasswordRequest,
  ): Promise<InternalSignInResponse> {
    if (
      typeof body?.identifier !== 'string' ||
      body.identifier.trim().length === 0 ||
      typeof body?.session !== 'string' ||
      body.session.length === 0 ||
      body.session.length > SESSION_MAX_LENGTH ||
      typeof body?.newPassword !== 'string' ||
      body.newPassword.length === 0 ||
      body.newPassword.length > PASSWORD_MAX_LENGTH
    ) {
      throw new BadRequestException(
        'identifier, session and newPassword are required.',
      );
    }

    const result = await this.signInService.completeNewPassword({
      identifier: body.identifier.trim(),
      session: body.session,
      newPassword: body.newPassword,
    });

    if (result.outcome === 'invalid-password') {
      throw new BadRequestException(
        'Choose a stronger password: at least 12 characters, with upper- and lower-case letters, a number and a symbol.',
      );
    }
    if (result.outcome === 'session-expired') {
      throw new UnauthorizedException(
        'This password setup has expired. Sign in again with the temporary password from your email.',
      );
    }
    return {
      idToken: result.idToken,
      expiresInSeconds: result.expiresInSeconds,
    };
  }
}
