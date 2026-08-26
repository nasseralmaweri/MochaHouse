import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import type {
  CustomerSignInRequest,
  CustomerSignInResponse,
} from '@mocha-house/contracts';
import { CustomerSignInService } from '../application/customer-sign-in.service';

@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly signInService: CustomerSignInService) {}

  @Post('sign-in')
  async signIn(
    @Body() body: CustomerSignInRequest,
  ): Promise<CustomerSignInResponse> {
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
      // Same message regardless of why (unknown user vs. wrong password) —
      // the response must never reveal which part was wrong.
      throw new UnauthorizedException('Invalid email or password.');
    }

    return {
      idToken: result.idToken,
      expiresInSeconds: result.expiresInSeconds,
    };
  }
}
