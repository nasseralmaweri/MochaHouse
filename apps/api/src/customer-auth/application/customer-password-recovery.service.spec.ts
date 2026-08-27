import { CustomerPasswordRecoveryService } from './customer-password-recovery.service';
import { CognitoPasswordRecoveryProvider } from '../infrastructure/cognito-password-recovery.provider';
import { LocalDevPasswordRecoveryProvider } from '../infrastructure/local-dev-password-recovery.provider';
import { LocalDevCustomerDirectory } from '../infrastructure/local-dev-customer-directory';

describe('CustomerPasswordRecoveryService', () => {
  const originalEnv = { ...process.env };
  let directory: LocalDevCustomerDirectory;
  let service: CustomerPasswordRecoveryService;

  beforeEach(() => {
    directory = new LocalDevCustomerDirectory();
    service = new CustomerPasswordRecoveryService(
      new CognitoPasswordRecoveryProvider(),
      new LocalDevPasswordRecoveryProvider(directory),
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
    directory.set('known@example.com', {
      subject: 'dev:known@example.com',
      displayName: null,
      issuedAt: Date.now(),
      verified: true,
    });

    const result = await service.startPasswordRecovery('known@example.com');

    expect(result).toEqual({ outcome: 'initiated' });
  });

  it('never falls back to the dev provider in production, even if AUTH_PROVIDER=dev', async () => {
    process.env.NODE_ENV = 'production';
    process.env.AUTH_PROVIDER = 'dev';
    // Deliberately unset so the real Cognito path being attempted (and
    // failing on missing config) is distinguishable from the dev path
    // (which would succeed / normalize unconditionally).
    delete process.env.COGNITO_USER_POOL_ID;
    delete process.env.COGNITO_CLIENT_ID;

    await expect(
      service.startPasswordRecovery('prod-test@example.com'),
    ).rejects.toThrow('environment variable is not set');
  });

  it('routes confirmPasswordReset through the same production guard', async () => {
    process.env.NODE_ENV = 'production';
    process.env.AUTH_PROVIDER = 'dev';
    delete process.env.COGNITO_USER_POOL_ID;
    delete process.env.COGNITO_CLIENT_ID;

    await expect(
      service.confirmPasswordReset({
        email: 'prod-test@example.com',
        code: '123456',
        newPassword: 'a-fine-new-password',
      }),
    ).rejects.toThrow('environment variable is not set');
  });
});
