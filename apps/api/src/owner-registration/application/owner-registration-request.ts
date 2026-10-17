import { parseOwnerEmail } from '../../platform-tenants/application/tenant-provision-request';

// SC4a — the registration requests, validated and normalised. Anything
// outside these rules is refused (400), never coerced.

export class OwnerRegistrationInputError extends Error {}
export class OwnerRegistrationPasswordError extends Error {}

export interface CompleteRegistrationInput {
  email: string;
  code: string;
  password: string;
  displayName: string;
  termsVersion: string;
  privacyVersion: string;
}

const DISPLAY_NAME_MAX = 120;
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 256;
const CODE_PATTERN = /^[0-9]{4,10}$/;
// Cognito's own special-character set, so a password accepted here is
// accepted by a pool whose policy requires every character class.
const PASSWORD_SYMBOL = /[\^$*.[\]{}()?"!@#%&/\\,><':;|_~`=+-]/;

function body(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new OwnerRegistrationInputError('A JSON body is required.');
  }
  return raw as Record<string, unknown>;
}

function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

// The provisioning owner-email rule: trimmed, lowercased, a plain address.
export function parseRegistrationEmail(raw: unknown): string {
  try {
    return parseOwnerEmail(raw);
  } catch {
    throw new OwnerRegistrationInputError('Enter a valid email address.');
  }
}

export function parseStartRequest(raw: unknown): { email: string } {
  return { email: parseRegistrationEmail(body(raw).email) };
}

// At least 12 characters with a lowercase and an uppercase letter, a digit
// and a symbol — at least as strict as the staff pool's policy must be.
export function passwordProblem(password: string): string | null {
  if (
    password.length < PASSWORD_MIN ||
    password.length > PASSWORD_MAX ||
    password.trim() !== password ||
    !/[a-z]/.test(password) ||
    !/[A-Z]/.test(password) ||
    !/[0-9]/.test(password) ||
    !PASSWORD_SYMBOL.test(password)
  ) {
    return `Use ${PASSWORD_MIN}–${PASSWORD_MAX} characters with an uppercase and a lowercase letter, a number and a symbol.`;
  }
  return null;
}

export function parseCompleteRequest(raw: unknown): CompleteRegistrationInput {
  const input = body(raw);
  const email = parseRegistrationEmail(input.email);

  const code = typeof input.code === 'string' ? input.code.trim() : '';
  if (!CODE_PATTERN.test(code)) {
    throw new OwnerRegistrationInputError('Enter the code from the email.');
  }

  const displayName =
    typeof input.displayName === 'string'
      ? input.displayName.trim().replace(/\s+/g, ' ')
      : '';
  if (
    displayName.length < 1 ||
    displayName.length > DISPLAY_NAME_MAX ||
    hasControlCharacters(displayName)
  ) {
    throw new OwnerRegistrationInputError(
      `Enter your name (at most ${DISPLAY_NAME_MAX} characters).`,
    );
  }

  if (input.acceptLegal !== true) {
    throw new OwnerRegistrationInputError(
      'Accept the Terms of Service and Privacy Policy to continue.',
    );
  }
  if (
    typeof input.termsVersion !== 'string' ||
    typeof input.privacyVersion !== 'string'
  ) {
    throw new OwnerRegistrationInputError(
      'Accept the Terms of Service and Privacy Policy to continue.',
    );
  }

  const password = typeof input.password === 'string' ? input.password : '';
  const problem = passwordProblem(password);
  if (problem) throw new OwnerRegistrationPasswordError(problem);

  return {
    email,
    code,
    password,
    displayName,
    termsVersion: input.termsVersion,
    privacyVersion: input.privacyVersion,
  };
}
