import type { Request } from 'express';

// What the customer-auth boundary proves about an incoming request, once a
// token has been successfully verified — deliberately just a few plain
// strings, never a Cognito SDK payload/claims object, so nothing downstream
// (CustomersService, controllers) ever depends on Cognito's token shape.
export interface CustomerIdentity {
  provider: string;
  subject: string;
  email: string | null;
  name: string | null;
  // The provider's own authoritative signal for whether this identity's
  // email is confirmed — read straight off the verified token (Cognito's
  // standard `email_verified` claim), never re-derived from a Mocha House
  // lookup. null means the provider didn't assert either way (never
  // treated as true). Required, not optional, so every call site has to
  // consciously decide this rather than silently defaulting — see
  // CustomersService.resolveOrCreateFromIdentity for how it's used.
  emailVerified: boolean | null;
}

export interface CustomerAuthenticatedRequest extends Request {
  customerIdentity?: CustomerIdentity;
}
