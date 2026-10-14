import {
  SoundAlertController,
  decideAlert,
  type AudioContextLike,
  type SoundEnv,
} from './sound-alert';

// A fake Web Audio context that counts the chimes it is asked to play.
class FakeContext implements AudioContextLike {
  state = 'suspended';
  currentTime = 0;
  destination = {};
  allowStart = true;
  oscillators = 0;
  failOnCreate = false;
  resume = jest.fn(async () => {
    if (this.allowStart) this.state = 'running';
  });
  createGain = () => ({
    gain: { setValueAtTime: jest.fn(), linearRampToValueAtTime: jest.fn() },
    connect: jest.fn(),
  });
  createOscillator = () => {
    if (this.failOnCreate) throw new Error('audio broke');
    this.oscillators += 1;
    return {
      type: 'sine',
      frequency: { setValueAtTime: jest.fn(), linearRampToValueAtTime: jest.fn() },
      connect: jest.fn(),
      start: jest.fn(),
      stop: jest.fn(),
    };
  };
}

function makeEnv(
  options: { supported?: boolean; preference?: boolean } = {},
): { env: SoundEnv; context: FakeContext; stored: { value: boolean }; created: () => number } {
  const context = new FakeContext();
  const stored = { value: options.preference ?? false };
  let created = 0;
  const env: SoundEnv = {
    isSupported: () => options.supported ?? true,
    createContext: () => {
      created += 1;
      return context;
    },
    readPreference: () => stored.value,
    writePreference: (enabled) => {
      stored.value = enabled;
    },
  };
  return { env, context, stored, created: () => created };
}

describe('decideAlert', () => {
  it('plays only when sound is on and there is at least one new arrival', () => {
    const none = new Set<string>();
    expect(decideAlert({ state: 'on', arrivalIds: ['a'], alertedIds: none }).play).toBe(true);
    expect(decideAlert({ state: 'on', arrivalIds: [], alertedIds: none }).play).toBe(false);
    for (const state of ['off', 'unsupported', 'needs-gesture'] as const) {
      expect(decideAlert({ state, arrivalIds: ['a'], alertedIds: none }).play).toBe(false);
    }
  });

  it('never counts an arrival that was already alerted', () => {
    const result = decideAlert({
      state: 'on',
      arrivalIds: ['a', 'b'],
      alertedIds: new Set(['a']),
    });
    expect(result).toEqual({ play: true, newIds: ['b'] });
    expect(
      decideAlert({ state: 'on', arrivalIds: ['a'], alertedIds: new Set(['a']) }).play,
    ).toBe(false);
  });
});

