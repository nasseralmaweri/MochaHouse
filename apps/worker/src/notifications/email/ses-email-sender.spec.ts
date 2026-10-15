import { SesEmailSender } from './ses-email-sender';

// Milestone 8H — SES configuration validation only. No real AWS call is
// ever made: getFromAddress() throws before the SES client is invoked
// whenever NOTIFICATIONS_SES_FROM_EMAIL is missing, which is what "fails
// clearly if SES configuration is incomplete" verifies here.
describe('SesEmailSender', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('throws a clear, specific error when NOTIFICATIONS_SES_FROM_EMAIL is not set', async () => {
    delete process.env.NOTIFICATIONS_SES_FROM_EMAIL;
    const sender = new SesEmailSender();

    await expect(
      sender.send({ to: 'a@example.com', subject: 's', html: 'h', text: 't' }),
    ).rejects.toThrow('NOTIFICATIONS_SES_FROM_EMAIL is not set');
  });
});

// R1 / S4b — how an SES failure is classified for the worker. An error that
// carries an HTTP status means SES ANSWERED and did not accept the message
// (definite); one without (timeout, abort, connection loss) is left unchanged
// so the worker treats it as ambiguous.
describe('SesEmailSender failure classification (R1 / S4b)', () => {
  const input = { to: 'a@example.com', subject: 's', html: 'h', text: 't' };
  const sendWith = (error: unknown) => {
    process.env.NOTIFICATIONS_SES_FROM_EMAIL = 'from@example.com';
    const sender = new SesEmailSender();
    (sender as unknown as { client: unknown }).client = {
      send: jest.fn().mockRejectedValue(error),
    };
    return sender.send(input);
  };
  const sesError = (name: string, status: number) =>
    Object.assign(new Error(`${name} happened`), {
      name,
      $metadata: { httpStatusCode: status },
    });
  afterEach(() => {
    delete process.env.NOTIFICATIONS_SES_FROM_EMAIL;
  });

  it.each([
    ['Throttling', 400, true],
    ['ThrottlingException', 400, true],
    ['ServiceUnavailable', 503, true],
    ['SomethingElse', 500, true],
    ['MailFromDomainNotVerifiedException', 400, true],
    ['MessageRejected', 400, false],
    ['InvalidParameterValue', 400, false],
  ])(
    '%s (HTTP %i) is a definite refusal, retryable=%s',
    async (name, status, retryable) => {
      await expect(sendWith(sesError(name, status))).rejects.toMatchObject({
        name: 'EmailProviderRejection',
        code: name,
        retryable,
      });
    },
  );

  it('leaves a timeout / connection error alone (ambiguous)', async () => {
    const timeout = Object.assign(new Error('socket hang up'), {
      name: 'TimeoutError',
    });
    const err = await sendWith(timeout).catch((e: unknown) => e);
    expect(err).toBe(timeout);
    expect((err as Error).name).not.toBe('EmailProviderRejection');
  });

  it.each(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'])(
    '%s (nothing could have been sent) is a definite, retryable failure',
    async (code) => {
      const networkError = Object.assign(new Error('connect failed'), { code });
      await expect(sendWith(networkError)).rejects.toMatchObject({
        name: 'EmailProviderRejection',
        code,
        retryable: true,
      });
      // ...also when the code is on a wrapped cause.
      const wrapped = Object.assign(new Error('fetch failed'), {
        cause: { code },
      });
      await expect(sendWith(wrapped)).rejects.toMatchObject({
        retryable: true,
      });
    },
  );

  it.each(['ECONNRESET', 'ETIMEDOUT', 'EPIPE'])(
    '%s may have happened after SES received the request: ambiguous (left as-is)',
    async (code) => {
      const err = Object.assign(new Error('reset'), { code });
      expect(await sendWith(err).catch((e: unknown) => e)).toBe(err);
    },
  );

  it.each(['AccessDenied', 'ExpiredToken', 'InvalidClientTokenId'])(
    'credential problem %s is operator-fixable, so retryable',
    async (name) => {
      await expect(sendWith(sesError(name, 403))).rejects.toMatchObject({
        retryable: true,
      });
    },
  );

  it('a 2xx response that still produced an exception may have been accepted: ambiguous', async () => {
    const err = sesError('DeserializationError', 200);
    expect(await sendWith(err).catch((e: unknown) => e)).toBe(err);
  });

  it('missing SES configuration is refused before any request and is fixable (retryable)', async () => {
    delete process.env.NOTIFICATIONS_SES_FROM_EMAIL;
    await expect(new SesEmailSender().send(input)).rejects.toMatchObject({
      name: 'EmailProviderRejection',
      code: 'SES_NOT_CONFIGURED',
      retryable: true,
    });
  });
});
