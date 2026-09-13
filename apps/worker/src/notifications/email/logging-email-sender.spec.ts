import { LoggingEmailSender } from './logging-email-sender';

// Milestone 8H — pure unit test, no AWS credentials, no database. This is
// what tests, local development, and builds use by default.
describe('LoggingEmailSender', () => {
  it('never makes a network call and records every send in memory', async () => {
    const sender = new LoggingEmailSender();
    const result = await sender.send({
      to: 'guest@example.com',
      subject: 'Order received',
      html: '<p>hi</p>',
      text: 'hi',
    });

    expect(result.providerMessageId).toBeDefined();
    expect(sender.getSent()).toHaveLength(1);
    expect(sender.getSent()[0]).toMatchObject({
      to: 'guest@example.com',
      subject: 'Order received',
    });
  });

  it('clear() empties the captured sends', async () => {
    const sender = new LoggingEmailSender();
    await sender.send({ to: 'a@example.com', subject: 's', html: 'h', text: 't' });
    sender.clear();
    expect(sender.getSent()).toHaveLength(0);
  });
});
