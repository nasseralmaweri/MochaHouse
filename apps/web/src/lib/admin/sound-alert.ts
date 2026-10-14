// Optional audible new-order alert for the staff queue (R1 / S2b). Framework-
// free so the decisions can be tested without a browser. Nothing here is tied
// to a tenant or location: the preference belongs to the DEVICE (a tablet at
// the counter), stored locally and never sent anywhere.
//
// Browsers only allow audio after a user gesture, so sound is OFF until a
// person taps "Enable sound". A saved "on" preference survives a reload, but
// the browser may still refuse to start audio until the next tap; that state
// is reported as 'needs-gesture' and the visual alert simply carries on.

export type SoundState =
  // This browser has no usable audio; the visual alert still works.
  | 'unsupported'
  // Sound is switched off.
  | 'off'
  // Sound is switched on and the browser has allowed audio.
  | 'on'
  // Sound is switched on, but the browser needs a tap before it will play.
  | 'needs-gesture';

// The small slice of the Web Audio API this module uses, so a test can supply
// a fake. The real AudioContext satisfies it.
export interface AudioParamLike {
  setValueAtTime(value: number, time: number): unknown;
  linearRampToValueAtTime(value: number, time: number): unknown;
}
export interface OscillatorLike {
  type: string;
  frequency: AudioParamLike;
  connect(destination: unknown): unknown;
  start(time?: number): void;
  stop(time?: number): void;
}
export interface GainLike {
  gain: AudioParamLike;
  connect(destination: unknown): unknown;
}
export interface AudioContextLike {
  readonly state: string;
  readonly currentTime: number;
  readonly destination: unknown;
  resume(): Promise<void>;
  createOscillator(): OscillatorLike;
  createGain(): GainLike;
}

export interface SoundEnv {
  // Whether the browser has Web Audio at all. Checked without creating a
  // context, so merely opening the page never touches the audio system.
  isSupported(): boolean;
  // Created lazily, only when sound is actually being turned on or played.
  createContext(): AudioContextLike;
  readPreference(): boolean;
  writePreference(enabled: boolean): void;
}

// A bounded memory of arrivals already alerted, so one arrival never sounds
// twice (for example if the same list is delivered again).
const MAX_REMEMBERED_ARRIVALS = 500;

// Pure decision: should this batch of arrivals make a sound?
export function decideAlert(input: {
  state: SoundState;
  arrivalIds: readonly string[];
  alertedIds: ReadonlySet<string>;
}): { play: boolean; newIds: string[] } {
  const newIds = input.arrivalIds.filter((id) => !input.alertedIds.has(id));
  return { play: input.state === 'on' && newIds.length > 0, newIds };
}

export class SoundAlertController {
  private readonly env: SoundEnv;
  private readonly listeners = new Set<() => void>();
  private context: AudioContextLike | null = null;
  private alerted = new Set<string>();
  private state: SoundState;

  constructor(env: SoundEnv) {
    this.env = env;
    this.state = this.initialState();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): SoundState => this.state;

  private initialState(): SoundState {
    let supported = false;
    try {
      supported = this.env.isSupported();
    } catch {
      supported = false;
    }
    if (!supported) return 'unsupported';
    return this.env.readPreference() ? 'needs-gesture' : 'off';
  }

  private ensureContext(): AudioContextLike | null {
    if (this.context !== null) return this.context;
    try {
      this.context = this.env.createContext();
    } catch {
      this.context = null;
    }
    return this.context;
  }

  // Called once on mount: if the device had sound on, try to start audio
  // without a tap. Browsers that allow it go straight to 'on'; others stay at
  // 'needs-gesture' until the person taps.
  async prepare(): Promise<void> {
    if (this.state !== 'needs-gesture') return;
    if (await this.tryRunning()) this.set('on');
  }

  // MUST be called from a user gesture (a tap). Starts audio, plays a short
  // confirmation chime so the person knows it works, and remembers the choice.
  async enable(): Promise<boolean> {
    if (this.state === 'unsupported') return false;
    this.savePreference(true);
    if (await this.tryRunning()) {
      this.set('on');
      this.chime();
      return true;
    }
    this.set('needs-gesture');
    return false;
  }

  disable(): void {
    if (this.state === 'unsupported') return;
    this.savePreference(false);
    this.set('off');
  }

  // Sound for a batch of genuinely NEW arrivals (the caller never passes the
  // first-load backlog). At most one chime per batch, never for an arrival
  // already alerted, and never when sound is off or not allowed. Returns
  // whether a sound was played.
  async notifyArrivals(arrivalIds: readonly string[]): Promise<boolean> {
    const decision = decideAlert({
      state: this.state,
      arrivalIds,
      alertedIds: this.alerted,
    });
    // Remember every arrival, even silent ones, so turning sound on later does
    // not replay old arrivals.
    for (const id of decision.newIds) this.alerted.add(id);
    if (this.alerted.size > MAX_REMEMBERED_ARRIVALS) {
      this.alerted = new Set([...this.alerted].slice(-MAX_REMEMBERED_ARRIVALS));
    }
    if (!decision.play) return false;

    // Audio can be suspended again (a locked screen, a long idle). Try to wake
    // it; if the browser refuses, fall back to the visual alert alone.
    if (!(await this.tryRunning())) {
      this.set('needs-gesture');
      return false;
    }
    return this.chime();
  }

  // Remembering the choice is a convenience: if storage fails the sound still
  // works for this visit.
  private savePreference(enabled: boolean): void {
    try {
      this.env.writePreference(enabled);
    } catch {
      // not remembered
    }
  }

  private async tryRunning(): Promise<boolean> {
    const context = this.ensureContext();
    if (context === null) return false;
    try {
      if (context.state !== 'running') await context.resume();
    } catch {
      return false;
    }
    return context.state === 'running';
  }

  // A short, gentle two-note chime made with the Web Audio API (no audio file
  // to host). Any failure degrades to silence.
  private chime(): boolean {
    const context = this.context;
    if (context === null) return false;
    try {
      const now = context.currentTime;
      const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(0.25, now + 0.03);
      gain.gain.linearRampToValueAtTime(0.0001, now + 0.6);
      gain.connect(context.destination);

      const oscillator = context.createOscillator();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(880, now);
      oscillator.frequency.setValueAtTime(1175, now + 0.2);
      oscillator.connect(gain);
      oscillator.start(now);
      oscillator.stop(now + 0.65);
      return true;
    } catch {
      this.set('needs-gesture');
      return false;
    }
  }

  private set(next: SoundState): void {
    if (next === this.state) return;
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }
}

const PREFERENCE_KEY = 'centerivo.shop.orderSound';

function audioConstructor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext ??
    null
  );
}

// The real browser environment. Storage can throw (private mode, blocked
// cookies); then the preference simply is not remembered.
export function browserSoundEnv(): SoundEnv {
  return {
    isSupported: () => audioConstructor() !== null,
    createContext: () => {
      const Ctor = audioConstructor();
      if (Ctor === null) throw new Error('Web Audio is not available.');
      return new Ctor();
    },
    readPreference: () => {
      try {
        return window.localStorage.getItem(PREFERENCE_KEY) === '1';
      } catch {
        return false;
      }
    },
    writePreference: (enabled) => {
      try {
        window.localStorage.setItem(PREFERENCE_KEY, enabled ? '1' : '0');
      } catch {
        // Not remembered; the sound still works for this visit.
      }
    },
  };
}
