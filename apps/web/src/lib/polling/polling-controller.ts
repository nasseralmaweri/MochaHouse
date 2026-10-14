// A small, framework-free polling controller for live operational screens
// (R1 / S2a). It owns every timing decision so the React layer is a thin
// wrapper and the behaviour can be tested with a fake clock:
//
//   - steady polling with jitter, a slower background-tab interval, bounded
//     exponential backoff on failure, and an immediate refresh when the tab
//     becomes visible or the browser comes back online;
//   - the last SUCCESSFUL data is kept through failures — an error never
//     replaces it;
//   - data older than `staleAfterMs`, or an offline browser, is reported so the
//     UI can stop unsafe actions;
//   - at most one request is in flight, every request has a timeout, and a
//     late or superseded response can never overwrite newer data (a request
//     sequence guard), including a poll that started before a local mutation
//     was applied via `update()` — that response is discarded and the list is
//     refetched so the screen converges on server truth.
//
// It knows nothing about tenants, locations or orders: the caller supplies a
// fetch function already bound to one location, and discards the controller
// (stop()) when that scope changes.

export type PollOutcome<T> =
  | { outcome: 'success'; data: T }
  | { outcome: 'forbidden' }
  // The thing being watched does not exist (or the caller's access token does
  // not match it): polling stops, as with forbidden.
  | { outcome: 'not-found' }
  | { outcome: 'error' };

export type ConnectionState =
  // First request still pending; nothing has ever loaded.
  | 'loading'
  // Nothing has ever loaded and the requests are failing.
  | 'failed'
  // Last attempt succeeded and the data is fresh.
  | 'live'
  // The last attempt failed but the data is still fresh enough to act on.
  | 'degraded'
  // The data is older than the stale threshold and requests ARE failing (or
  // none has been confirmed): the shop may be unreachable.
  | 'stale'
  // The data is older than the stale threshold but nothing has failed: a
  // refresh is simply due (a tab that was in the background, a device that
  // slept). Not an outage — but the data is not trusted for actions.
  | 'catching-up'
  // The browser reports no connectivity.
  | 'offline'
  // The server refused this caller; polling has stopped.
  | 'forbidden'
  // The watched thing does not exist; polling has stopped.
  | 'not-found'
  // The data reached a final state (see `isFinal`): polling has stopped on
  // purpose and the data is not going to change, so it is never "stale".
  | 'complete';

export interface PollingSnapshot<T> {
  readonly data: T | null;
  readonly connection: ConnectionState;
  readonly lastSuccessAt: number | null;
  readonly failures: number;
  // True while data is fresh enough for a staff member to act on safely.
  readonly actionsAllowed: boolean;
  readonly refreshing: boolean;
}

export interface PollingEnv {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  random(): number;
  isVisible(): boolean;
  isOnline(): boolean;
  onVisibilityChange(callback: () => void): () => void;
  onOnlineChange(callback: () => void): () => void;
}

export interface PollingOptions<T> {
  fetch: () => Promise<PollOutcome<T>>;
  env: PollingEnv;
  // Called whenever fetched data replaces the current data (not for local
  // `update()` edits), with the previous data (null on the first load).
  onData?: (data: T, previous: T | null) => void;
  // When fetched data satisfies this, polling stops for good: nothing more can
  // change (for example a completed order), so further requests are waste.
  isFinal?: (data: T) => boolean;
  intervalMs?: number;
  hiddenIntervalMs?: number;
  staleAfterMs?: number;
  maxBackoffMs?: number;
  requestTimeoutMs?: number;
  offlineRetryMs?: number;
  // 0.2 = ±20% around each delay.
  jitter?: number;
}

export const POLLING_DEFAULTS = {
  intervalMs: 10_000,
  hiddenIntervalMs: 30_000,
  staleAfterMs: 30_000,
  maxBackoffMs: 30_000,
  requestTimeoutMs: 8_000,
  offlineRetryMs: 30_000,
  jitter: 0.2,
} as const;

