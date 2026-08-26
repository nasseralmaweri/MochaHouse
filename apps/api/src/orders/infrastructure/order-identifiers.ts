import { randomBytes, randomInt } from 'node:crypto';

// Crockford-ish alphabet with ambiguous characters (0/O, 1/I) removed —
// this is read aloud at a pickup counter, so it has to survive that.
const ORDER_NUMBER_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ORDER_NUMBER_LENGTH = 6;

// A short random code, not a sequential counter: it avoids needing a
// per-location/per-day sequence table (and the locking that comes with
// one) while still being effectively unique — the caller retries on the
// rare unique-constraint collision, which is simpler than coordinating a
// counter across concurrent checkouts.
export function generateOrderNumber(): string {
  let code = '';
  for (let i = 0; i < ORDER_NUMBER_LENGTH; i++) {
    code += ORDER_NUMBER_ALPHABET[randomInt(ORDER_NUMBER_ALPHABET.length)];
  }
  return code;
}

// Opaque bearer credential for guest order access. Never derived from the
// order id and never guessable — this, not the internal UUID, is what
// authorizes a guest to view their own order's status.
export function generateOrderAccessToken(): string {
  return randomBytes(24).toString('base64url');
}
