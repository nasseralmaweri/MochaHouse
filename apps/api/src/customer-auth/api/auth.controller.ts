import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  NotFoundException,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import type {
  CustomerRegisterRequest,
  CustomerRegisterResponse,
  CustomerResendVerificationRequest,
  CustomerResendVerificationResponse,
  CustomerSignInRequest,
  CustomerSignInResponse,
  CustomerVerifyRequest,
  CustomerVerifyResponse,
} from '@mocha-house/contracts';
import { CustomerSignInService } from '../application/customer-sign-in.service';
import { CustomerRegistrationService } from '../application/customer-registration.service';
import { isDevCustomerAuthEnabled } from '../infrastructure/auth-provider-mode';
import { CustomersService } from '../../customers/application/customers.service';

@Controller('api/v1/auth')
export class AuthController {
  constructor(
    private readonly signInService: CustomerSignInService,
    private readonly registrationService: CustomerRegistrationService,
    private readonly customersService: CustomersService,
  ) {}

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

  @Post('register')
  async register(
    @Body() body: CustomerRegisterRequest,
  ): Promise<CustomerRegisterResponse> {
    const email = typeof body?.email === 'string' ? body.email.trim() : '';
    const displayName =
      typeof body?.displayName === 'string' ? body.displayName.trim() : '';
    const password = typeof body?.password === 'string' ? body.password : '';

    if (!email || !email.includes('@')) {
      throw new BadRequestException('A valid email address is required.');
    }
    if (!displayName) {
      throw new BadRequestException('A name is required.');
    }
    if (!password) {
      throw new BadRequestException('A password is required.');
    }

    const result = await this.registrationService.register({
      email,
      password,
      displayName,
    });

    if (result.outcome === 'already-exists') {
      throw new ConflictException(
        'An account with this email already exists. Try signing in instead.',
      );
    }
    if (result.outcome === 'invalid-password') {
      throw new BadRequestException(
        'Password does not meet the required security policy. Please choose a stronger password.',
      );
    }
    if (result.outcome === 'invalid-input') {
      throw new BadRequestException('Please provide a valid email address.');
    }

    // JIT-creates the Mocha House Customer exactly like sign-in's
    // CustomerAuthGuard flow does for GET /customers/me — the same
    // (externalProvider, externalSubject) key means sign-in later resolves
    // this exact row rather than creating a second one.
    await this.customersService.resolveOrCreateFromIdentity({
      provider: result.provider,
      subject: result.subject,
      email,
      name: displayName,
      // Registration always precedes verification in this flow — the
      // account is definitively not yet confirmed the moment it's
      // created, never assumed otherwise.
      emailVerified: false,
    });

    return { email };
  }

  @Post('verify')
  async verify(
    @Body() body: CustomerVerifyRequest,
  ): Promise<CustomerVerifyResponse> {
    const email = typeof body?.email === 'string' ? body.email.trim() : '';
    const code = typeof body?.code === 'string' ? body.code.trim() : '';

    if (!email || !code) {
      throw new BadRequestException('email and code are required.');
    }

    const result = await this.registrationService.verify({ email, code });

    if (result.outcome === 'invalid-code') {
      throw new BadRequestException(
        'That verification code is incorrect. Please try again.',
      );
    }
    if (result.outcome === 'expired-code') {
      throw new BadRequestException(
        'That verification code has expired. Request a new one and try again.',
      );
    }
    if (result.outcome === 'not-found') {
      throw new NotFoundException(
        "We couldn't find a pending registration for that email.",
      );
    }

    // 'success' and 'already-verified' are normalized identically: both
    // mean the account ends this request verified. Cognito has no
    // dedicated error type for "already confirmed" on ConfirmSignUp (see
    // CognitoRegistrationProvider) — treating it as success rather than an
    // error avoids a confusing failure for a customer who successfully
    // verified moments earlier but retried (e.g. a slow response made them
    // resubmit).
    // AUTH_PROVIDER/NODE_ENV decide which provider is live for this
    // request (see isDevCustomerAuthEnabled) — this mirrors that same
    // choice only to know which (externalProvider, email) pair to look
    // the Customer up under, never to pick a provider for a second time.
    const providerLabel = isDevCustomerAuthEnabled() ? 'dev' : 'cognito';
    const customer = await this.customersService.findByEmailAndProvider(
      providerLabel,
      email,
    );

    if (customer) {
      if (!customer.emailVerifiedAt) {
        await this.customersService.markEmailVerified(customer.id);
      }
      return { email };
    }

    // Cognito has already authoritatively confirmed this account — we
    // only reach here after a 'success' or 'already-verified' provider
    // outcome — but no local Customer row exists for it yet. This is the
    // known registration partial-failure window: SignUp succeeded, but the
    // Customer creation at the end of /auth/register did not (e.g. a
    // crash or DB error in between). There is no safe way to create or
    // bind one here — ConfirmSignUp's response carries no subject, and
    // fetching one back from Cognito would require the privileged
    // AdminGetUser API, which this architecture deliberately does not use
    // (see CustomersService.findByEmailAndProvider). Reported as success
    // rather than "not found": the thing this response is actually about
    // — did the provider confirm the account — is true, and no special
    // recovery step is needed from here. The customer's very next
    // successful sign-in resolves this correctly on its own:
    // CustomerAuthGuard extracts the authoritative subject straight from
    // their verified ID token, and CustomersService.resolveOrCreateFromIdentity
    // JIT-creates the Customer row from it — already stamped verified,
    // since that same token's email_verified claim is true by then.
    return { email };
  }

  @Post('verification/resend')
  async resendVerification(
    @Body() body: CustomerResendVerificationRequest,
  ): Promise<CustomerResendVerificationResponse> {
    const email = typeof body?.email === 'string' ? body.email.trim() : '';
    if (!email) {
      throw new BadRequestException('email is required.');
    }

    const result = await this.registrationService.resendVerification(email);

    if (result.outcome === 'not-found') {
      throw new NotFoundException(
        "We couldn't find a pending registration for that email.",
      );
    }
    if (result.outcome === 'already-verified') {
      throw new ConflictException(
        'This account is already verified. You can sign in.',
      );
    }

    return { email };
  }
}
