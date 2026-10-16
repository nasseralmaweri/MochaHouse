import { createHash } from 'node:crypto';

// SC1d — the provisioning request, validated and normalised. Anything
// outside these rules is refused (400), never coerced into something else.

export class TenantProvisionRequestError extends Error {}

export interface NormalisedProvisionRequest {
  name: string;
  slug: string;
  ownerEmail: string;
  ownerDisplayName: string | null;
  // SC2a — the PUBLISHED plan version the business starts on.
  planVersionId: string;
}

const NAME_MIN = 2;
const NAME_MAX = 120;
const SLUG_MIN = 3;
const SLUG_MAX = 50;
const EMAIL_MAX = 254;
const DISPLAY_NAME_MAX = 120;

// The database enforces this shape too (Tenant_slug_format).
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// Deliberately simple: one @, no spaces, a dot in the domain. The address
// is proven by the staff sign-in system (a VERIFIED email), not here.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// C0 control characters and DEL.
function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Slugs reserved for the platform's own routes, hosts and brands.
export const RESERVED_TENANT_SLUGS: ReadonlySet<string> = new Set([
  'admin',
  'administrator',
  'api',
  'app',
  'auth',
  'billing',
  'centerivo',
  'help',
  'internal',
  'login',
  'mail',
  'platform',
  'root',
  'settings',
  'signin',
  'sign-in',
  'staff',
  'status',
  'support',
  'system',
  'tenant',
  'tenants',
  'www',
]);

function text(raw: unknown, field: string): string {
  if (typeof raw !== 'string') {
    throw new TenantProvisionRequestError(`${field} is required.`);
  }
  return raw;
}

export function normaliseOwnerEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

// SC1e — the one owner-email rule, shared by provisioning and the owner
// email correction: trimmed, lowercased, a plain address, at most 254.
export function parseOwnerEmail(raw: unknown): string {
  const email = normaliseOwnerEmail(text(raw, 'Owner email'));
  if (email.length > EMAIL_MAX || !EMAIL_PATTERN.test(email)) {
    throw new TenantProvisionRequestError('Owner email is not valid.');
  }
  return email;
}

export function parseProvisionRequest(
  body: unknown,
): NormalisedProvisionRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new TenantProvisionRequestError('A JSON body is required.');
  }
  const input = body as Record<string, unknown>;

  const name = text(input.name, 'Business name').trim().replace(/\s+/g, ' ');
  if (
    name.length < NAME_MIN ||
    name.length > NAME_MAX ||
    hasControlCharacters(name)
  ) {
    throw new TenantProvisionRequestError(
      `Business name must be ${NAME_MIN}–${NAME_MAX} characters.`,
    );
  }

  const slug = text(input.slug, 'Slug').trim().toLowerCase();
  if (
    slug.length < SLUG_MIN ||
    slug.length > SLUG_MAX ||
    !SLUG_PATTERN.test(slug)
  ) {
    throw new TenantProvisionRequestError(
      `Slug must be ${SLUG_MIN}–${SLUG_MAX} lowercase letters or digits, in words joined by single hyphens.`,
    );
  }
  if (RESERVED_TENANT_SLUGS.has(slug)) {
    throw new TenantProvisionRequestError('That slug is reserved.');
  }

  const ownerEmail = parseOwnerEmail(input.ownerEmail);

  let ownerDisplayName: string | null = null;
  if (input.ownerDisplayName !== undefined && input.ownerDisplayName !== null) {
    const value = text(input.ownerDisplayName, 'Owner name')
      .trim()
      .replace(/\s+/g, ' ');
    if (value.length > DISPLAY_NAME_MAX || hasControlCharacters(value)) {
      throw new TenantProvisionRequestError(
        `Owner name must be at most ${DISPLAY_NAME_MAX} characters.`,
      );
    }
    ownerDisplayName = value.length > 0 ? value : null;
  }

  // SC2a — a new business must start on a plan (checked as PUBLISHED in
  // the provisioning transaction).
  if (
    typeof input.planVersionId !== 'string' ||
    !UUID_PATTERN.test(input.planVersionId)
  ) {
    throw new TenantProvisionRequestError('Choose a plan for the business.');
  }

  return {
    name,
    slug,
    ownerEmail,
    ownerDisplayName,
    planVersionId: input.planVersionId,
  };
}

export function parseIdempotencyKey(raw: unknown): string {
  if (typeof raw !== 'string' || !UUID_PATTERN.test(raw)) {
    throw new TenantProvisionRequestError(
      'An Idempotency-Key header (a lowercase UUID) is required.',
    );
  }
  return raw;
}

// The fingerprint a replay is compared by: SHA-256 of the NORMALISED
// request, in a fixed field order. Never stored in clear.
export function provisionRequestHash(
  request: NormalisedProvisionRequest,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        request.name,
        request.slug,
        request.ownerEmail,
        request.ownerDisplayName,
        request.planVersionId,
      ]),
    )
    .digest('hex');
}
