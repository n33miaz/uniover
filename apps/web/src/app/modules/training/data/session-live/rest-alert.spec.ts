import { TestBed } from '@angular/core/testing';
import { REST_VIBRATION, RestAlert } from './rest-alert';

function create(): RestAlert {
  TestBed.configureTestingModule({ providers: [RestAlert] });
  return TestBed.inject(RestAlert);
}

describe('RestAlert', () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>)['AudioContext'];
    delete (window as unknown as Record<string, unknown>)['webkitAudioContext'];
    delete (navigator as unknown as Record<string, unknown>)['vibrate'];
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

  it('never creates audio, even when the browser exposes both audio APIs', () => {
    const context = vi.fn();
    (window as unknown as Record<string, unknown>)['AudioContext'] = context;
    (window as unknown as Record<string, unknown>)['webkitAudioContext'] = context;

    create().fire();

    expect(context).not.toHaveBeenCalled();
  });
});
