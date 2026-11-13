import { Injectable } from '@nestjs/common';
import type {
  StaffLoginInvitationOutcome,
  StaffLoginProvider,
} from './staff-login-provider';

// DEV-ONLY / TEST SEAM — selected only where the local internal auth
// provider is (isDevInternalAuthEnabled: a verified safe development or test
// context AND INTERNAL_AUTH_PROVIDER=dev; never in production). The local
// sign-in provider has no credential store and needs no login to be created,
// so an invitation is a no-op that sends nothing. The dev sign-in token
// carries an UNVERIFIED email, so locally an invited person still cannot
// activate by email alone — tests exercise activation with explicitly
// verified identities.
@Injectable()
export class LocalDevStaffLoginProvider implements StaffLoginProvider {
  readonly providerName = 'internal-dev';

  inviteLogin(): Promise<StaffLoginInvitationOutcome> {
    return Promise.resolve({ outcome: 'invited' });
  }
}
