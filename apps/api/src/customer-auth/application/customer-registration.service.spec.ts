import { CustomerRegistrationService } from './customer-registration.service';
import { CognitoRegistrationProvider } from '../infrastructure/cognito-registration.provider';
import { LocalDevRegistrationProvider } from '../infrastructure/local-dev-registration.provider';
import { LocalDevCustomerDirectory } from '../infrastructure/local-dev-customer-directory';

describe('CustomerRegistrationService', () => {
  const originalEnv = { ...process.env };
  let service: CustomerRegistrationService;

  beforeEach(() => {
    service = new CustomerRegistrationService(
      new CognitoRegistrationProvider(),
      new LocalDevRegistrationProvider(new LocalDevCustomerDirectory()),
    );
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  it('uses the dev provider in a non-production environment with AUTH_PROVIDER=dev', async () => {
    process.env.NODE_ENV = 'development';
    process.env.AUTH_PROVIDER = 'dev';
    process.env.AUTH_DEV_JWT_SECRET = 'test-secret';

    const result = await service.register({
      email: 'dev-provider-test@example.com',
      password: 'a-fine-password',
      displayName: 'Test Customer',
    });

    expect(result).toEqual({
      outcome: 'success',
      provider: 'dev',
      subject: 'dev:dev-provider-test@example.com',
    });
  });

  it('never falls back to the dev provider in production, even if AUTH_PROVIDER=dev', async () => {
    process.env.NODE_ENV = 'production';
    process.env.AUTH_PROVIDER = 'dev';
    // Deliberately unset so the real Cognito path being attempted (and
    // failing due to missing config) is distinguishable from the dev path
    // (which would succeed unconditionally).
    delete process.env.COGNITO_USER_POOL_ID;
    delete process.env.COGNITO_CLIENT_ID;

    await expect(
      service.register({
        email: 'prod-test@example.com',
        password: 'a-fine-password',
        displayName: 'Test Customer',
      }),
    ).rejects.toThrow('environment variable is not set');
  });
});
