import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

// Milestone 7H — bounded, temporary full-code recovery for a customer
// gift-card purchase. The plaintext gift-card code is NEVER persisted; for a
// 7-day window after issuance it is recoverable ONLY by decrypting the
// AES-256-GCM ciphertext stored on GiftCardPurchase, server-side, through
// the same idempotent purchase POST flow.
//
// This is a purpose-specific secret — NOT GIFT_CARD_CODE_SECRET (that keys
// the one-way HMAC codeHash and must stay one-way). GIFT_CARD_PURCHASE_CODE_KEK
// is a 256-bit key supplied as 64 hex chars (or 44 base64 chars).

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const KEY_BYTES = 32; // 256 bits
const AUTH_TAG_BYTES = 16;

export interface EncryptedCode {
  // Uint8Array<ArrayBuffer> (not Buffer) so these drop straight into a Prisma
  // `Bytes` column without an ArrayBufferLike vs ArrayBuffer type clash.
  ciphertext: Uint8Array<ArrayBuffer>;
  iv: Uint8Array<ArrayBuffer>;
  authTag: Uint8Array<ArrayBuffer>;
}

function toBytes(buf: Buffer): Uint8Array<ArrayBuffer> {
  // Copy into a fresh, plain ArrayBuffer so the type is exactly
  // Uint8Array<ArrayBuffer> (what Prisma's `Bytes` column expects).
  const out = new Uint8Array(buf.byteLength);
  out.set(buf);
  return out;
}

// Resolve + validate the KEK at call time (never cached) so a test can set
// it per-suite, mirroring the internal-auth dev-secret helpers. Fails fast
// on a missing / wrong-length key.
function resolveKek(): Buffer {
  const raw = process.env.GIFT_CARD_PURCHASE_CODE_KEK;
  if (!raw || raw.trim().length === 0) {
    throw new Error(
      'GIFT_CARD_PURCHASE_CODE_KEK is not set. See apps/api/.env.example.',
    );
  }
  const trimmed = raw.trim();
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    key = Buffer.from(trimmed, 'hex');
  } else {
    key = Buffer.from(trimmed, 'base64');
  }
  if (key.length !== KEY_BYTES) {
    throw new Error(
      'GIFT_CARD_PURCHASE_CODE_KEK must be a 256-bit key (64 hex chars or 44 base64 chars).',
    );
  }
  return key;
}

// Encrypt the canonical gift-card code with a FRESH random 96-bit IV. The IV
// is unique per call, so it is never reused with the same key.
export function encryptGiftCardCode(canonicalCode: string): EncryptedCode {
  const key = resolveKek();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(canonicalCode, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: toBytes(ciphertext),
    iv: toBytes(iv),
    authTag: toBytes(authTag),
  };
}

// Decrypt. Returns null on ANY failure (wrong key, tampered ciphertext/tag,
// malformed input) — never throws to the caller, never returns partial data,
// never falls back to anything. The caller treats null as "code not
// recoverable" and returns a non-disclosing response.
export function decryptGiftCardCode(input: {
  ciphertext: Uint8Array | null | undefined;
  iv: Uint8Array | null | undefined;
  authTag: Uint8Array | null | undefined;
}): string | null {
  if (!input.ciphertext || !input.iv || !input.authTag) {
    return null;
  }
  const iv = Buffer.from(input.iv);
  const authTag = Buffer.from(input.authTag);
  if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
    return null;
  }
  try {
    const key = resolveKek();
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(input.ciphertext)),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  } catch {
    return null;
  }
}

// Constant-time comparison of two ownership credentials (the purchase
// idempotency key) — used when a signed-out replay must prove it holds the
// original high-entropy credential before the code is re-presented.
export function credentialsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
