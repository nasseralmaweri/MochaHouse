// ESP-02 — main.ts must validate the authentication configuration BEFORE it
// creates the Nest application (and so before anything can listen), and a
// refused configuration must stop the process with a non-zero exit.

const mockOrder: string[] = [];
const mockListen = jest.fn(() => {
  mockOrder.push('listen');
  return Promise.resolve();
});
const mockCreate = jest.fn(() => {
  mockOrder.push('create');
  return Promise.resolve({
    set: jest.fn(),
    enableCors: jest.fn(),
    listen: mockListen,
  });
});
const mockAssert = jest.fn();

jest.mock('dotenv/config', () => ({}));
jest.mock('@nestjs/core', () => ({ NestFactory: { create: mockCreate } }));
jest.mock('../app.module', () => ({ AppModule: class AppModule {} }));
jest.mock('./auth-startup-guard', () => ({
  ...jest.requireActual<typeof import('./auth-startup-guard')>(
    './auth-startup-guard',
  ),
  assertAuthConfigSafe: mockAssert,
}));

const flush = async () => {
  for (let i = 0; i < 10; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
};

describe('main.ts startup order (ESP-02)', () => {
  beforeEach(() => {
    jest.resetModules();
    mockOrder.length = 0;
    mockCreate.mockClear();
    mockListen.mockClear();
    mockAssert.mockReset();
    mockAssert.mockImplementation(() => {
      mockOrder.push('validate');
    });
  });

  it('validates the configuration before creating the application and listening', async () => {
    await jest.isolateModulesAsync(async () => {
      await import('../main.js');
    });
    await flush();
    expect(mockOrder).toEqual(['validate', 'create', 'listen']);
  });

  it('a refused configuration never creates the application and exits non-zero', async () => {
    const { AuthConfigurationError } = jest.requireActual<
      typeof import('./auth-startup-guard')
    >('./auth-startup-guard');
    mockAssert.mockImplementation(() => {
      throw new AuthConfigurationError([
        'AUTH_PROVIDER must be "cognito" or "dev".',
      ]);
    });
    const exit = jest
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    const error = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    try {
      await jest.isolateModulesAsync(async () => {
        await import('../main.js');
      });
      await flush();
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockListen).not.toHaveBeenCalled();
      expect(exit).toHaveBeenCalledWith(1);
      expect(String(error.mock.calls[0]?.[0])).toMatch(
        /unsafe authentication configuration/,
      );
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });
});
