import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Header,
  HttpCode,
  Logger,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type {
  PlatformChallengeCodeRequest,
  PlatformChallengeRequest,
  PlatformMfaSetupDisplayResponse,
  PlatformMfaSetupResponse,
  PlatformSessionResponse,
  PlatformSignInRequest,
  PlatformSignInStepResponse,
} from '@mocha-house/contracts';
import { RateLimit } from '../../rate-limit/rate-limit.decorator';
import { RateLimitGuard } from '../../rate-limit/rate-limit.guard';
import {
  PlatformSignInFailed,
  PlatformSignInService,
} from '../application/platform-sign-in.service';
import { PlatformAuthNotConfiguredError } from '../infrastructure/platform-config';
import type { PlatformAuthenticatedRequest } from '../infrastructure/platform-identity';
import { isChallengeHandle } from '../sign-in/platform-challenge-store';
import { PlatformSignInRefusedError } from '../sign-in/platform-sign-in.types';
import { isSixDigitCode } from '../sign-in/platform-totp';

// SC1b — the platform-operator sign-in API. Called ONLY by the web tier's
// server actions (never by browser JavaScript); the session token it
// returns is stored by the web tier in an HttpOnly cookie.
//
//   POST sign-in           email + password -> a challenge handle (never a
//                          token: the second factor is always required)
//   POST mfa               handle + TOTP code -> session token
//   POST mfa-setup         handle -> authenticator secret + a new handle
//   POST mfa-setup/verify  handle + first TOTP code -> session token
//
// Every answer is generic: no Cognito error text, no hint whether an email
// exists, whether the password or the code was wrong, or why an account is
// not permitted. Rate limited per email and per client.
const INVALID_CREDENTIALS = 'Invalid email or password.';
const RESTART =
  'That code was not accepted, or the sign-in expired. Sign in again.';
const ACCOUNT_SETUP =
  'This account is not ready to sign in. Contact a CENTERIVO administrator.';
const NOT_PERMITTED =
  'This account is not permitted to access the platform area.';
const UNAVAILABLE = 'Platform sign-in is not available right now.';

@Controller('api/v1/platform/auth')
export class PlatformAuthController {
  private readonly logger = new Logger(PlatformAuthController.name);

  constructor(private readonly signIn: PlatformSignInService) {}

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-sign-in')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @Post('sign-in')
  start(
    @Body() body: PlatformSignInRequest,
  ): Promise<PlatformSignInStepResponse> {
    if (
      typeof body?.email !== 'string' ||
      body.email.trim().length === 0 ||
      body.email.length > 320 ||
      typeof body?.password !== 'string' ||
      body.password.length === 0 ||
      body.password.length > 256
    ) {
      throw new BadRequestException('Email and password are required.');
    }
    return this.run(() => this.signIn.start(body.email, body.password));
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-mfa')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @Post('mfa')
  mfa(
    @Body() body: PlatformChallengeCodeRequest,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformSessionResponse> {
    const { challenge, code } = this.challengeAndCode(body);
    return this.run(() =>
      this.signIn.respondToMfa(challenge, code, request.requestId),
    );
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-mfa')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @Post('mfa-setup')
  mfaSetup(
    @Body() body: PlatformChallengeRequest,
  ): Promise<PlatformMfaSetupResponse> {
    if (!isChallengeHandle(body?.challenge)) {
      throw new UnauthorizedException(RESTART);
    }
    return this.run(() => this.signIn.beginMfaSetup(body.challenge));
  }

  // The issued authenticator secret, read by the web tier's setup page on
  // the server. Advances nothing; only for the handle it was issued under.
  @UseGuards(RateLimitGuard)
  @RateLimit('platform-mfa')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @Post('mfa-setup/display')
  mfaSetupDisplay(
    @Body() body: PlatformChallengeRequest,
  ): Promise<PlatformMfaSetupDisplayResponse> {
    if (!isChallengeHandle(body?.challenge)) {
      throw new UnauthorizedException(RESTART);
    }
    return this.run(() => this.signIn.displayMfaSetup(body.challenge));
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-mfa')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @Post('mfa-setup/verify')
  mfaSetupVerify(
    @Body() body: PlatformChallengeCodeRequest,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformSessionResponse> {
    const { challenge, code } = this.challengeAndCode(body);
    return this.run(() =>
      this.signIn.completeMfaSetup(challenge, code, request.requestId),
    );
  }

  private challengeAndCode(body: PlatformChallengeCodeRequest | undefined) {
    if (!isChallengeHandle(body?.challenge)) {
      throw new UnauthorizedException(RESTART);
    }
    if (!isSixDigitCode(body?.code)) {
      throw new BadRequestException('Enter the 6-digit code.');
    }
    return { challenge: body.challenge, code: body.code };
  }

  private async run<T>(step: () => Promise<T>): Promise<T> {
    try {
      return await step();
    } catch (error) {
      if (error instanceof PlatformSignInFailed) {
        switch (error.reason) {
          case 'invalid-credentials':
            throw new UnauthorizedException(INVALID_CREDENTIALS);
          case 'restart':
            throw new UnauthorizedException(RESTART);
          case 'account-setup-required':
            throw new ForbiddenException(ACCOUNT_SETUP);
          case 'not-permitted':
            throw new ForbiddenException(NOT_PERMITTED);
        }
      }
      if (
        error instanceof PlatformSignInRefusedError ||
        error instanceof PlatformAuthNotConfiguredError
      ) {
        // Server-side only: the reason (never a token or credential).
        this.logger.warn(`Platform sign-in refused: ${error.message}`);
        throw new ServiceUnavailableException(UNAVAILABLE);
      }
      throw error;
    }
  }
}
