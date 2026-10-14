import {
  PollingController,
  deriveConnection,
  type PollOutcome,
  type PollingEnv,
} from './polling-controller';

// A deterministic environment: virtual time, a timer queue, and switches for
// visibility / connectivity. No real timers, no browser.
class FakeEnv implements PollingEnv {
  time = 1_000_000;
  visible = true;
  online = true;
  rnd = 0.5; // 0.5 => zero jitter
  private nextId = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private visibilityListeners = new Set<() => void>();
  private onlineListeners = new Set<() => void>();

  now = () => this.time;
  random = () => this.rnd;
  isVisible = () => this.visible;
  isOnline = () => this.online;
  setTimeout = (fn: () => void, ms: number) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + ms, fn });
    return id;
  };
  clearTimeout = (handle: unknown) => {
    this.timers.delete(handle as number);
  };
  onVisibilityChange = (cb: () => void) => {
    this.visibilityListeners.add(cb);
    return () => this.visibilityListeners.delete(cb);
  };
  onOnlineChange = (cb: () => void) => {
    this.onlineListeners.add(cb);
    return () => this.onlineListeners.delete(cb);
  };

  setVisible(value: boolean) {
    this.visible = value;
    this.visibilityListeners.forEach((cb) => cb());
  }
  setOnline(value: boolean) {
    this.online = value;
    this.onlineListeners.forEach((cb) => cb());
  }
  pendingTimers() {
    return this.timers.size;
  }

  // Move time forward, firing due timers in order, letting promise
  // continuations run between them.
  async advance(ms: number) {
    const target = this.time + ms;
    for (;;) {
      await flush();
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.time = Math.max(this.time, due[1].at);
      due[1].fn();
    }
    this.time = target;
    await flush();
  }
}

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const ok = (data: string[]): PollOutcome<string[]> => ({
  outcome: 'success',
  data,
});
const err: PollOutcome<string[]> = { outcome: 'error' };

function make(
  env: FakeEnv,
  fetch: () => Promise<PollOutcome<string[]>>,
  extra: Partial<ConstructorParameters<typeof PollingController<string[]>>[0]> = {},
) {
  return new PollingController<string[]>({ env, fetch, ...extra });
}

