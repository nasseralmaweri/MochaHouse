import { Injectable } from '@nestjs/common';
import { isDevInternalAuthEnabled } from '../../internal-auth/infrastructure/internal-auth-provider-mode';
import { CognitoStaffLoginProvider } from './cognito-staff-login.provider';
import { LocalDevStaffLoginProvider } from './local-dev-staff-login.provider';
import type {
  StaffLoginInvitationOutcome,
  StaffLoginProvider,
} from './staff-login-provider';

// The staff login provider for THIS call, chosen fresh each time by the same
// fail-closed switch as staff sign-in (internal-auth-provider-mode.ts): the
// local stand-in only in a verified safe dev/test context with
// INTERNAL_AUTH_PROVIDER=dev; Cognito everywhere else, production included.
@Injectable()
export class SelectedStaffLoginProvider implements StaffLoginProvider {
  constructor(
    private readonly cognito: CognitoStaffLoginProvider,
    private readonly localDev: LocalDevStaffLoginProvider,
  ) {}

  private current(): StaffLoginProvider {
    return isDevInternalAuthEnabled() ? this.localDev : this.cognito;
  }

  get providerName(): string {
    return this.current().providerName;
  }

  inviteLogin(input: {
    email: string;
    displayName: string;
  }): Promise<StaffLoginInvitationOutcome> {
    return this.current().inviteLogin(input);
  }
}
