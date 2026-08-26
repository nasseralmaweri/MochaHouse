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
}

export interface CustomerAuthenticatedRequest extends Request {
  customerIdentity?: CustomerIdentity;
}
