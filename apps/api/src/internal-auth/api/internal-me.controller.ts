import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { InternalUserProfile } from '@mocha-house/contracts';
import { InternalAuthGuard } from '../infrastructure/internal-auth.guard';
import type { InternalAuthenticatedRequest } from '../infrastructure/internal-identity';
import { InternalUsersService } from '../application/internal-users.service';

// Proves the whole internal boundary end to end: a verified internal
// identity that maps to an ACTIVE Mocha House InternalUser. InternalAuthGuard
// has already rejected every other case (no token, bad token, unknown
// identity, INVITED/SUSPENDED/DISABLED) before this handler runs, so
// request.internalUser is always present and ACTIVE here.
@Controller('api/v1/internal')
export class InternalMeController {
  constructor(private readonly internalUsers: InternalUsersService) {}

  @UseGuards(InternalAuthGuard)
  @Get('me')
  me(@Req() request: InternalAuthenticatedRequest): InternalUserProfile {
    return this.internalUsers.toProfile(request.internalUser!);
  }
}
