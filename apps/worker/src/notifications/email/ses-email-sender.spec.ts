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
