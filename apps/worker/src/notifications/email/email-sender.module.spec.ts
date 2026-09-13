import { Test, TestingModule } from '@nestjs/testing';
import { EMAIL_SENDER } from './email-sender';
import { EmailSenderModule } from './email-sender.module';
import { LoggingEmailSender } from './logging-email-sender';
import { SesEmailSender } from './ses-email-sender';

// Milestone 8H — provider selection. No AWS credentials required either
// way: SesEmailSender is always registered but only ever *selected*, never
// exercised, when the provider env var is unset.
describe('EmailSenderModule', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('defaults to LoggingEmailSender when NOTIFICATIONS_EMAIL_PROVIDER is unset', async () => {
    delete process.env.NOTIFICATIONS_EMAIL_PROVIDER;
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [EmailSenderModule],
    }).compile();

    expect(moduleRef.get(EMAIL_SENDER)).toBeInstanceOf(LoggingEmailSender);
    await moduleRef.close();
  });

  it('selects SesEmailSender when NOTIFICATIONS_EMAIL_PROVIDER=ses', async () => {
    process.env.NOTIFICATIONS_EMAIL_PROVIDER = 'ses';
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [EmailSenderModule],
    }).compile();

    expect(moduleRef.get(EMAIL_SENDER)).toBeInstanceOf(SesEmailSender);
    await moduleRef.close();
  });
});
