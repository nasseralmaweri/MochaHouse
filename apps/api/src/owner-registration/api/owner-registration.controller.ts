import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  NotFoundException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  OWNER_REGISTRATION_INVALID_INPUT,
  OWNER_REGISTRATION_WEAK_PASSWORD,
  type OwnerRegistrationAvailability,
  type OwnerRegistrationCompleteResponse,
  type OwnerRegistrationStartResponse,
} from '@mocha-house/contracts';
import { RateLimit } from '../../rate-limit/rate-limit.decorator';
import { RateLimitGuard } from '../../rate-limit/rate-limit.guard';
import type { TenantContextRequest } from '../../tenancy/tenant-context-request';
import {
  ownerRegistrationAvailability,
  ownerRegistrationConfig,
  type OwnerRegistrationConfig,
} from '../application/owner-registration.config';
import {
  OwnerRegistrationInputError,
  OwnerRegistrationPasswordError,
  parseCompleteRequest,
  parseStartRequest,
} from '../application/owner-registration-request';
import { OwnerRegistrationService } from '../application/owner-registration.service';

// SC4a — business owner self-service registration. Public (no session), and
// under /api/v1/internal so it belongs to no business: the deployment's
// storefront tenant never applies (TenancyModule excludes these routes).
// Every route but the availability probe answers 404 unless the deployment
// enabled registration (SELF_SERVICE_REGISTRATION_ENABLED) — checked here, on
// every request, never left to the web app.
function enabledConfig(): OwnerRegistrationConfig {
  const config = ownerRegistrationConfig();
  if (!config) throw new NotFoundException();
  return config;
}

function badRequest(code: string, message: string): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code,
    message,
  });
}

function asBadRequest(error: unknown): never {
  if (error instanceof OwnerRegistrationPasswordError) {
    throw badRequest(OWNER_REGISTRATION_WEAK_PASSWORD, error.message);
  }
  if (error instanceof OwnerRegistrationInputError) {
    throw badRequest(OWNER_REGISTRATION_INVALID_INPUT, error.message);
  }
  throw error;
}

@Controller('api/v1/internal/registration')
export class OwnerRegistrationController {
  constructor(private readonly registrations: OwnerRegistrationService) {}

  // Whether to offer registration, and the legal versions to show.
  @Header('Cache-Control', 'no-store')
  @Get()
  availability(): OwnerRegistrationAvailability {
    return ownerRegistrationAvailability();
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('owner-registration')
  @Header('Cache-Control', 'no-store')
  @HttpCode(202)
  @Post('start')
  async start(@Body() body: unknown): Promise<OwnerRegistrationStartResponse> {
    const config = enabledConfig();
    let email: string;
    try {
      ({ email } = parseStartRequest(body));
    } catch (error) {
      asBadRequest(error);
    }
    await this.registrations.start(config, email);
    return { status: 'CODE_SENT_IF_ELIGIBLE' };
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('owner-registration-verification')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @Post('complete')
  async complete(
    @Body() body: unknown,
    @Req() request: TenantContextRequest,
  ): Promise<OwnerRegistrationCompleteResponse> {
    const config = enabledConfig();
    let input: ReturnType<typeof parseCompleteRequest>;
    try {
      input = parseCompleteRequest(body);
    } catch (error) {
      asBadRequest(error);
    }
    await this.registrations.complete(config, input, request.requestId);
    return { status: 'VERIFIED' };
  }
}