describe('PollingController', () => {
  it('fetches immediately on start and then on the interval', async () => {
    const env = new FakeEnv();
    const fetch = jest.fn(async () => ok(['a']));
    const c = make(env, fetch);
    c.start();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(c.getSnapshot()).toMatchObject({ connection: 'live', data: ['a'] });

    await env.advance(9_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await env.advance(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    c.stop();
  });

  it('applies jitter within ±20% of the interval', async () => {
    for (const [rnd, expected] of [
      [0, 8_000],
      [1, 12_000],
    ] as const) {
      const env = new FakeEnv();
      env.rnd = rnd;
      const fetch = jest.fn(async () => ok([]));
      const c = make(env, fetch);
      c.start();
      await flush();
      await env.advance(expected - 1);
      expect(fetch).toHaveBeenCalledTimes(1);
      await env.advance(1);
      expect(fetch).toHaveBeenCalledTimes(2);
      c.stop();
    }
  });

  it('keeps the last good data through failures and backs off up to the cap', async () => {
    const env = new FakeEnv();
    const results = [ok(['a']), err, err, err, err];
    const fetch = jest.fn(async () => results.shift() ?? err);
    const c = make(env, fetch);
    c.start();
    await flush();
    expect(c.getSnapshot().data).toEqual(['a']);

    // 2nd poll at +10s fails -> next delay 10s * 2 = 20s
    await env.advance(10_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(c.getSnapshot()).toMatchObject({
      data: ['a'],
      connection: 'degraded',
      failures: 1,
      actionsAllowed: true,
    });
    await env.advance(19_999);
    expect(fetch).toHaveBeenCalledTimes(2);
    await env.advance(1);
    expect(fetch).toHaveBeenCalledTimes(3);

    // failures=2 -> min(30s cap, 10s*4=40s) = 30s; and never longer after that
    await env.advance(29_999);
    expect(fetch).toHaveBeenCalledTimes(3);
    await env.advance(1);
    expect(fetch).toHaveBeenCalledTimes(4);
    await env.advance(30_000);
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(c.getSnapshot().data).toEqual(['a']);
    c.stop();
  });

  it('becomes stale after the threshold, disables actions, and recovers on success', async () => {
    const env = new FakeEnv();
    let healthy = true;
    const fetch = jest.fn(async () => (healthy ? ok(['a']) : err));
    const c = make(env, fetch);
    c.start();
    await flush();
    expect(c.getSnapshot().actionsAllowed).toBe(true);

    healthy = false;
    await env.advance(29_999);
    expect(c.getSnapshot().actionsAllowed).toBe(true);
    await env.advance(1);
    expect(c.getSnapshot()).toMatchObject({
      connection: 'stale',
      actionsAllowed: false,
      data: ['a'],
    });

    healthy = true;
    c.refreshNow();
    await flush();
    expect(c.getSnapshot()).toMatchObject({
      connection: 'live',
      actionsAllowed: true,
    });
    c.stop();
  });

  it('reports "failed" with no data when it has never succeeded', async () => {
    const env = new FakeEnv();
    const c = make(env, async () => err);
    c.start();
    await flush();
    expect(c.getSnapshot()).toMatchObject({
      connection: 'failed',
      data: null,
      actionsAllowed: false,
    });
    c.stop();
  });

  it('stops polling when the server forbids the caller', async () => {
    const env = new FakeEnv();
    const fetch = jest.fn(async (): Promise<PollOutcome<string[]>> => ({
      outcome: 'forbidden',
    }));
    const c = make(env, fetch);
    c.start();
    await flush();
    expect(c.getSnapshot()).toMatchObject({
      connection: 'forbidden',
      actionsAllowed: false,
    });
    await env.advance(120_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    c.refreshNow();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    c.stop();
  });

  describe('tab visibility', () => {
    it('polls a hidden tab at the slower interval', async () => {
      const env = new FakeEnv();
      const fetch = jest.fn(async () => ok([]));
      const c = make(env, fetch);
      c.start();
      await flush();
      env.setVisible(false);
      await env.advance(29_999);
      expect(fetch).toHaveBeenCalledTimes(1);
      await env.advance(1);
      expect(fetch).toHaveBeenCalledTimes(2);
      c.stop();
    });

    it('refreshes immediately when the tab becomes visible with older data', async () => {
      const env = new FakeEnv();
      const fetch = jest.fn(async () => ok([]));
      const c = make(env, fetch);
      c.start();
      await flush();
      env.setVisible(false);
      await env.advance(20_000);
      const before = fetch.mock.calls.length;
      env.setVisible(true);
      await flush();
      expect(fetch.mock.calls.length).toBe(before + 1);
      c.stop();
    });

    it('does not refetch on a quick tab flick when the data is fresh', async () => {
      const env = new FakeEnv();
      const fetch = jest.fn(async () => ok([]));
      const c = make(env, fetch);
      c.start();
      await flush();
      env.setVisible(false);
      env.setVisible(true);
      await flush();
      expect(fetch).toHaveBeenCalledTimes(1);
      c.stop();
    });
  });

  describe('connectivity', () => {
    it('makes no request while offline and refreshes the moment it is back', async () => {
      const env = new FakeEnv();
      const fetch = jest.fn(async () => ok(['a']));
      const c = make(env, fetch);
      c.start();
      await flush();
      env.setOnline(false);
      expect(c.getSnapshot()).toMatchObject({
        connection: 'offline',
        actionsAllowed: false,
        data: ['a'],
      });
      await env.advance(120_000);
      expect(fetch).toHaveBeenCalledTimes(1);

      env.setOnline(true);
      await flush();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(c.getSnapshot().connection).toBe('live');
      c.stop();
    });
  });

  describe('request safety', () => {
    it('treats a hung request as a failure after the timeout and ignores its late answer', async () => {
      const env = new FakeEnv();
      const first = deferred<PollOutcome<string[]>>();
      const results = [first.promise, Promise.resolve(ok(['fresh']))];
      const fetch = jest.fn(() => results.shift() ?? Promise.resolve(err));
      const c = make(env, fetch);
      c.start();
      await env.advance(7_999);
      expect(c.getSnapshot().refreshing).toBe(true);
      await env.advance(1);
      expect(c.getSnapshot().failures).toBe(1);

      // The hung request finally answers with OLD data: it must be ignored.
      first.resolve(ok(['late-old']));
      await flush();
      expect(c.getSnapshot().data).not.toEqual(['late-old']);

      await env.advance(20_000);
      expect(c.getSnapshot().data).toEqual(['fresh']);
      c.stop();
    });

    it('never has two requests in flight; refreshNow during a request queues one follow-up', async () => {
      const env = new FakeEnv();
      const d = deferred<PollOutcome<string[]>>();
      const fetch = jest
        .fn<Promise<PollOutcome<string[]>>, []>()
        .mockReturnValueOnce(d.promise)
        .mockResolvedValue(ok(['b']));
      const c = make(env, fetch);
      c.start();
      await flush();
      c.refreshNow();
      c.refreshNow();
      c.refreshNow();
      expect(fetch).toHaveBeenCalledTimes(1);
      d.resolve(ok(['a']));
      await flush();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(c.getSnapshot().data).toEqual(['b']);
      c.stop();
    });

    it('a poll that started before a local update cannot overwrite it', async () => {
      const env = new FakeEnv();
      const slow = deferred<PollOutcome<string[]>>();
      const fetch = jest
        .fn<Promise<PollOutcome<string[]>>, []>()
        .mockResolvedValueOnce(ok(['RECEIVED']))
        .mockReturnValueOnce(slow.promise)
        .mockResolvedValue(ok(['ACCEPTED']));
      const c = make(env, fetch);
      c.start();
      await flush();
      expect(c.getSnapshot().data).toEqual(['RECEIVED']);

      // Next poll starts and is slow; meanwhile staff advance the order.
      await env.advance(10_000);
      c.update(() => ['ACCEPTED']);
      expect(c.getSnapshot().data).toEqual(['ACCEPTED']);

      // The slow poll returns the OLD state: it must be discarded...
      slow.resolve(ok(['RECEIVED']));
      await flush();
      // ...and the screen converges on a fresh fetch, never showing the old card.
      expect(c.getSnapshot().data).toEqual(['ACCEPTED']);
      expect(fetch).toHaveBeenCalledTimes(3);
      c.stop();
    });

    it('ignores any answer that arrives after stop()', async () => {
      const env = new FakeEnv();
      const d = deferred<PollOutcome<string[]>>();
      const fetch = jest.fn(() => d.promise);
      const c = make(env, fetch);
      c.start();
      await flush();
      c.stop();
      d.resolve(ok(['x']));
      await flush();
      expect(c.getSnapshot().data).toBeNull();
      await env.advance(60_000);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(env.pendingTimers()).toBe(0);
    });

    it('treats a synchronous throw from the fetch function as a failed poll', async () => {
      const env = new FakeEnv();
      const c = make(env, () => {
        throw new Error('boom');
      });
      c.start();
      await flush();
      expect(c.getSnapshot()).toMatchObject({ connection: 'failed', failures: 1 });
      c.stop();
    });
  });

  describe('observability', () => {
    it('calls onData with the previous data for fetched results only', async () => {
      const env = new FakeEnv();
      const onData = jest.fn();
      const fetch = jest
        .fn<Promise<PollOutcome<string[]>>, []>()
        .mockResolvedValueOnce(ok(['a']))
        .mockResolvedValue(ok(['a', 'b']));
      const c = make(env, fetch, { onData });
      c.start();
      await flush();
      expect(onData).toHaveBeenLastCalledWith(['a'], null);
      c.update(() => ['local']);
      expect(onData).toHaveBeenCalledTimes(1);
      await env.advance(10_000);
      expect(onData).toHaveBeenLastCalledWith(['a', 'b'], ['local']);
      c.stop();
    });

    it('keeps the snapshot object stable when nothing observable changed', async () => {
      const env = new FakeEnv();
      const c = make(env, async () => ok(['a']));
      c.start();
      await flush();
      const listener = jest.fn();
      c.subscribe(listener);
      const before = c.getSnapshot();
      // A visibility flick with fresh data re-times but changes nothing visible.
      env.setVisible(false);
      env.setVisible(true);
      await flush();
      expect(c.getSnapshot()).toBe(before);
      expect(listener).not.toHaveBeenCalled();
      c.stop();
    });

    it('can be stopped and started again (React strict mode)', async () => {
      const env = new FakeEnv();
      const fetch = jest.fn(async () => ok(['a']));
      const c = make(env, fetch);
      c.start();
      c.stop();
      c.start();
      await flush();
      expect(c.getSnapshot().connection).toBe('live');
      await env.advance(10_000);
      expect(fetch).toHaveBeenCalledTimes(3);
      c.stop();
    });
  });
});

describe('deriveConnection', () => {
  const base = {
    now: 100_000,
    online: true,
    forbidden: false,
    lastSuccessAt: 95_000,
    failures: 0,
    staleAfterMs: 30_000,
  };
  it('classifies each state', () => {
    expect(deriveConnection(base)).toBe('live');
    expect(deriveConnection({ ...base, failures: 1 })).toBe('degraded');
    expect(deriveConnection({ ...base, lastSuccessAt: 70_000 })).toBe('stale');
    expect(deriveConnection({ ...base, online: false })).toBe('offline');
    expect(deriveConnection({ ...base, forbidden: true })).toBe('forbidden');
    expect(deriveConnection({ ...base, lastSuccessAt: null })).toBe('loading');
    expect(
      deriveConnection({ ...base, lastSuccessAt: null, failures: 2 }),
    ).toBe('failed');
  });
});
