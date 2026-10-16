import {
  FakeSaasBillingProvider,
  type FakeEventBody,
} from './fake-saas-billing-provider';
import {
  BillingEventVerificationError,
  DisabledSaasBillingProvider,
  SaasBillingUnavailableError,
} from './saas-billing-provider';
import {
  createSaasBillingProvider,
  resolveSaasBillingProviderMode,
  SaasBillingConfigurationError,
} from './saas-billing-provider-mode';

// SC3a — the SaaS billing provider boundary: signed, fresh events only;
// metadata is carried for cross-checking, never trusted; the fake is refused
// in production-like environments; disabled by default.
describe('SC3a SaaS billing provider', () => {
  const NOW = new Date('2026-11-01T12:00:00Z');
  const body = (over: Partial<FakeEventBody> = {}): FakeEventBody => ({
    id: 'evt_1',
    type: 'invoice.paid',
    created: Math.floor(NOW.getTime() / 1000) - 60,
    livemode: false,
    data: {
      subscription: 'fake_sub_1',
      customer: 'fake_cus_1',
      tenantId: 'tenant-1',
      reference: 'inv_1',
      amount: 4900,
      currency: 'usd',
      periodStart: Math.floor(NOW.getTime() / 1000) - 60,
      periodEnd: Math.floor(NOW.getTime() / 1000) + 86400 * 30,
    },
    ...over,
  });

  it('verifies a signed, fresh event and normalizes it', () => {
    const provider = new FakeSaasBillingProvider();
    const signed = provider.signEvent(body(), NOW);
    const verified = provider.verifyEvent({ ...signed, now: NOW });
    expect(verified).toMatchObject({
      provider: 'fake',
      externalEventId: 'evt_1',
      providerType: 'invoice.paid',
      livemode: false,
      externalSubscriptionId: 'fake_sub_1',
      externalCustomerId: 'fake_cus_1',
      claimedTenantId: 'tenant-1',
      event: {
        kind: 'PAYMENT_SUCCEEDED',
        reference: 'inv_1',
        amountMinorUnits: 4900,
        currency: 'USD',
      },
    });
    expect(verified.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a tampered body, a wrong secret, a missing or malformed signature, and a stale or future timestamp', () => {
    const provider = new FakeSaasBillingProvider();
    const signed = provider.signEvent(body(), NOW);
    const verify =
      (
        input: { rawBody: string; signatureHeader: string | undefined },
        now = NOW,
      ) =>
      () =>
        provider.verifyEvent({ ...input, now });

    expect(
      verify({ ...signed, rawBody: signed.rawBody.replace('inv_1', 'inv_2') }),
    ).toThrow(BillingEventVerificationError);
    const other = new FakeSaasBillingProvider().signEvent(body(), NOW);
    expect(verify(other)).toThrow(BillingEventVerificationError);
    expect(verify({ ...signed, signatureHeader: undefined })).toThrow(
      BillingEventVerificationError,
    );
    expect(verify({ ...signed, signatureHeader: 'v1=abc' })).toThrow(
      BillingEventVerificationError,
    );
    expect(verify(signed, new Date(NOW.getTime() + 301_000))).toThrow(
      'tolerance',
    );
    expect(verify(signed, new Date(NOW.getTime() - 301_000))).toThrow(
      'tolerance',
    );
  });

  it('refuses an event that claims to have happened after it was signed', () => {
    const provider = new FakeSaasBillingProvider();
    const future = body({ created: Math.floor(NOW.getTime() / 1000) + 3600 });
    const signed = provider.signEvent(future, NOW);
    expect(() => provider.verifyEvent({ ...signed, now: NOW })).toThrow(
      'future',
    );
    const nonsense = provider.signEvent(body({ created: 5 }), NOW);
    expect(() => provider.verifyEvent({ ...nonsense, now: NOW })).toThrow(
      'Incomplete',
    );
  });

  it('maps unknown or incomplete event types to UNSUPPORTED (recorded, never acted on)', () => {
    const provider = new FakeSaasBillingProvider();
    for (const event of [
      body({ type: 'customer.updated' }),
      body({ type: 'invoice.paid', data: { subscription: 'fake_sub_1' } }),
    ]) {
      const signed = provider.signEvent(event, NOW);
      expect(provider.verifyEvent({ ...signed, now: NOW }).event).toEqual({
        kind: 'UNSUPPORTED',
      });
    }
  });

  it('repeats an operation for the same idempotency key without creating a second object', async () => {
    const provider = new FakeSaasBillingProvider();
    const first = await provider.createCustomer({ idempotencyKey: 'k1' });
    const again = await provider.createCustomer({ idempotencyKey: 'k1' });
    const other = await provider.createCustomer({ idempotencyKey: 'k2' });
    expect(again).toEqual(first);
    expect(other).not.toEqual(first);
  });

  it('is disabled unless configured, refuses unknown values and the fake in production-like environments', async () => {
    expect(resolveSaasBillingProviderMode({})).toBe('disabled');
    expect(
      resolveSaasBillingProviderMode({ SAAS_BILLING_PROVIDER: 'disabled' }),
    ).toBe('disabled');
    expect(
      resolveSaasBillingProviderMode({
        SAAS_BILLING_PROVIDER: 'fake',
        NODE_ENV: 'test',
      }),
    ).toBe('fake');
    expect(() =>
      resolveSaasBillingProviderMode({ SAAS_BILLING_PROVIDER: 'stripe' }),
    ).toThrow(SaasBillingConfigurationError);
    expect(() =>
      resolveSaasBillingProviderMode({
        SAAS_BILLING_PROVIDER: 'fake',
        NODE_ENV: 'production',
      }),
    ).toThrow(SaasBillingConfigurationError);
    // The restaurant payment setting never selects a SaaS billing provider.
    expect(
      createSaasBillingProvider({ PAYMENT_PROVIDER: 'fake', NODE_ENV: 'test' }),
    ).toBeInstanceOf(DisabledSaasBillingProvider);

    const disabled = new DisabledSaasBillingProvider();
    await expect(disabled.createCustomer()).rejects.toBeInstanceOf(
      SaasBillingUnavailableError,
    );
    expect(() => disabled.verifyEvent()).toThrow(BillingEventVerificationError);
  });
});