// A refresh triggered by the tab becoming visible is skipped when the data is
// this fresh, so flicking between tabs does not hammer the API.
const MIN_VISIBLE_REFRESH_GAP_MS = 2_000;

export function deriveConnection(input: {
  now: number;
  online: boolean;
  forbidden: boolean;
  notFound?: boolean;
  complete?: boolean;
  lastSuccessAt: number | null;
  failures: number;
  staleAfterMs: number;
}): ConnectionState {
  if (input.forbidden) return 'forbidden';
  if (input.notFound) return 'not-found';
  if (input.complete) return 'complete';
  if (input.lastSuccessAt === null) {
    if (!input.online) return 'offline';
    return input.failures > 0 ? 'failed' : 'loading';
  }
  if (!input.online) return 'offline';
  if (input.now - input.lastSuccessAt >= input.staleAfterMs) {
    return input.failures > 0 ? 'stale' : 'catching-up';
  }
  return input.failures > 0 ? 'degraded' : 'live';
}

export class PollingController<T> {
  private readonly fetchFn: () => Promise<PollOutcome<T>>;
  private readonly env: PollingEnv;
  private readonly onData?: (data: T, previous: T | null) => void;
  private readonly isFinal?: (data: T) => boolean;
  private readonly intervalMs: number;
  private readonly hiddenIntervalMs: number;
  private readonly staleAfterMs: number;
  private readonly maxBackoffMs: number;
  private readonly requestTimeoutMs: number;
  private readonly offlineRetryMs: number;
  private readonly jitter: number;

  private readonly listeners = new Set<() => void>();
  private snapshot: PollingSnapshot<T>;

  private data: T | null = null;
  private lastSuccessAt: number | null = null;
  private failures = 0;
  private forbidden = false;
  private notFound = false;
  private complete = false;

  private started = false;
  private inFlight = false;
  private queuedRefresh = false;
  // Incremented for every request and on stop(): only the response whose
  // sequence is still current may change state.
  private requestSeq = 0;
  // Incremented by every local `update()`: a response that started under an
  // older epoch is discarded rather than overwriting the local change.
  private epoch = 0;

  private pollTimer: unknown = null;
  private requestTimer: unknown = null;
  private staleTimer: unknown = null;
  private unsubscribeVisibility: (() => void) | null = null;
  private unsubscribeOnline: (() => void) | null = null;

  constructor(options: PollingOptions<T>) {
    this.fetchFn = options.fetch;
    this.env = options.env;
    this.onData = options.onData;
    this.isFinal = options.isFinal;
    this.intervalMs = options.intervalMs ?? POLLING_DEFAULTS.intervalMs;
    this.hiddenIntervalMs =
      options.hiddenIntervalMs ?? POLLING_DEFAULTS.hiddenIntervalMs;
    this.staleAfterMs = options.staleAfterMs ?? POLLING_DEFAULTS.staleAfterMs;
    this.maxBackoffMs = options.maxBackoffMs ?? POLLING_DEFAULTS.maxBackoffMs;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? POLLING_DEFAULTS.requestTimeoutMs;
    this.offlineRetryMs =
      options.offlineRetryMs ?? POLLING_DEFAULTS.offlineRetryMs;
    this.jitter = options.jitter ?? POLLING_DEFAULTS.jitter;
    this.snapshot = this.buildSnapshot();
  }

  // --- external-store contract (useSyncExternalStore) -------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): PollingSnapshot<T> => this.snapshot;

