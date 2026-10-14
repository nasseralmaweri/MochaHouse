"use client";

import { useSyncExternalStore } from "react";
import type { SoundAlertController } from "@/lib/admin/sound-alert";
import { Button } from "@/components/admin/Button";

// The explicit sound control for the staff queue. Sound is off until someone
// taps here (browsers require a tap before they will play audio), the choice is
// remembered on this device only, and the visual alerts work the same with
// sound off.
export function SoundToggle({
  controller,
}: {
  controller: SoundAlertController;
}) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  if (state === "unsupported") {
    return (
      <span className="text-xs text-text-muted">
        Sound alerts aren&apos;t available on this device. New orders are still
        highlighted.
      </span>
    );
  }

  if (state === "on") {
    return (
      <Button
        variant="secondary"
        aria-pressed={true}
        onClick={() => controller.disable()}
      >
        Sound on
      </Button>
    );
  }

  if (state === "needs-gesture") {
    return (
      <span className="flex flex-col items-end gap-1">
        <Button onClick={() => void controller.enable()}>
          Tap to turn sound on
        </Button>
        <span className="max-w-56 text-right text-xs text-text-muted">
          Sound was on, but this browser needs a tap before it will play.
        </span>
      </span>
    );
  }

  return (
    <Button
      variant="secondary"
      aria-pressed={false}
      onClick={() => void controller.enable()}
    >
      Enable sound
    </Button>
  );
}
