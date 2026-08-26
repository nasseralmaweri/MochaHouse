import { FakePaymentProvider } from '@mocha-house/integrations';

describe('FakePaymentProvider', () => {
  const provider = new FakePaymentProvider();

  it('succeeds deterministically for a normal charge', async () => {
    const result = await provider.charge({
      idempotencyKey: 'key-1',
      amount: 800,
      currency: 'USD',
      metadata: { guestPhone: '5551234567' },
    });
    expect(result.outcome).toBe('succeeded');
  });

  it('declines deterministically for the documented test phone number', async () => {
    const result = await provider.charge({
      idempotencyKey: 'key-2',
      amount: 800,
      currency: 'USD',
      metadata: { guestPhone: FakePaymentProvider.DECLINE_TEST_PHONE },
    });
    expect(result.outcome).toBe('declined');
  });

  it('fails for a non-positive amount rather than guessing an outcome', async () => {
    const result = await provider.charge({
      idempotencyKey: 'key-3',
      amount: 0,
      currency: 'USD',
    });
    expect(result.outcome).toBe('failed');
  });

  it('is deterministic — the same request never produces different outcomes', async () => {
    const requests = Array.from({ length: 5 }, () =>
      provider.charge({
        idempotencyKey: 'key-4',
        amount: 500,
        currency: 'USD',
        metadata: { guestPhone: '5559998888' },
      }),
    );
    const outcomes = (await Promise.all(requests)).map((r) => r.outcome);
    expect(new Set(outcomes).size).toBe(1);
    expect(outcomes[0]).toBe('succeeded');
  });
});
