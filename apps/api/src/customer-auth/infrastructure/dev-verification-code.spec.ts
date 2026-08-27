import { deriveDevVerificationCode } from './dev-verification-code';

describe('deriveDevVerificationCode', () => {
  it('is deterministic for the same email and secret', () => {
    const a = deriveDevVerificationCode('test@example.com', 'secret');
    const b = deriveDevVerificationCode('test@example.com', 'secret');
    expect(a).toBe(b);
  });

  it('is case/whitespace-insensitive on the email, like an email address should be', () => {
    const a = deriveDevVerificationCode('Test@Example.com', 'secret');
    const b = deriveDevVerificationCode('  test@example.com  ', 'secret');
    expect(a).toBe(b);
  });

  it('differs for a different email', () => {
    const a = deriveDevVerificationCode('a@example.com', 'secret');
    const b = deriveDevVerificationCode('b@example.com', 'secret');
    expect(a).not.toBe(b);
  });

  it('differs for a different secret', () => {
    const a = deriveDevVerificationCode('test@example.com', 'secret-a');
    const b = deriveDevVerificationCode('test@example.com', 'secret-b');
    expect(a).not.toBe(b);
  });

  it('is always a 6-digit numeric string', () => {
    const code = deriveDevVerificationCode('test@example.com', 'secret');
    expect(code).toMatch(/^\d{6}$/);
  });
});