describe('SoundAlertController', () => {
  it('starts off, and never touches the audio system just by existing', () => {
    const { env, created } = makeEnv();
    const sound = new SoundAlertController(env);
    expect(sound.getSnapshot()).toBe('off');
    expect(created()).toBe(0);
  });

  it('reports unsupported browsers gracefully and ignores every call', async () => {
    const { env, created } = makeEnv({ supported: false });
    const sound = new SoundAlertController(env);
    expect(sound.getSnapshot()).toBe('unsupported');
    expect(await sound.enable()).toBe(false);
    expect(await sound.notifyArrivals(['a'])).toBe(false);
    sound.disable();
    expect(sound.getSnapshot()).toBe('unsupported');
    expect(created()).toBe(0);
  });

  it('treats a throwing support check as unsupported', () => {
    const { env } = makeEnv();
    const sound = new SoundAlertController({
      ...env,
      isSupported: () => {
        throw new Error('nope');
      },
    });
    expect(sound.getSnapshot()).toBe('unsupported');
  });

  it('enable() (a tap) turns sound on, plays one confirmation chime and remembers the choice', async () => {
    const { env, context, stored } = makeEnv();
    const sound = new SoundAlertController(env);
    expect(await sound.enable()).toBe(true);
    expect(sound.getSnapshot()).toBe('on');
    expect(context.oscillators).toBe(1);
    expect(stored.value).toBe(true);
  });

  it('asks for a tap when the browser refuses to start audio', async () => {
    const { env, context } = makeEnv();
    context.allowStart = false;
    const sound = new SoundAlertController(env);
    expect(await sound.enable()).toBe(false);
    expect(sound.getSnapshot()).toBe('needs-gesture');
    expect(context.oscillators).toBe(0);
  });

  it('plays one chime per batch of new arrivals and never twice for the same arrival', async () => {
    const { env, context } = makeEnv();
    const sound = new SoundAlertController(env);
    await sound.enable();
    const afterEnable = context.oscillators;

    expect(await sound.notifyArrivals(['a', 'b'])).toBe(true);
    expect(context.oscillators).toBe(afterEnable + 1);

    expect(await sound.notifyArrivals(['a', 'b'])).toBe(false);
    expect(await sound.notifyArrivals(['b'])).toBe(false);
    expect(context.oscillators).toBe(afterEnable + 1);

    expect(await sound.notifyArrivals(['b', 'c'])).toBe(true);
    expect(context.oscillators).toBe(afterEnable + 2);
  });

  it('plays nothing for an empty arrival list (the first-load backlog is never passed in)', async () => {
    const { env, context } = makeEnv();
    const sound = new SoundAlertController(env);
    await sound.enable();
    const before = context.oscillators;
    expect(await sound.notifyArrivals([])).toBe(false);
    expect(context.oscillators).toBe(before);
  });

  it('is silent while off, and does not replay old arrivals when sound is turned on later', async () => {
    const { env, context } = makeEnv();
    const sound = new SoundAlertController(env);
    expect(await sound.notifyArrivals(['a'])).toBe(false);
    expect(context.oscillators).toBe(0);

    await sound.enable();
    const afterEnable = context.oscillators;
    // 'a' arrived while sound was off: it must not sound now.
    expect(await sound.notifyArrivals(['a'])).toBe(false);
    expect(context.oscillators).toBe(afterEnable);
  });

  it('is silent again after disable() and forgets the preference', async () => {
    const { env, context, stored } = makeEnv();
    const sound = new SoundAlertController(env);
    await sound.enable();
    sound.disable();
    expect(sound.getSnapshot()).toBe('off');
    expect(stored.value).toBe(false);
    const before = context.oscillators;
    expect(await sound.notifyArrivals(['z'])).toBe(false);
    expect(context.oscillators).toBe(before);
  });

  describe('a saved preference', () => {
    it('starts as needs-gesture and does not play until the browser allows audio', async () => {
      const { env, context } = makeEnv({ preference: true });
      context.allowStart = false;
      const sound = new SoundAlertController(env);
      expect(sound.getSnapshot()).toBe('needs-gesture');
      await sound.prepare();
      expect(sound.getSnapshot()).toBe('needs-gesture');
      expect(await sound.notifyArrivals(['a'])).toBe(false);
      expect(context.oscillators).toBe(0);
    });

    it('returns to on by itself when the browser allows audio without a tap', async () => {
      const { env } = makeEnv({ preference: true });
      const sound = new SoundAlertController(env);
      await sound.prepare();
      expect(sound.getSnapshot()).toBe('on');
    });

    it('a tap then restores it', async () => {
      const { env, context } = makeEnv({ preference: true });
      context.allowStart = false;
      const sound = new SoundAlertController(env);
      await sound.prepare();
      context.allowStart = true;
      expect(await sound.enable()).toBe(true);
      expect(sound.getSnapshot()).toBe('on');
    });
  });

  it('falls back to needs-gesture, silently, if audio is suspended again and cannot restart', async () => {
    const { env, context } = makeEnv();
    const sound = new SoundAlertController(env);
    await sound.enable();
    context.state = 'suspended';
    context.allowStart = false;
    expect(await sound.notifyArrivals(['a'])).toBe(false);
    expect(sound.getSnapshot()).toBe('needs-gesture');
  });

  it('degrades to needs-gesture, never throws, if playing a chime fails', async () => {
    const { env, context } = makeEnv();
    const sound = new SoundAlertController(env);
    await sound.enable();
    context.failOnCreate = true;
    await expect(sound.notifyArrivals(['a'])).resolves.toBe(false);
    expect(sound.getSnapshot()).toBe('needs-gesture');
  });

  it('notifies subscribers only when the state actually changes', async () => {
    const { env } = makeEnv();
    const sound = new SoundAlertController(env);
    const listener = jest.fn();
    sound.subscribe(listener);
    await sound.enable();
    expect(listener).toHaveBeenCalledTimes(1);
    await sound.enable();
    expect(listener).toHaveBeenCalledTimes(1);
    sound.disable();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('keeps working if storing the preference fails', async () => {
    const { env } = makeEnv();
    const sound = new SoundAlertController({
      ...env,
      writePreference: () => {
        throw new Error('storage blocked');
      },
    });
    await expect(sound.enable()).resolves.toBe(true);
    expect(sound.getSnapshot()).toBe('on');
    expect(() => sound.disable()).not.toThrow();
    expect(sound.getSnapshot()).toBe('off');
  });
});
