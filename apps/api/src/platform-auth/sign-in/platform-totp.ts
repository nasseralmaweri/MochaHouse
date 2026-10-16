import { createHmac, timingSafeEqual } from 'node:crypto';

// SC1b — RFC 6238 TOTP (HMAC-SHA1, 30-second step, 6 digits), the same
// algorithm Cognito's software-token MFA uses. Used ONLY by the local/test
// platform sign-in provider, so the dev flow enforces a real second factor
// instead of accepting any code. Production MFA is verified by Cognito.

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

export function decodeBase32(input: string): Buffer {
  const clean = input.replace(/=+$/u, '').replace(/\s+/gu, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) {
      throw new Error('Invalid base32 secret.');
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totpAt(secret: Buffer, unixSeconds: number): string {
  const counter = Math.floor(unixSeconds / STEP_SECONDS);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', secret).update(message).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

// Accepts the current step and one step either side (clock drift), compared
// in constant time.
export function verifyTotp(
  secret: Buffer,
  code: string,
  nowSeconds: number = Date.now() / 1000,
): boolean {
  if (!/^\d{6}$/u.test(code)) {
    return false;
  }
  const provided = Buffer.from(code);
  let matched = false;
  for (const drift of [-1, 0, 1]) {
    const expected = Buffer.from(
      totpAt(secret, nowSeconds + drift * STEP_SECONDS),
    );
    if (timingSafeEqual(provided, expected)) {
      matched = true;
    }
  }
  return matched;
}

export function isSixDigitCode(code: unknown): code is string {
  return typeof code === 'string' && /^\d{6}$/u.test(code);
}
