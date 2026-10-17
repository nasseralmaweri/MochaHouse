import { ownerRegistrationConfig } from './owner-registration.config';
import {
  OwnerRegistrationInputError,
  OwnerRegistrationPasswordError,
  parseCompleteRequest,
  passwordProblem,
} from './owner-registration-request';
import { initialLoginPassword } from './owner-registration.service';

// SC4a — the registration rules that need no database: the server-side
// switch, the password policy and the server-only initial password.
const ENABLED = {
  SELF_SERVICE_REGISTRATION_ENABLED: 'true',
  SELF_SERVICE_TERMS_VERSION: 'terms-1',
  SELF_SERVICE_PRIVACY_VERSION: 'privacy-1',
  SELF_SERVICE_REGISTRATION_SECRET: 's'.repeat(32),
};

describe('owner registration configuration', () => {
  it('is off unless explicitly and completely configured', () => {
    expect(ownerRegistrationConfig({})).toBeNull();
    expect(ownerRegistrationConfig({ ...ENABLED })).toMatchObject({
      termsVersion: 'terms-1',
      privacyVersion: 'privacy-1',
      dailyLimit: 50,
      termsUrl: null,
    });
    for (const broken of [
      { SELF_SERVICE_REGISTRATION_ENABLED: '0' },
      { SELF_SERVICE_REGISTRATION_ENABLED: 'on' },
      { SELF_SERVICE_TERMS_VERSION: '' },
      { SELF_SERVICE_PRIVACY_VERSION: 'has space' },
      { SELF_SERVICE_REGISTRATION_SECRET: 's'.repeat(31) },
      { SELF_SERVICE_REGISTRATION_DAILY_LIMIT: '1.5' },
      { SELF_SERVICE_REGISTRATION_DAILY_LIMIT: '0' },
    ]) {
      expect(ownerRegistrationConfig({ ...ENABLED, ...broken })).toBeNull();
    }
  });

  it('links documents over https only (http only on loopback)', () => {
    const link = (url: string) =>
      ownerRegistrationConfig({ ...ENABLED, SELF_SERVICE_TERMS_URL: url })!
        .termsUrl;
    expect(link('https://centerivo.example/terms')).toBe(
      'https://centerivo.example/terms',
    );
    expect(link('http://localhost:3000/terms')).toBe(
      'http://localhost:3000/terms',
    );
    expect(link('http://centerivo.example/terms')).toBeNull();
    expect(link('javascript:alert(1)')).toBeNull();
  });
});

describe('owner registration password policy', () => {
  it('requires 12+ characters with every character class Cognito can demand', () => {
    expect(passwordProblem('Correct-Horse-9')).toBeNull();
    for (const weak of [
      'Short-1a',
      'nouppercase-123',
      'NOLOWERCASE-123',
      'No-Digits-Here',
      'NoSymbols12345',
      ' Spaced-Out-123',
      'Spaced-Out-123 ',
      `Aa1-${'x'.repeat(253)}`,
    ]) {
      expect(passwordProblem(weak)).not.toBeNull();
    }
  });

  it('parses a completion strictly', () => {
    const valid = {
      email: ' Owner@Example.com ',
      code: ' 012345 ',
      password: 'Correct-Horse-9',
      displayName: ' Ada\t Owner ',
      termsVersion: 'terms-1',
      privacyVersion: 'privacy-1',
      acceptLegal: true,
    };
    expect(parseCompleteRequest(valid)).toEqual({
      email: 'owner@example.com',
      code: '012345',
      password: 'Correct-Horse-9',
      displayName: 'Ada Owner',
      termsVersion: 'terms-1',
      privacyVersion: 'privacy-1',
    });
    expect(() => parseCompleteRequest({ ...valid, acceptLegal: 1 })).toThrow(
      OwnerRegistrationInputError,
    );
    expect(() =>
      parseCompleteRequest({ ...valid, displayName: 'a\u0000b' }),
    ).toThrow(OwnerRegistrationInputError);
    expect(() => parseCompleteRequest({ ...valid, password: 'weak' })).toThrow(
      OwnerRegistrationPasswordError,
    );
    expect(() => parseCompleteRequest(null)).toThrow(
      OwnerRegistrationInputError,
    );
  });
});

describe('a login’s initial password', () => {
  const registration = { id: 'reg-1', initialPasswordNonce: 'n'.repeat(64) };

  it('is derived from the server secret and the registration’s own nonce, and passes the policy', () => {
    const one = initialLoginPassword('s'.repeat(32), registration);
    expect(one).toBe(initialLoginPassword('s'.repeat(32), registration));
    expect(passwordProblem(one)).toBeNull();
    expect(initialLoginPassword('t'.repeat(32), registration)).not.toBe(one);
    expect(
      initialLoginPassword('s'.repeat(32), {
        ...registration,
        initialPasswordNonce: 'm'.repeat(64),
      }),
    ).not.toBe(one);
  });
});
