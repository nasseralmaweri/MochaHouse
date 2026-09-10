import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Milestone 7H (post-review correction B) — the server-generated recovery
// credential for a GUEST gift-card purchase.
//
// WHY: payment idempotency (PaymentAttempt.idempotencyKey) is a client-chosen
// value. It must not ALSO be the sole secret that unlocks stored value. This
// credential separates those concerns: the server mints a 256-bit CSPRNG
// value when the PENDING purchase is first established (before any charge),
// returns it to the buyer exactly once, and persists only a one-way HMAC
// verifier. Guest full-code recovery then requires BOTH the idempotency key
// (to find the logical purchase) AND this credential (to authorise the
// disclosure); the idempotency key alone never yields the code.
//
// The secret keying the HMAC is purpose-specific: NOT GIFT_CARD_CODE_SECRET
// (which keys the one-way code hash) and NOT GIFT_CARD_PURCHASE_CODE_KEK
// (which encrypts the code at rest).

const CREDENTIAL_BYTES = 32; // 256 bits

// A fresh URL-safe recovery credential. base64url of 32 CSPRNG bytes → 43
// chars, no padding, safe to place in a JSON body (never a URL/query string).
export function generateRecoveryCredential(): string {
  return randomBytes(CREDENTIAL_BYTES).toString('base64url');
}

// HMAC-SHA-256(credential, GIFT_CARD_PURCHASE_RECOVERY_SECRET) as hex — the
// only representation persisted. The secret is read at call time (never
// cached) so a test can set it per-suite, mirroring hashGiftCardCode.
export function hashRecoveryCredential(credential: string): string {
  const secret = process.env.GIFT_CARD_PURCHASE_RECOVERY_SECRET;
  if (!secret || secret.trim().length === 0) {
    throw new Error(
      'GIFT_CARD_PURCHASE_RECOVERY_SECRET is not set. See apps/api/.env.example.',
    );
  }
  return createHmac('sha256', secret).update(credential).digest('hex');
}

// Constant-time check of a supplied credential against the stored verifier.
// Any malformed input, or a length mismatch, returns false without leaking
// timing.
export function recoveryCredentialMatches(
  suppliedCredential: unknown,
  storedHashHex: string | null | undefined,
): boolean {
  if (
    typeof suppliedCredential !== 'string' ||
    suppliedCredential.length === 0 ||
    !storedHashHex
  ) {
    return false;
  }
  let computed: string;
  try {
    computed = hashRecoveryCredential(suppliedCredential);
  } catch {
    return false;
  }
  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(storedHashHex, 'hex');
  if (a.length === 0 || a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}