  // --- lifecycle ---------------------------------------------------------

  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribeVisibility = this.env.onVisibilityChange(() =>
      this.handleVisibilityChange(),
    );
    this.unsubscribeOnline = this.env.onOnlineChange(() =>
      this.handleOnlineChange(),
    );
    this.emit();
    this.poll();
  }

  stop(): void {
    this.started = false;
    this.requestSeq += 1;
    this.inFlight = false;
    this.queuedRefresh = false;
    this.clear('pollTimer');
    this.clear('requestTimer');
    this.clear('staleTimer');
    this.unsubscribeVisibility?.();
    this.unsubscribeOnline?.();
    this.unsubscribeVisibility = null;
    this.unsubscribeOnline = null;
  }

  // True only if the data is fresh RIGHT NOW. Computed at call time rather than
  // read from the cached snapshot, so a device that slept with the tab open
  // cannot act on a list that went stale while nothing was ticking.
  canAct(): boolean {
    const connection = deriveConnection({
      now: this.env.now(),
      online: this.env.isOnline(),
      forbidden: this.forbidden,
      notFound: this.notFound,
      complete: this.complete,
      lastSuccessAt: this.lastSuccessAt,
      failures: this.failures,
      staleAfterMs: this.staleAfterMs,
    });
    return connection === 'live' || connection === 'degraded';
  }

  // Fetch now (used by the Refresh/Retry controls and after a mutation). If a
  // request is already running, one more run is queued behind it.
  refreshNow(): void {
    if (!this.started || this.halted) return;
    if (this.inFlight) {
      this.queuedRefresh = true;
      return;
    }
    this.poll();
  }

  // Apply a LOCAL change to the current data (for example a status the server
  // just confirmed). Any request already in flight began before this change,
  // so its response is discarded and the list refetched.
  update(change: (current: T) => T): void {
    if (this.data === null) return;
    this.data = change(this.data);
    this.epoch += 1;
    this.emit();
  }

  // --- internals ----------------------------------------------------------

  // Polling has ended for a reason that will not change by itself.
  private get halted(): boolean {
    return this.forbidden || this.notFound || this.complete;
  }

  private poll(): void {
    if (!this.started || this.halted || this.inFlight) return;
    this.clear('pollTimer');

    if (!this.env.isOnline()) {
      // Wait for the 'online' event; keep a slow retry in case it never fires.
      this.emit();
      this.schedule();
      return;
    }

    this.inFlight = true;
    this.queuedRefresh = false;
    this.requestSeq += 1;
    const seq = this.requestSeq;
    const epochAtStart = this.epoch;
    this.emit();

    let settled = false;
    const finish = (result: PollOutcome<T>) => {
      if (settled) return;
      settled = true;
      this.clear('requestTimer');
      this.handleResult(seq, epochAtStart, result);
    };

    this.requestTimer = this.env.setTimeout(
      () => finish({ outcome: 'error' }),
      this.requestTimeoutMs,
    );

    let pending: Promise<PollOutcome<T>>;
    try {
      pending = this.fetchFn();
    } catch {
      finish({ outcome: 'error' });
      return;
    }
    pending.then(finish, () => finish({ outcome: 'error' }));
  }

  private handleResult(
    seq: number,
    epochAtStart: number,
    result: PollOutcome<T>,
  ): void {
    // Stopped, or superseded by a newer request: ignore completely.
    if (!this.started || seq !== this.requestSeq) return;
    this.inFlight = false;

    if (result.outcome === 'forbidden' || result.outcome === 'not-found') {
      if (result.outcome === 'forbidden') this.forbidden = true;
      else this.notFound = true;
      this.clear('pollTimer');
      this.clear('staleTimer');
      this.emit();
      return;
    }

    if (result.outcome === 'error') {
      this.failures += 1;
      this.emit();
      this.afterAttempt();
      return;
    }

    this.failures = 0;
    this.lastSuccessAt = this.env.now();
    if (epochAtStart === this.epoch) {
      const previous = this.data;
      this.data = result.data;
      this.onData?.(result.data, previous);
    } else {
      // A local change landed while this request was running: its data may be
      // older than that change. Keep the local view and refetch straight away.
      this.queuedRefresh = true;
    }
    if (this.data !== null && this.isFinal?.(this.data)) {
      // Nothing more can change: stop for good.
      this.complete = true;
      this.queuedRefresh = false;
      this.clear('pollTimer');
      this.clear('staleTimer');
      this.emit();
      return;
    }
    this.armStaleTimer();
    this.emit();
    this.afterAttempt();
  }

  private afterAttempt(): void {
    if (this.queuedRefresh) {
      this.queuedRefresh = false;
      this.poll();
      return;
    }
    this.schedule();
  }

  private schedule(): void {
    this.clear('pollTimer');
    if (!this.started || this.halted) return;
    this.pollTimer = this.env.setTimeout(() => {
      this.pollTimer = null;
      this.poll();
    }, this.nextDelay());
  }

  private nextDelay(): number {
    let delay: number;
    if (!this.env.isOnline()) {
      delay = this.offlineRetryMs;
    } else {
      const base = this.env.isVisible() ? this.intervalMs : this.hiddenIntervalMs;
      delay =
        this.failures > 0
          ? Math.min(this.maxBackoffMs, base * 2 ** this.failures)
          : base;
    }
    const spread = (this.env.random() * 2 - 1) * this.jitter;
    return Math.max(0, Math.round(delay * (1 + spread)));
  }

  private handleVisibilityChange(): void {
    if (!this.started || this.halted) return;
    // Re-derive the state against the clock first: a tab that resumes after a
    // long freeze must show "stale" at once, not "live" until the refetch lands.
    this.emit();
    if (this.env.isVisible()) {
      const age =
        this.lastSuccessAt === null
          ? Infinity
          : this.env.now() - this.lastSuccessAt;
      if (age >= MIN_VISIBLE_REFRESH_GAP_MS) {
        this.refreshNow();
        return;
      }
    }
    // Hidden (slower cadence) or visible with fresh data: just re-time.
    if (!this.inFlight) this.schedule();
  }

  private handleOnlineChange(): void {
    if (!this.started || this.halted) return;
    this.emit();
    if (this.env.isOnline()) {
      this.refreshNow();
    } else if (!this.inFlight) {
      this.schedule();
    }
  }

  private armStaleTimer(): void {
    this.clear('staleTimer');
    this.staleTimer = this.env.setTimeout(() => {
      this.staleTimer = null;
      this.emit();
    }, this.staleAfterMs);
  }

  private clear(
    which: 'pollTimer' | 'requestTimer' | 'staleTimer',
  ): void {
    const handle = this[which];
    if (handle !== null) {
      this.env.clearTimeout(handle);
      this[which] = null;
    }
  }

  private buildSnapshot(): PollingSnapshot<T> {
    const connection = deriveConnection({
      now: this.env.now(),
      online: this.env.isOnline(),
      forbidden: this.forbidden,
      notFound: this.notFound,
      complete: this.complete,
      lastSuccessAt: this.lastSuccessAt,
      failures: this.failures,
      staleAfterMs: this.staleAfterMs,
    });
    return {
      data: this.data,
      connection,
      lastSuccessAt: this.lastSuccessAt,
      failures: this.failures,
      actionsAllowed: connection === 'live' || connection === 'degraded',
      refreshing: this.inFlight,
    };
  }

  // Replace the cached snapshot only when something observable changed, so
  // useSyncExternalStore does not re-render on a no-op.
  private emit(): void {
    const next = this.buildSnapshot();
    const previous = this.snapshot;
    if (
      next.data === previous.data &&
      next.connection === previous.connection &&
      next.lastSuccessAt === previous.lastSuccessAt &&
      next.failures === previous.failures &&
      next.refreshing === previous.refreshing
    ) {
      return;
    }
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }
}

// The real browser environment. Kept here, away from the controller logic,
// and only ever called from effects/event handlers in the browser.
export function browserPollingEnv(): PollingEnv {
  return {
    now: () => Date.now(),
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
    random: () => Math.random(),
    isVisible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
    // Treated as online unless the browser says otherwise (also true on the
    // server render, so the first paint matches between server and client).
    isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false,
    onVisibilityChange: (callback) => {
      document.addEventListener('visibilitychange', callback);
      return () => document.removeEventListener('visibilitychange', callback);
    },
    onOnlineChange: (callback) => {
      window.addEventListener('online', callback);
      window.addEventListener('offline', callback);
      return () => {
        window.removeEventListener('online', callback);
        window.removeEventListener('offline', callback);
      };
    },
  };
}
