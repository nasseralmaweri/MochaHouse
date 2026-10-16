import {
  decodeBase32,
  isSixDigitCode,
  totpAt,
  verifyTotp,
} from './platform-totp';

// SC1b — the dev platform sign-in's TOTP, checked against the RFC 6238
// SHA-1 test vectors (secret "12345678901234567890"; the RFC lists 8-digit
// values, whose last 6 digits are the 6-digit codes).
describe('platform TOTP (RFC 6238)', () => {
  const RFC_SECRET_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const secret = decodeBase32(RFC_SECRET_BASE32);

  it('decodes base32 to the RFC secret', () => {
    expect(secret.toString('ascii')).toBe('12345678901234567890');
  });

  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('at t=%i the code is %s', (t, code) => {
    expect(totpAt(secret, t)).toBe(code);
  });

  it('accepts the current step and one step of drift either side, nothing more', () => {
    const t = 1234567890;
    expect(verifyTotp(secret, totpAt(secret, t), t)).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, t - 30), t)).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, t + 30), t)).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, t - 90), t)).toBe(false);
    expect(verifyTotp(secret, totpAt(secret, t + 90), t)).toBe(false);
  });

  it('rejects anything that is not exactly six digits', () => {
    for (const code of ['', '12345', '1234567', 'abcdef', ' 123456', null]) {
      expect(isSixDigitCode(code)).toBe(false);
      expect(verifyTotp(secret, String(code), 1234567890)).toBe(false);
    }
  });

  it('refuses a malformed base32 secret', () => {
    expect(() => decodeBase32('not base32!')).toThrow('Invalid base32 secret.');
  });
});
