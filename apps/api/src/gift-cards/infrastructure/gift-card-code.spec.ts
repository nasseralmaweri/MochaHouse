import {
  canonicalizeGiftCardCode,
  formatGiftCardCode,
  generateGiftCardCode,
  hashGiftCardCode,
  lastFourOfGiftCardCode,
  maskGiftCardCode,
} from './gift-card-code';

// Milestone 7F — the pure gift-card code helpers. No database, no HTTP.
describe('gift-card code', () => {
  const originalSecret = process.env.GIFT_CARD_CODE_SECRET;

  beforeAll(() => {
    process.env.GIFT_CARD_CODE_SECRET = 'gift-card-code-spec-secret';
  });
  afterAll(() => {
    process.env.GIFT_CARD_CODE_SECRET = originalSecret;
  });

  const CANONICAL = /^[2-9A-HJKMNP-Z]{16}$/;

  it('generates a 16-character code over an unambiguous alphabet, grouped in 4s', () => {
    for (let i = 0; i < 200; i++) {
      const display = generateGiftCardCode();
      expect(display).toMatch(
        /^[2-9A-HJKMNP-Z]{4} [2-9A-HJKMNP-Z]{4} [2-9A-HJKMNP-Z]{4} [2-9A-HJKMNP-Z]{4}$/,
      );
      const canonical = canonicalizeGiftCardCode(display);
      expect(canonical).not.toBeNull();
      expect(canonical).toMatch(CANONICAL);
      // No ambiguous characters.
      expect(canonical).not.toMatch(/[01OILU]/);
    }
  });

  it('generates distinct codes (not sequential)', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 500; i++) {
      codes.add(canonicalizeGiftCardCode(generateGiftCardCode())!);
    }
    expect(codes.size).toBe(500);
  });

  it('canonicalizes case, spaces and dashes; rejects malformed input', () => {
    const display = generateGiftCardCode();
    const canonical = canonicalizeGiftCardCode(display)!;
    expect(canonicalizeGiftCardCode(display.toLowerCase())).toBe(canonical);
    expect(canonicalizeGiftCardCode(canonical.replace(/(.{4})/g, '$1-'))).toBe(
      canonical,
    );
    expect(canonicalizeGiftCardCode(`  ${display}  `)).toBe(canonical);

    expect(canonicalizeGiftCardCode('')).toBeNull();
    expect(canonicalizeGiftCardCode('too-short')).toBeNull();
    expect(canonicalizeGiftCardCode('O'.repeat(16))).toBeNull(); // ambiguous char
    expect(canonicalizeGiftCardCode(12345 as unknown)).toBeNull();
  });

  it('hash is deterministic, hex, secret-dependent, and never contains the code', () => {
    const canonical = canonicalizeGiftCardCode(generateGiftCardCode())!;
    const a = hashGiftCardCode(canonical);
    const b = hashGiftCardCode(canonical);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain(canonical);

    process.env.GIFT_CARD_CODE_SECRET = 'a-different-secret';
    expect(hashGiftCardCode(canonical)).not.toBe(a);
    process.env.GIFT_CARD_CODE_SECRET = 'gift-card-code-spec-secret';
  });

  it('throws when the secret is missing', () => {
    process.env.GIFT_CARD_CODE_SECRET = '';
    expect(() => hashGiftCardCode('2222222222222222')).toThrow(
      /GIFT_CARD_CODE_SECRET/,
    );
    process.env.GIFT_CARD_CODE_SECRET = 'gift-card-code-spec-secret';
  });

  it('masks to the last 4 characters only', () => {
    const canonical = canonicalizeGiftCardCode('2345 6789 ABCD EFGH')!;
    expect(canonical).toBe('23456789ABCDEFGH');
    expect(lastFourOfGiftCardCode(canonical)).toBe('EFGH');
    expect(maskGiftCardCode('EFGH')).toBe('•••• •••• •••• EFGH');
    expect(formatGiftCardCode(canonical)).toBe('2345 6789 ABCD EFGH');
  });
});
