import { createHmac, randomInt } from 'node:crypto';

// The one place a gift-card code is generated, canonicalized, hashed and
// masked (Milestone 7F).
//
// SECURITY MODEL (proportionate — no KMS/HSM/rotation in 7F):
//   - Generation is CSPRNG-based (`randomInt`) over an unambiguous alphabet,
//     never a sequential identifier. ~32^16 ≈ 1.2e24 keyspace.
//   - The plaintext code is NEVER persisted. It is canonicalized (trimmed,
//     upper-cased, separators removed) and stored only as
//     HMAC-SHA-256(canonical, GIFT_CARD_CODE_SECRET) plus the last 4
//     characters. A database leak therefore yields no spendable codes.
//   - Lookup is exact-match only: hash the submitted code and query
//     `GiftCard.codeHash`.
//   - The full code is returned exactly once, in the HQ issuance response;
//     every other projection exposes only `maskGiftCardCode(last4)`.

// Crockford-ish: no 0/O/1/I/L/U to keep a spoken/hand-typed code legible.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 16;
const CODE_GROUP_SIZE = 4;

const CANONICAL_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

// A freshly generated code in display form: "XXXX XXXX XXXX XXXX".
export function generateGiftCardCode(): string {
  let raw = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    raw += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return formatGiftCardCode(raw);
}

// Trim, upper-case, and strip spaces / dashes. Returns null for anything
// that is not a well-formed gift-card code (wrong length, or a character
// outside the alphabet).
export function canonicalizeGiftCardCode(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const canonical = raw.trim().toUpperCase().replace(/[\s-]+/g, '');
  return CANONICAL_PATTERN.test(canonical) ? canonical : null;
}

// Group a canonical code into 4-character blocks for display.
export function formatGiftCardCode(canonical: string): string {
  const groups: string[] = [];
  for (let i = 0; i < canonical.length; i += CODE_GROUP_SIZE) {
    groups.push(canonical.slice(i, i + CODE_GROUP_SIZE));
  }
  return groups.join(' ');
}

export function lastFourOfGiftCardCode(canonical: string): string {
  return canonical.slice(-CODE_GROUP_SIZE);
}

// The masked representation shown in every normal Admin read.
export function maskGiftCardCode(last4: string): string {
  return `•••• •••• •••• ${last4}`;
}

// HMAC-SHA-256 of the canonical code, keyed by GIFT_CARD_CODE_SECRET. The
// secret is read at call time (never cached) so tests can set it per-suite,
// mirroring the internal-auth dev-secret helpers. Fails fast when unset.
export function hashGiftCardCode(canonical: string): string {
  const secret = process.env.GIFT_CARD_CODE_SECRET;
  if (!secret || secret.trim().length === 0) {
    throw new Error(
      'GIFT_CARD_CODE_SECRET is not set. See apps/api/.env.example.',
    );
  }
  return createHmac('sha256', secret).update(canonical).digest('hex');
}
