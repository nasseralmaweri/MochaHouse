'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import type {
  PollingController,
  PollingSnapshot,
} from './polling-controller';

// Thin React wrapper: one controller per mount (so a keyed remount, for
// example a location switch, starts from a clean slate), started on mount and
// stopped on unmount. All behaviour lives in PollingController.
export function usePollingController<T>(
  create: () => PollingController<T>,
): { controller: PollingController<T>; snapshot: PollingSnapshot<T> } {
  const [controller] = useState(create);

  useEffect(() => {
    controller.start();
    return () => controller.stop();
  }, [controller]);

  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  return { controller, snapshot };
}

// A coarse clock for relative labels ("3 min"). Deliberately slow: it only
// refreshes text, never data, and is not a live region.
export function useNow(tickMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = window.setInterval(() => setNow(Date.now()), tickMs);
    return () => window.clearInterval(handle);
  }, [tickMs]);
  return now;
}
