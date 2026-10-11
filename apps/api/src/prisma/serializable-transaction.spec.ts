import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import {
  CONCURRENT_CHANGE_MESSAGE,
  SERIALIZABLE_MAX_ATTEMPTS,
  isSerializationFailure,
  runSerializable,
} from './serializable-transaction';

// Security follow-up F-2 — unit behaviour of the Serializable retry helper.
// The database-level races are proven in
// internal-users/admin-internal-user-concurrency.spec.ts.

const serializationFailure = () =>
  Object.assign(
    new Error('Transaction failed due to a write conflict or a deadlock.'),
    {
      code: 'P2034',
    },
  );

// A fake client whose $transaction runs `outcomes` in order: an Error is
// thrown, anything else is returned; records the isolation level used.
function fakeClient(outcomes: unknown[]) {
  const calls: unknown[] = [];
  return {
    calls,
    $transaction: ((_work: unknown, options: unknown) => {
      calls.push(options);
      const next = outcomes.shift();
      return next instanceof Error
        ? Promise.reject(next)
        : Promise.resolve(next);
    }) as never,
  };
}
const noSleep = () => Promise.resolve();

describe('runSerializable (Security F-2)', () => {
  it('recognises every shape a serialization failure or deadlock arrives in', () => {
    // A statement refused inside the transaction (Prisma error).
    expect(isSerializationFailure(serializationFailure())).toBe(true);
    // Refused at COMMIT: a bare DriverAdapterError with no Prisma code.
    expect(
      isSerializationFailure(
        Object.assign(new Error('TransactionWriteConflict'), {
          name: 'DriverAdapterError',
          cause: {
            originalCode: '40001',
            originalMessage:
              'could not serialize access due to read/write dependencies among transactions',
            kind: 'TransactionWriteConflict',
          },
        }),
      ),
    ).toBe(true);
    // A deadlock (not mapped by the adapter): raw SQLSTATE on the cause.
    expect(
      isSerializationFailure(
        Object.assign(new Error('deadlock detected'), {
          name: 'DriverAdapterError',
          cause: { kind: 'postgres', code: '40P01', originalCode: '40P01' },
        }),
      ),
    ).toBe(true);
    // The same, wrapped by Prisma with another code.
    expect(
      isSerializationFailure(
        Object.assign(new Error('x'), {
          code: 'P2010',
          meta: { driverAdapterError: { cause: { originalCode: '40P01' } } },
        }),
      ),
    ).toBe(true);
  });

  it('does not treat business conflicts or other database errors as serialization failures', () => {
    for (const other of [
      Object.assign(new Error('x'), { code: 'P2002' }),
      Object.assign(new Error('x'), { code: 'P2025' }),
      Object.assign(new Error('x'), {
        cause: { kind: 'UniqueConstraintViolation', originalCode: '23505' },
      }),
      Object.assign(new Error('x'), {
        cause: { kind: 'postgres', code: '23503' },
      }),
      new ConflictException('This person already has that access.'),
      new Error('P2034'),
      null,
      'P2034',
    ]) {
      expect(isSerializationFailure(other)).toBe(false);
    }
  });

  it('runs the work in a Serializable transaction and returns its result', async () => {
    const client = fakeClient(['done']);
    await expect(
      runSerializable(client, () => Promise.resolve('unused'), {
        sleep: noSleep,
      }),
    ).resolves.toBe('done');
    expect(client.calls).toEqual([{ isolationLevel: 'Serializable' }]);
  });

  it('re-runs the whole transaction after a serialization failure, including one raised at COMMIT', async () => {
    const atCommit = Object.assign(new Error('TransactionWriteConflict'), {
      cause: { kind: 'TransactionWriteConflict', originalCode: '40001' },
    });
    const client = fakeClient([serializationFailure(), atCommit, 'ok']);
    await expect(
      runSerializable(client, () => Promise.resolve('unused'), {
        sleep: noSleep,
      }),
    ).resolves.toBe('ok');
    expect(client.calls).toHaveLength(3);
  });

  it('never retries a business decision: a thrown 409 passes through on the first attempt, unchanged', async () => {
    const conflict = new ConflictException(
      'This person already has that access.',
    );
    const client = fakeClient([conflict]);
    await expect(
      runSerializable(client, () => Promise.resolve('unused'), {
        sleep: noSleep,
      }),
    ).rejects.toBe(conflict);
    expect(client.calls).toHaveLength(1);
  });

  it('never retries other database errors: they propagate unchanged', async () => {
    const unique = Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
    });
    const client = fakeClient([unique]);
    await expect(
      runSerializable(client, () => Promise.resolve('unused'), {
        sleep: noSleep,
      }),
    ).rejects.toBe(unique);
    expect(client.calls).toHaveLength(1);
  });

  it('retries an error the caller names as "re-decide from fresh data"', async () => {
    const unique = Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
    });
    const client = fakeClient([unique, 'ok']);
    await expect(
      runSerializable(client, () => Promise.resolve('unused'), {
        sleep: noSleep,
        retryIf: (e) => (e as { code?: string }).code === 'P2002',
      }),
    ).resolves.toBe('ok');
    expect(client.calls).toHaveLength(2);
  });

  it(`gives up after ${SERIALIZABLE_MAX_ATTEMPTS} lost races with a generic 503 that reveals nothing about the database`, async () => {
    const client = fakeClient(
      Array.from(
        { length: SERIALIZABLE_MAX_ATTEMPTS + 2 },
        serializationFailure,
      ),
    );
    const error = await runSerializable(
      client,
      () => Promise.resolve('unused'),
      {
        sleep: noSleep,
      },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    const body = (error as ServiceUnavailableException).getResponse();
    expect(body).toEqual({
      statusCode: 503,
      error: 'Service Unavailable',
      message: CONCURRENT_CHANGE_MESSAGE,
    });
    expect(JSON.stringify(body)).not.toMatch(
      /P2034|prisma|serializ|deadlock|transaction/i,
    );
    expect(client.calls).toHaveLength(SERIALIZABLE_MAX_ATTEMPTS);
  });

  it('backs off between attempts with growing, jittered delays, capped at 250 ms', async () => {
    const delays: number[] = [];
    const client = fakeClient([
      serializationFailure(),
      serializationFailure(),
      serializationFailure(),
      'ok',
    ]);
    await runSerializable(client, () => Promise.resolve('unused'), {
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });
    expect(delays).toHaveLength(3);
    expect(delays[0]).toBeGreaterThanOrEqual(10);
    expect(delays[0]).toBeLessThan(20);
    expect(delays[1]).toBeGreaterThanOrEqual(20);
    expect(delays[2]).toBeGreaterThanOrEqual(40);

    const capped: number[] = [];
    const busy = fakeClient(
      Array.from({ length: SERIALIZABLE_MAX_ATTEMPTS }, serializationFailure),
    );
    await runSerializable(busy, () => Promise.resolve('unused'), {
      sleep: (ms) => {
        capped.push(ms);
        return Promise.resolve();
      },
    }).catch(() => undefined);
    expect(capped).toHaveLength(SERIALIZABLE_MAX_ATTEMPTS - 1);
    expect(Math.max(...capped)).toBeLessThan(260);
  });
});
