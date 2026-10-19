import { TestBed } from '@angular/core/testing';
import { REST_VIBRATION, RestAlert } from './rest-alert';

class FakeOscillator {
  frequency = { value: 0 };
  connected: unknown = null;
  started: number | null = null;
  stopped: number | null = null;

  connect(destination: unknown) {
    this.connected = destination;
  }

  start(when?: number) {
    this.started = when ?? 0;
  }

  stop(when?: number) {
    this.stopped = when ?? 0;
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  currentTime = 10;
  destination = { kind: 'destino' };
  resumeCalls = 0;
  oscillators: FakeOscillator[] = [];

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  async resume() {
    this.resumeCalls++;
  }

  createOscillator() {
    const oscillator = new FakeOscillator();
    this.oscillators.push(oscillator);
    return oscillator;
  }
}

function create(): RestAlert {
  TestBed.configureTestingModule({ providers: [RestAlert] });
  return TestBed.inject(RestAlert);
}

describe('RestAlert', () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>)['AudioContext'];
    delete (window as unknown as Record<string, unknown>)['webkitAudioContext'];
    delete (navigator as unknown as Record<string, unknown>)['vibrate'];
    FakeAudioContext.instances = [];
  });

  it('vibrates when the device can, with the toque-pausa-toque pattern', () => {
    const vibrate = vi.fn(() => true);
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: vibrate });

    create().fire();

    expect(vibrate).toHaveBeenCalledWith([...REST_VIBRATION]);
  });

  it('does not break without navigator.vibrate (iPhone) or when it throws', () => {
    expect(() => create().fire()).not.toThrow();

    TestBed.resetTestingModule();
    Object.defineProperty(navigator, 'vibrate', {
      configurable: true,
      value: () => {
        throw new Error('recusado');
      },
    });
    expect(() => create().fire()).not.toThrow();
  });

  it('does not beep before the audio was unlocked by a tap', () => {
    (window as unknown as Record<string, unknown>)['AudioContext'] = FakeAudioContext;
    const alert = create();

    alert.fire();

    expect(alert.unlocked).toBe(false);
    expect(FakeAudioContext.instances).toHaveLength(0);
  });

  it('beeps after unlock, using one context for every beep', () => {
    (window as unknown as Record<string, unknown>)['AudioContext'] = FakeAudioContext;
    const alert = create();

    alert.unlock();
    alert.unlock();
    alert.fire();
    alert.fire();

    expect(alert.unlocked).toBe(true);
    expect(FakeAudioContext.instances).toHaveLength(1);
    const [context] = FakeAudioContext.instances;
    expect(context.resumeCalls).toBe(2);
    expect(context.oscillators).toHaveLength(2);
    expect(context.oscillators[0]).toMatchObject({
      connected: context.destination,
      started: 10,
      stopped: 10.25,
    });
    expect(context.oscillators[0].frequency.value).toBe(880);
  });

  it('falls back to webkitAudioContext on the old Safari', () => {
    (window as unknown as Record<string, unknown>)['webkitAudioContext'] = FakeAudioContext;
    const alert = create();

    alert.unlock();

    expect(alert.unlocked).toBe(true);
    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  it('stays locked and silent without any audio API, and never throws', () => {
    const alert = create();

    expect(() => alert.unlock()).not.toThrow();
    expect(alert.unlocked).toBe(false);
    expect(() => alert.fire()).not.toThrow();
  });

  it('never throws when the browser refuses to build the context or to play', () => {
    (window as unknown as Record<string, unknown>)['AudioContext'] = class {
      constructor() {
        throw new Error('sem permissão');
      }
    };
    const refused = create();
    expect(() => refused.unlock()).not.toThrow();
    expect(refused.unlocked).toBe(false);

    TestBed.resetTestingModule();
    (window as unknown as Record<string, unknown>)['AudioContext'] = class extends (
      FakeAudioContext
    ) {
      override createOscillator(): FakeOscillator {
        throw new Error('recusado');
      }
    };
    const noSound = create();
    noSound.unlock();
    expect(() => noSound.fire()).not.toThrow();
  });
});
