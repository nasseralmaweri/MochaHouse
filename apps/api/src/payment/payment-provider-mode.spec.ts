import { Test } from '@nestjs/testing';
import {
  FakePaymentProvider,
  UnavailablePaymentProvider,
  type PaymentProvider,
} from '@mocha-house/integrations';
import { paymentProviderLabel } from '../admin-platform/platform-presentation';
import {
  PaymentConfigurationError,
  resolvePaymentProviderMode,
} from './payment-provider-mode';
import { createPaymentProvider, PaymentModule } from './payment.module';
import { PAYMENT_PROVIDER } from './payment-provider.token';

// Payment safety: the simulated provider must never be able to take a
// "payment" in production — not by default, not by a configuration mistake,
// and not if something binds it there anyway.
describe('payment provider configuration (payment safety)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('resolvePaymentProviderMode', () => {
    it.each([
      ['development', undefined],
      ['development', ''],
      ['development', 'disabled'],
      ['test', undefined],
      [undefined, undefined],
      ['production', undefined],
      ['production', ''],
      ['production', 'disabled'],
    ])(
      'NODE_ENV=%s, PAYMENT_PROVIDER=%s → online payment unavailable',
      (nodeEnv, provider) => {
        expect(
          resolvePaymentProviderMode({
            NODE_ENV: nodeEnv,
            PAYMENT_PROVIDER: provider,
          }),
        ).toBe('unavailable');
      },
    );

    it.each([['development'], ['test'], [undefined]])(
      'NODE_ENV=%s with an explicit PAYMENT_PROVIDER=fake → simulated provider',
      (nodeEnv) => {
        expect(
          resolvePaymentProviderMode({
            NODE_ENV: nodeEnv,
            PAYMENT_PROVIDER: 'fake',
          }),
        ).toBe('fake');
      },
    );

    it('refuses PAYMENT_PROVIDER=fake in production', () => {
      expect(() =>
        resolvePaymentProviderMode({
          NODE_ENV: 'production',
          PAYMENT_PROVIDER: 'fake',
        }),
      ).toThrow(PaymentConfigurationError);
      expect(() =>
        resolvePaymentProviderMode({
          NODE_ENV: 'production',
          PAYMENT_PROVIDER: 'fake',
        }),
      ).toThrow(/not allowed in production/);
    });

    it.each([
      ['FAKE'],
      [' fake'],
      ['fake '],
      ['stripe'],
      ['square'],
      ['live'],
      ['true'],
    ])(
      'refuses an unsupported value (%j) in any environment instead of guessing',
      (value) => {
        for (const nodeEnv of ['development', 'production']) {
          expect(() =>
            resolvePaymentProviderMode({
              NODE_ENV: nodeEnv,
              PAYMENT_PROVIDER: value,
            }),
          ).toThrow(PaymentConfigurationError);
        }
      },
    );

    it('never echoes the configured value in the error (it may be a pasted secret)', () => {
      const secretLike = 'pasted-credential-sentinel-0f3c9a';
      let message = '';
      try {
        resolvePaymentProviderMode({
          NODE_ENV: 'production',
          PAYMENT_PROVIDER: secretLike,
        });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/unsupported value/);
      expect(message).not.toContain(secretLike);
    });
  });

  describe('createPaymentProvider', () => {
    it('binds the simulated provider only when explicitly requested outside production', () => {
      const provider = createPaymentProvider({
        NODE_ENV: 'development',
        PAYMENT_PROVIDER: 'fake',
      });
      expect(provider).toBeInstanceOf(FakePaymentProvider);
    });

    it('defaults to the unavailable provider when nothing is configured', () => {
      const provider = createPaymentProvider({ NODE_ENV: 'production' });
      expect(provider).toBeInstanceOf(UnavailablePaymentProvider);
      expect(provider.acceptsPayments).toBe(false);
    });

    it('throws for fake in production rather than returning any provider', () => {
      expect(() =>
        createPaymentProvider({
          NODE_ENV: 'production',
          PAYMENT_PROVIDER: 'fake',
        }),
      ).toThrow(PaymentConfigurationError);
    });
  });

  describe('PaymentModule startup', () => {
    async function compileWith(
      env: Record<string, string | undefined>,
    ): Promise<PaymentProvider> {
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      const moduleRef = await Test.createTestingModule({
        imports: [PaymentModule],
      }).compile();
      try {
        return moduleRef.get<PaymentProvider>(PAYMENT_PROVIDER);
      } finally {
        await moduleRef.close();
      }
    }

    it('fails to start in production with PAYMENT_PROVIDER=fake', async () => {
      await expect(
        compileWith({ NODE_ENV: 'production', PAYMENT_PROVIDER: 'fake' }),
      ).rejects.toThrow(PaymentConfigurationError);
    });

    it('fails to start with an unsupported PAYMENT_PROVIDER', async () => {
      await expect(
        compileWith({ NODE_ENV: 'production', PAYMENT_PROVIDER: 'Fake' }),
      ).rejects.toThrow(PaymentConfigurationError);
    });

    it('starts in production with online payment disabled when unset', async () => {
      const provider = await compileWith({
        NODE_ENV: 'production',
        PAYMENT_PROVIDER: undefined,
      });
      expect(provider).toBeInstanceOf(UnavailablePaymentProvider);
      expect(provider.acceptsPayments).toBe(false);
    });

    it('binds the simulated provider in development when explicitly requested', async () => {
      const provider = await compileWith({
        NODE_ENV: 'development',
        PAYMENT_PROVIDER: 'fake',
      });
      expect(provider).toBeInstanceOf(FakePaymentProvider);
      expect(provider.acceptsPayments).toBe(true);
    });
  });

  describe('FakePaymentProvider runtime floor', () => {
    const request = {
      idempotencyKey: 'payment-safety-1',
      amount: 800,
      currency: 'USD',
      metadata: { guestPhone: '5551234567' },
    };

    it('refuses to accept payments once NODE_ENV is production, even if bound', async () => {
      const provider = new FakePaymentProvider();
      process.env.NODE_ENV = 'development';
      expect(provider.acceptsPayments).toBe(true);
      expect((await provider.charge(request)).outcome).toBe('succeeded');

      // Checked per call, never cached at construction.
      process.env.NODE_ENV = 'production';
      expect(provider.acceptsPayments).toBe(false);
      const result = await provider.charge(request);
      expect(result.outcome).toBe('failed');
      expect(result).not.toHaveProperty('providerReference');
    });
  });

  describe('UnavailablePaymentProvider', () => {
    it('never accepts or succeeds a charge in any environment', async () => {
      const provider = new UnavailablePaymentProvider();
      for (const nodeEnv of ['development', 'test', 'production']) {
        process.env.NODE_ENV = nodeEnv;
        expect(provider.acceptsPayments).toBe(false);
        const result = await provider.charge({
          idempotencyKey: 'payment-safety-2',
          amount: 800,
          currency: 'USD',
        });
        expect(result.outcome).toBe('failed');
      }
    });
  });

  describe('paymentProviderLabel', () => {
    it('distinguishes simulated, disabled and live providers', () => {
      process.env.NODE_ENV = 'development';
      expect(paymentProviderLabel(new FakePaymentProvider())).toBe(
        'Development payment provider',
      );
      expect(paymentProviderLabel(new UnavailablePaymentProvider())).toBe(
        'Online payment disabled',
      );
      expect(
        paymentProviderLabel({ name: 'live-test', acceptsPayments: true }),
      ).toBe('Live payment provider');
    });
  });
});
